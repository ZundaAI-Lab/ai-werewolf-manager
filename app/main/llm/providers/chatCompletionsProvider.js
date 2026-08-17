/**
 * 責務: OpenAI互換Chat Completions APIへ単発の構造化Envelopeを送信し、決定済み構造化出力方式をresponse_formatへ変換する。
 * 変更ルール: API会話履歴やプロバイダー固有キャッシュ項目を送らず、ゲーム固有Schemaを生成・変更しない。system roleにはProvider共通system契約だけを置き、Envelopeの全区画は定義順を維持した単一user入力として送る。キャッシュ可否を権限昇格の根拠にしない。認証方式はプロファイル規則、json-object／json-schemaの能力判断はmodelStructuredOutputPolicy.jsへ委譲する。
 */

'use strict';

const {
  bearerAuthorizationHeaders,
  normalizeChatTokenLimitField,
  normalizeEndpoint,
  normalizeMaxOutputTokens,
  normalizeModel,
  systemInstructionForRequest,
} = require('../providerProfilePolicy.js');
const { resolveStructuredOutputMode } = require('../modelStructuredOutputPolicy.js');
const { requestJson } = require('../providerHttpClient.js');
const { outputTextFromChatCompletions, usageFromBody } = require('../providerResponseParser.js');
const { flattenPromptEnvelope } = require('../promptEnvelopeValidator.js');

async function generateChatCompletion(profile, promptEnvelope, apiKey, signal, requestPurpose = 'normal') {
  const provider = profile.provider ?? 'openai-compatible';
  const systemInstruction = systemInstructionForRequest(requestPurpose, promptEnvelope.commonSystemInstruction);
  const tokenLimitField = normalizeChatTokenLimitField(profile);
  const systemContent = systemInstruction;
  const userContent = flattenPromptEnvelope(promptEnvelope);
  const requestBody = {
    model: normalizeModel(profile),
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    stream: false,
    [tokenLimitField]: normalizeMaxOutputTokens(profile),
  };
  const structuredOutputMode = resolveStructuredOutputMode(profile, promptEnvelope);
  if (structuredOutputMode === 'json-schema') {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: promptEnvelope.structuredOutput.name,
        strict: true,
        schema: promptEnvelope.structuredOutput.schema,
      },
    };
  } else if (structuredOutputMode === 'json-object') {
    requestBody.response_format = { type: 'json_object' };
  }
  const body = await requestJson({
    provider,
    url: normalizeEndpoint(profile),
    headers: bearerAuthorizationHeaders(profile, apiKey),
    signal,
    body: requestBody,
  });
  return {
    text: outputTextFromChatCompletions(body),
    usage: usageFromBody(provider, body),
    requestId: body.id ?? null,
    providerDiagnostics: { structuredOutputMode },
  };
}

module.exports = { generateChatCompletion };
