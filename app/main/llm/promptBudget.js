/**
 * 責務: プロンプト全体の推定トークン数を計算し、ローカルLLMの入力・出力コンテキスト余裕を検証する。
 * 変更ルール: Rendererで確定した現在状態・公開履歴・応答契約をMain側で削減しない。過去user／assistant会話の正規化は行わない。
 */

'use strict';

const { OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS } = require('./providerConstants.js');
const {
  configurationError,
  isLocalProvider,
  normalizeContextWindowTokens,
  normalizeMaxOutputTokens,
} = require('./providerProfilePolicy.js');
const { flattenPromptEnvelope } = require('./promptEnvelopeValidator.js');

function estimateTextTokens(value) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of String(value ?? '')) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

function validateLocalPromptBudget(profile, envelope, systemInstruction = '', generationBudgetTokens = normalizeMaxOutputTokens(profile)) {
  if (!isLocalProvider(profile)) return;
  const contextWindowTokens = normalizeContextWindowTokens(profile);
  const inputTokens = estimateTextTokens(flattenPromptEnvelope(envelope)) + estimateTextTokens(systemInstruction);
  const inputBudget = contextWindowTokens - Math.max(256, Number(generationBudgetTokens ?? 0)) - OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS;
  if (inputBudget <= 0) {
    throw configurationError(profile?.provider, `コンテキスト長は最大出力トークンより${OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS}以上大きい値にしてください。`, 'CONTEXT_CONFIGURATION_ERROR');
  }
  if (inputTokens > inputBudget) {
    throw configurationError(profile?.provider, `今回のプロンプト推定${inputTokens}トークンが入力予算${inputBudget}トークンを超えています。コンテキスト長を増やすか、公開履歴をcompactまたはdeltaへ変更してください。`, 'PROMPT_CONTEXT_EXCEEDED');
  }
}

module.exports = {
  estimateTextTokens,
  validateLocalPromptBudget,
};
