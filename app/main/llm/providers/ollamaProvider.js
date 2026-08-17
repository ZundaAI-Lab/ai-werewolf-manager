/**
 * 責務: Ollamaネイティブchat APIへ単発Envelopeを送り、Thinking段階、生成予算、同一要求内の継続生成、決定済み構造化出力方式のOllama形式変換を実装する。
 * 変更ルール: Ollama以外のプロバイダー分岐を追加せず、ゲーム固有Schemaを生成・変更せず、過去タスクのAPI会話を送らない。system roleにはProvider共通system契約だけを置き、Envelopeの全区画は定義順を維持した単一user入力として送る。キャッシュ可否を権限昇格の根拠にしない。同一要求内のThinking継続だけを許可し、Thinking本文を戻り値へ含めない。
 */

'use strict';

const {
  OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS, OLLAMA_NATIVE_THINKING_RESERVE_TOKENS,
  LOCAL_OPENAI_PROVIDER, OLLAMA_THINKING_CONTINUATION_LIMIT, ProviderRequestError,
} = require('../providerConstants.js');
const {
  bearerAuthorizationHeaders, configurationError, isLocalProvider, normalizeContextWindowTokens, normalizeEndpoint, normalizeMaxOutputTokens,
  normalizeModel, normalizeThinkingLevel, systemInstructionForRequest,
} = require('../providerProfilePolicy.js');
const { estimateTextTokens } = require('../promptBudget.js');
const { resolveStructuredOutputMode } = require('../modelStructuredOutputPolicy.js');
const { flattenPromptEnvelope } = require('../promptEnvelopeValidator.js');
const { requestJson } = require('../providerHttpClient.js');
const { finiteTokenCount } = require('../providerResponseParser.js');

function isOllamaProfile(profile) {
  return isLocalProvider(profile) && profile?.localServerPreset === 'ollama';
}

