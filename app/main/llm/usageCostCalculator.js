/**
 * 責務: AIプロファイルに保存されたUSD建てトークン単価から実績料金と次回要求の保守的な最大見積額を計算し、プロファイル利用上限の到達判定を行う。
 * 変更ルール: 使用量の永続化、API送信、自動実行停止、画面描画を行わない。単価変更は過去実績へ遡及せず、呼び出し時点のプロファイル単価だけでその要求の料金を確定する。上限事前判定は実請求を下回りにくいよう入力推定へ安全係数を掛け、キャッシュ状態が未知の入力には設定単価の最大値を使用する。
 */

'use strict';

const { estimateTextTokens } = require('./conversationBudget.js');

const TOKENS_PER_MILLION = 1_000_000;
const BUDGET_ESTIMATE_SAFETY_FACTOR = 1.25;
const BUDGET_ESTIMATE_FIXED_OVERHEAD_TOKENS = 128;
const USD_ROUND_SCALE = 1_000_000_000_000;
const BUDGET_EPSILON_USD = 1 / USD_ROUND_SCALE;

function finiteNonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function roundUsd(value) {
  return Math.round(finiteNonNegative(value) * USD_ROUND_SCALE) / USD_ROUND_SCALE;
}

function billingRates(profile) {
  const billing = profile?.billing ?? {};
  return {
    inputUsdPerMillion: finiteNonNegative(billing.inputUsdPerMillion),
    cachedInputUsdPerMillion: finiteNonNegative(billing.cachedInputUsdPerMillion),
    cacheWriteUsdPerMillion: finiteNonNegative(billing.cacheWriteUsdPerMillion),
    outputUsdPerMillion: finiteNonNegative(billing.outputUsdPerMillion),
    profileBudgetUsd: finiteNonNegative(billing.profileBudgetUsd),
  };
}

function billableUsageTokens(profile, usage) {
  const provider = String(profile?.provider ?? '');
  const inputTokens = finiteNonNegative(usage?.inputTokens);
  const cachedInputTokens = finiteNonNegative(usage?.cachedInputTokens);
  const cacheWriteTokens = finiteNonNegative(usage?.cacheWriteTokens);
  const outputTokens = finiteNonNegative(usage?.outputTokens);
  const reasoningTokens = finiteNonNegative(usage?.reasoningTokens);
  if (provider === 'demo') {
    return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  }
  return {
    // Anthropic usage.input_tokens はcache_read/cache_creationと別枠。他Providerはcachedがprompt/inputの内数として返る契約を使用する。
    inputTokens: provider === 'anthropic' ? inputTokens : Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    cacheWriteTokens,
    // GeminiのthoughtsTokenCountはcandidatesTokenCountとは別枠なので出力単価へ合算する。他Providerのreasoningはoutput内数として扱う。
    outputTokens: provider === 'gemini' ? outputTokens + reasoningTokens : outputTokens,
  };
}

function calculateUsageCostBreakdown(profile, usage) {
  const rates = billingRates(profile);
  const tokens = billableUsageTokens(profile, usage);
  const inputUsd = roundUsd(tokens.inputTokens * rates.inputUsdPerMillion / TOKENS_PER_MILLION);
  const cachedInputUsd = roundUsd(tokens.cachedInputTokens * rates.cachedInputUsdPerMillion / TOKENS_PER_MILLION);
  const cacheWriteUsd = roundUsd(tokens.cacheWriteTokens * rates.cacheWriteUsdPerMillion / TOKENS_PER_MILLION);
  const outputUsd = roundUsd(tokens.outputTokens * rates.outputUsdPerMillion / TOKENS_PER_MILLION);
  return {
    ...tokens,
    inputUsd,
    cachedInputUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: roundUsd(inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd),
  };
}

function calculateUsageCostUsd(profile, usage) {
  return calculateUsageCostBreakdown(profile, usage).totalUsd;
}

function estimatePromptEnvelopeTokens(promptEnvelope) {
  const structuredOutput = promptEnvelope?.structuredOutput ? JSON.stringify(promptEnvelope.structuredOutput) : '';
  const source = [
    promptEnvelope?.commonSystemInstruction,
    promptEnvelope?.commonGameContext,
    promptEnvelope?.taskInvariantContext,
    promptEnvelope?.stablePlayerContext,
    promptEnvelope?.taskVariableContext,
    promptEnvelope?.dynamicTaskPrompt,
    structuredOutput,
  ];
  const estimated = source.reduce((total, value) => total + (String(value ?? '') ? estimateTextTokens(value) : 0), 0);
  return Math.ceil(estimated * BUDGET_ESTIMATE_SAFETY_FACTOR) + BUDGET_ESTIMATE_FIXED_OVERHEAD_TOKENS;
}

function estimateMaximumRequestCostUsd(profile, promptEnvelope) {
  if (String(profile?.provider ?? '') === 'demo') return 0;
  const rates = billingRates(profile);
  const inputRate = Math.max(rates.inputUsdPerMillion, rates.cachedInputUsdPerMillion, rates.cacheWriteUsdPerMillion);
  const estimatedInputTokens = estimatePromptEnvelopeTokens(promptEnvelope);
  const maximumOutputTokens = finiteNonNegative(profile?.maxOutputTokens);
  return roundUsd(
    estimatedInputTokens * inputRate / TOKENS_PER_MILLION
    + maximumOutputTokens * rates.outputUsdPerMillion / TOKENS_PER_MILLION,
  );
}

function profileBudgetStatus(profile, spentUsd, estimatedNextCostUsd = 0) {
  const limitUsd = billingRates(profile).profileBudgetUsd;
  const normalizedSpentUsd = roundUsd(spentUsd);
  const normalizedEstimatedNextCostUsd = roundUsd(estimatedNextCostUsd);
  const enabled = limitUsd > 0;
  const remainingUsd = enabled ? roundUsd(Math.max(0, limitUsd - normalizedSpentUsd)) : null;
  const reached = enabled && normalizedSpentUsd + BUDGET_EPSILON_USD >= limitUsd;
  const wouldExceed = enabled && (
    reached
    || normalizedSpentUsd + normalizedEstimatedNextCostUsd > limitUsd + BUDGET_EPSILON_USD
  );
  return {
    enabled,
    limitUsd,
    spentUsd: normalizedSpentUsd,
    remainingUsd,
    estimatedNextCostUsd: normalizedEstimatedNextCostUsd,
    reached,
    wouldExceed,
  };
}

module.exports = {
  BUDGET_ESTIMATE_FIXED_OVERHEAD_TOKENS,
  BUDGET_ESTIMATE_SAFETY_FACTOR,
  TOKENS_PER_MILLION,
  billingRates,
  billableUsageTokens,
  calculateUsageCostBreakdown,
  calculateUsageCostUsd,
  estimateMaximumRequestCostUsd,
  estimatePromptEnvelopeTokens,
  profileBudgetStatus,
  roundUsd,
};
