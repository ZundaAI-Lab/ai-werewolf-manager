/**
 * 責務: Gemini generateContent APIへ固定接頭辞を先頭にした構造化Envelopeを送信し、暗黙キャッシュへ適合させる。
 * 変更ルール: Gemini以外の分岐を追加せず、明示cachedContentのライフサイクルを持たない。systemInstructionにはProvider共通system契約だけを置き、Envelopeの全区画は定義順を維持した単一user入力として送る。キャッシュ可否を権限昇格の根拠にせず、固定情報より後ろへ最新タスクを配置する。
 */

'use strict';

const {
  normalizeEndpoint,
  normalizeMaxOutputTokens,
  normalizeModel,
  systemInstructionForRequest,
  trimTrailingSlash,
} = require('../providerProfilePolicy.js');
const { resolveStructuredOutputMode } = require('../modelStructuredOutputPolicy.js');
const { requestJson } = require('../providerHttpClient.js');
const { outputTextFromGemini, usageFromBody } = require('../providerResponseParser.js');
const { flattenPromptEnvelope } = require('../promptEnvelopeValidator.js');

async function generateGemini(profile, promptEnvelope, apiKey, signal, requestPurpose = 'normal') {
  const systemInstruction = systemInstructionForRequest(requestPurpose, promptEnvelope.commonSystemInstruction);
  const base = trimTrailingSlash(normalizeEndpoint(profile));
  const model = encodeURIComponent(normalizeModel(profile));
  const stableSystem = systemInstruction;
  const userText = flattenPromptEnvelope(promptEnvelope);
  const structuredOutputMode = resolveStructuredOutputMode(profile, promptEnvelope);
  const generationConfig = {
    maxOutputTokens: normalizeMaxOutputTokens(profile),
  };
  if (structuredOutputMode === 'json-schema') {
    generationConfig.responseFormat = {
      text: {
        mimeType: 'application/json',
        schema: promptEnvelope.structuredOutput.schema,
      },
    };
  } else {
    generationConfig.responseMimeType = 'application/json';
  }
  const body = await requestJson({
    provider: 'gemini',
    url: `${base}/models/${model}:generateContent`,
    headers: { 'x-goog-api-key': apiKey },
    signal,
    body: {
      systemInstruction: { parts: [{ text: stableSystem }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig,
    },
  });
  return {
    text: outputTextFromGemini(body),
    usage: usageFromBody('gemini', body),
    requestId: body.responseId ?? null,
    providerDiagnostics: { structuredOutputMode },
  };
}

module.exports = { generateGemini };
