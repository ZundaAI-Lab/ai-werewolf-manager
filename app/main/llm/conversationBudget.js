/**
 * 責務: 会話履歴を完全なuser／assistant往復に正規化し、件数とコンテキスト予算内へ収める。
 * 変更ルール: 片側だけの履歴を送信せず、上限0では過去メッセージを一切返さない。
 */

'use strict';

const { OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS } = require('./providerConstants.js');
const {
  boundedInteger, configurationError, isLocalProvider, normalizeContextWindowTokens, normalizeMaxConversationMessages, normalizeMaxOutputTokens,
} = require('./providerProfilePolicy.js');

function estimateTextTokens(value) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of String(value ?? '')) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

function normalizeConversationMessages(messages, maxMessages = 120) {
  if (!Array.isArray(messages) || maxMessages <= 0) return [];
  const bounded = Math.min(120, Math.max(2, Math.trunc(Number(maxMessages) || 0)));
  const pairLimit = Math.floor(bounded / 2);
  const normalized = messages.flatMap((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : null;
    const content = String(message?.content ?? '');
    return role && content ? [{ role, content }] : [];
  });
  const pairs = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const userMessage = normalized[index];
    const assistantMessage = normalized[index + 1];
    if (userMessage.role !== 'user' || assistantMessage.role !== 'assistant') continue;
    pairs.push([userMessage, assistantMessage]);
    index += 1;
  }
  return pairs.slice(-pairLimit).flat();
}

function prepareConversationMessages(profile, prompt, messages, systemInstruction = '', generationBudgetTokens = normalizeMaxOutputTokens(profile)) {
  const provider = profile?.provider ?? 'demo';
  const maxMessages = normalizeMaxConversationMessages(profile);
  if (!isLocalProvider(provider)) return normalizeConversationMessages(messages, maxMessages);

  const contextWindowTokens = normalizeContextWindowTokens(profile);
  const maxOutputTokens = boundedInteger(generationBudgetTokens, normalizeMaxOutputTokens(profile), 256, 65536);
  const promptTokens = estimateTextTokens(prompt) + estimateTextTokens(systemInstruction);
  const fixedOverheadTokens = OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS;
  const inputBudget = contextWindowTokens - maxOutputTokens - fixedOverheadTokens;
  if (inputBudget <= 0) {
    throw configurationError(provider, `コンテキスト長は最大出力トークンより${fixedOverheadTokens}以上大きい値にしてください。`, 'CONTEXT_CONFIGURATION_ERROR');
  }
  if (promptTokens > inputBudget) {
    throw configurationError(provider, `今回のプロンプト推定${promptTokens}トークンが入力予算${inputBudget}トークンを超えています。コンテキスト長を増やすか公開履歴を差分送信へ変更してください。`, 'PROMPT_CONTEXT_EXCEEDED');
  }

  const source = normalizeConversationMessages(messages, maxMessages);
  let remaining = inputBudget - promptTokens;
  const selectedPairs = [];
  for (let index = source.length - 2; index >= 0; index -= 2) {
    const pair = [source[index], source[index + 1]];
    const cost = pair.reduce((total, message) => total + estimateTextTokens(message.content) + 8, 0);
    if (cost > remaining) break;
    selectedPairs.unshift(pair);
    remaining -= cost;
  }
  return selectedPairs.flat();
}


module.exports = { estimateTextTokens, normalizeConversationMessages, prepareConversationMessages };