function ollamaNativeChatEndpoint(profile) {
  const url = new URL(normalizeEndpoint(profile));
  const path = url.pathname.replace(/\/+$/u, '');
  if (/\/api\/chat$/u.test(path)) {
    url.pathname = path;
  } else if (/\/v1\/chat\/completions$/u.test(path)) {
    url.pathname = path.replace(/\/v1\/chat\/completions$/u, '/api/chat');
  } else if (/\/chat\/completions$/u.test(path)) {
    url.pathname = path.replace(/\/chat\/completions$/u, '/api/chat');
  } else {
    url.pathname = `${path}/api/chat`.replace(/\/+/gu, '/');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function ollamaThinkValue(profile) {
  const level = normalizeThinkingLevel(profile);
  return level === 'none' ? false : level;
}

function ollamaThinkingReserveTokens(profile) {
  const level = normalizeThinkingLevel(profile);
  const requestedReserve = OLLAMA_NATIVE_THINKING_RESERVE_TOKENS[level] ?? 0;
  if (requestedReserve <= 0) return 0;
  const contextWindowTokens = normalizeContextWindowTokens(profile);
  const finalAnswerTokens = normalizeMaxOutputTokens(profile);
  const contextReserveLimit = Math.max(0, contextWindowTokens - finalAnswerTokens - 512);
  const requestLimit = Math.max(0, 65536 - finalAnswerTokens);
  return Math.min(requestedReserve, contextReserveLimit, requestLimit);
}

function ollamaGenerationBudgetTokens(profile) {
  return normalizeMaxOutputTokens(profile) + ollamaThinkingReserveTokens(profile);
}

function estimateOllamaMessagesTokens(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => (
    total
    + estimateTextTokens(message?.content ?? '')
    + (message?.thinking ? estimateTextTokens(message.thinking) : 0)
    + 8
  ), 0);
}

function ollamaNumPredictForMessages(profile, messages, desiredTokens = ollamaGenerationBudgetTokens(profile)) {
  const contextWindowTokens = normalizeContextWindowTokens(profile);
  const inputTokens = estimateOllamaMessagesTokens(messages);
  const availableTokens = contextWindowTokens - inputTokens - OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS;
  if (availableTokens < 256) {
    throw configurationError(
      profile?.provider ?? LOCAL_OPENAI_PROVIDER,
      'Thinking継続に必要なコンテキスト余裕がありません。モデルのコンテキスト上限を増やすか、公開履歴をcompactまたはdeltaへ変更してください。',
      'OLLAMA_THINKING_CONTEXT_EXHAUSTED',
    );
  }
  return Math.min(65536, Math.max(256, Math.min(desiredTokens, availableTokens)));
}

function usageFromOllamaBody(body) {
  const inputTokens = finiteTokenCount(body?.prompt_eval_count);
  const outputTokens = finiteTokenCount(body?.eval_count);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function addUsageTotals(target, usage) {
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
    target[key] += finiteTokenCount(usage?.[key]);
  }
  return target;
}

function ollamaFinalizationInstruction() {
  return '直前のassistantメッセージには、この同じ要求について既に生成したThinkingが含まれています。その推論を引き継ぎ、分析を最初からやり直さず、元のsystem・user指示で要求された最終JSONオブジェクトだけを完成させてください。内部Thinkingは現在の設定のまま利用し、可視本文には推論過程・説明文・コードフェンスを混ぜないでください。';
}

async function generateOllamaChat(profile, promptEnvelope, apiKey, signal, requestPurpose = 'normal') {
  const provider = profile?.provider ?? LOCAL_OPENAI_PROVIDER;
  const systemInstruction = systemInstructionForRequest(requestPurpose, promptEnvelope.commonSystemInstruction);
  const generationBudgetTokens = ollamaGenerationBudgetTokens(profile);
  const systemContent = systemInstruction;
  const userContent = flattenPromptEnvelope(promptEnvelope);
  let messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  let continuationCount = 0;
  let lastBody = null;
  const structuredOutputMode = resolveStructuredOutputMode(profile, promptEnvelope);

  while (true) {
    const requestBody = {
      model: normalizeModel(profile),
      messages,
      stream: false,
      think: ollamaThinkValue(profile),
      options: {
        num_ctx: normalizeContextWindowTokens(profile),
        num_predict: ollamaNumPredictForMessages(profile, messages, generationBudgetTokens),
      },
    };
    if (structuredOutputMode === 'json-schema') requestBody.format = promptEnvelope.structuredOutput.schema;
    else if (structuredOutputMode === 'json-object') requestBody.format = 'json';

    lastBody = await requestJson({
      provider,
      url: ollamaNativeChatEndpoint(profile),
      headers: bearerAuthorizationHeaders(profile, apiKey),
      signal,
      body: requestBody,
    });
    addUsageTotals(usage, usageFromOllamaBody(lastBody));

    const content = typeof lastBody?.message?.content === 'string' ? lastBody.message.content : '';
    const thinking = typeof lastBody?.message?.thinking === 'string' ? lastBody.message.thinking : '';
    if (content.trim()) {
      return {
        text: content,
        usage,
        requestId: lastBody?.created_at ?? null,
        providerDiagnostics: {
          doneReason: String(lastBody?.done_reason ?? ''),
          thinkingGenerated: Boolean(thinking.trim()),
          continuationCount,
          generationBudgetTokens,
          finalNumPredict: requestBody.options.num_predict,
          structuredOutputMode,
        },
      };
    }

    if (!thinking.trim() || normalizeThinkingLevel(profile) === 'none') break;
    if (continuationCount >= OLLAMA_THINKING_CONTINUATION_LIMIT) {
      throw new ProviderRequestError('OllamaがThinkingを生成しましたが、継続生成後も最終回答へ移行しませんでした。Thinking設定は維持されています。最大出力トークンまたはコンテキスト上限を増やしてください。', {
        provider,
        code: 'OLLAMA_THINKING_FINAL_RESPONSE_MISSING',
        retryable: false,
      });
    }

    messages = [
      ...messages,
      { role: 'assistant', thinking, content: '' },
      { role: 'user', content: ollamaFinalizationInstruction() },
    ];
    continuationCount += 1;
  }

  throw new ProviderRequestError(`${provider}から空の応答が返されました。`, {
    provider,
    code: 'EMPTY_PROVIDER_RESPONSE',
    responseBody: lastBody ? JSON.stringify({
      done_reason: lastBody.done_reason ?? null,
      eval_count: lastBody.eval_count ?? null,
      prompt_eval_count: lastBody.prompt_eval_count ?? null,
      thinking_present: Boolean(String(lastBody?.message?.thinking ?? '').trim()),
    }) : '',
  });
}


module.exports = {
  generateOllamaChat, isOllamaProfile, ollamaGenerationBudgetTokens, ollamaNativeChatEndpoint,
  ollamaNumPredictForMessages, ollamaThinkValue, ollamaThinkingReserveTokens, usageFromOllamaBody,
};
