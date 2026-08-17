/**
 * 責務: Providerを選択し、Main境界で検証済みの単発プロンプトEnvelopeを各Adapterへ渡して共通AI応答へ正規化する。
 * 変更ルール: 過去user／assistant会話を受け取らず、各API固有のキャッシュ形式を再実装しない。ゲーム状態の意味解釈はRendererへ委譲する。
 */

'use strict';

const { generate: generateDemoResponse } = require('../../shared/demoAi.js');
const { ProviderRequestError } = require('./providerConstants.js');
const { normalizeProviderText } = require('./providerResponseParser.js');
const { requiresApiKey, systemInstructionForRequest } = require('./providerProfilePolicy.js');
const { validateLocalPromptBudget } = require('./promptBudget.js');
const { flattenPromptEnvelope, normalizePromptEnvelope } = require('./promptEnvelopeValidator.js');
const { generateOllamaChat, isOllamaProfile, ollamaGenerationBudgetTokens } = require('./providers/ollamaProvider.js');
const { generateOpenAi } = require('./providers/openAiProvider.js');
const { generateAnthropic } = require('./providers/anthropicProvider.js');
const { generateGemini } = require('./providers/geminiProvider.js');
const { generateChatCompletion } = require('./providers/chatCompletionsProvider.js');

async function generateWithProvider({ profile, promptEnvelope, apiKey = '', taskType = '', playerName = '', requestPurpose = 'normal', signal }) {
  const provider = profile?.provider ?? 'demo';
  const normalizedEnvelope = normalizePromptEnvelope(promptEnvelope);
  const envelope = normalizedEnvelope;
  const persistentSystemInstruction = envelope.commonSystemInstruction;
  const systemInstruction = systemInstructionForRequest(requestPurpose, persistentSystemInstruction);
  if (isOllamaProfile(profile)) {
    validateLocalPromptBudget(profile, envelope, systemInstruction, ollamaGenerationBudgetTokens(profile));
  } else {
    validateLocalPromptBudget(profile, envelope, systemInstruction);
  }

  if (provider === 'demo') {
    const prompt = flattenPromptEnvelope(envelope);
    return {
      text: generateDemoResponse({ prompt, taskType, playerName, requestPurpose }),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      requestId: `demo-${Date.now()}`,
      normalization: { jsonObjectExtracted: false },
      providerDiagnostics: {},
    };
  }
  if (requiresApiKey(profile) && !apiKey) {
    throw new ProviderRequestError(`${profile?.label || provider}のAPIキーが未設定です。`, {
      provider,
      code: 'API_KEY_MISSING',
    });
  }
  let result;
  if (provider === 'openai') result = await generateOpenAi(profile, envelope, apiKey, signal, requestPurpose);
  else if (provider === 'anthropic') result = await generateAnthropic(profile, envelope, apiKey, signal, requestPurpose);
  else if (provider === 'gemini') result = await generateGemini(profile, envelope, apiKey, signal, requestPurpose);
  else if (isOllamaProfile(profile)) result = await generateOllamaChat(profile, envelope, apiKey, signal, requestPurpose);
  else result = await generateChatCompletion(profile, envelope, apiKey, signal, requestPurpose);
  const normalized = normalizeProviderText(profile, result.text);
  if (!normalized.text) {
    throw new ProviderRequestError(`${provider}から空の応答が返されました。`, {
      provider,
      code: 'EMPTY_PROVIDER_RESPONSE',
    });
  }
  return {
    ...result,
    text: normalized.text,
    normalization: { jsonObjectExtracted: normalized.jsonObjectExtracted },
    providerDiagnostics: { ...(result.providerDiagnostics ?? {}) },
  };
}

module.exports = { generateWithProvider };
