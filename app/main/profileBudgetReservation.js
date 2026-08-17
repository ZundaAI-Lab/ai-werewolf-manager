/**
 * 責務: 同一AIプロファイルの並行要求が利用上限判定をすり抜けないよう、送信前の最大見積額をMainプロセス内で一時予約する。
 * 変更ルール: 使用量の永続化やAPI送信を行わず、料金計算・上限判定はllm/usageCostCalculator.jsを正本として利用する。予約は要求終了時に必ず解放し、保存済み実績額そのものは変更しない。
 */

'use strict';

const { ProviderRequestError } = require('./providerClients.js');
const { estimateMaximumRequestCostUsd, profileBudgetStatus } = require('./llm/usageCostCalculator.js');

function createProfileBudgetReservationManager({ getProfileUsage }) {
  if (typeof getProfileUsage !== 'function') throw new TypeError('getProfileUsage関数が必要です。');
  const reservedCostByProfileId = new Map();

  function reservedCostFor(profileId) {
    return reservedCostByProfileId.get(String(profileId ?? '')) ?? 0;
  }

  function reserve(profile, promptEnvelope) {
    if (Number(profile?.billing?.profileBudgetUsd ?? 0) <= 0) return () => {};
    const profileId = String(profile?.id ?? '');
    const currentUsage = getProfileUsage(profileId);
    const estimatedMaximumCostUsd = estimateMaximumRequestCostUsd(profile, promptEnvelope);
    const spentIncludingReserved = Number(currentUsage?.costUsd ?? 0) + reservedCostFor(profileId);
    const budget = profileBudgetStatus(profile, spentIncludingReserved, estimatedMaximumCostUsd);
    if (budget.wouldExceed) {
      const limit = budget.limitUsd.toFixed(6);
      const spent = budget.spentUsd.toFixed(6);
      const message = budget.reached
        ? `AIプロファイル「${profile.label}」は利用上限 $${limit} に到達しています（確定済み・予約済み使用額 $${spent}）。料金・上限でこのプロファイルの使用量をリセットするか上限を変更してください。`
        : `AIプロファイル「${profile.label}」は次回要求の最大見積 $${budget.estimatedNextCostUsd.toFixed(6)} を含めると利用上限 $${limit} を超えるため、API送信を停止しました（確定済み・予約済み使用額 $${spent}）。`;
      throw new ProviderRequestError(message, {
        provider: profile.provider,
        code: 'PROFILE_BUDGET_EXCEEDED',
        retryable: false,
        deliveryUnknown: false,
      });
    }

    reservedCostByProfileId.set(profileId, reservedCostFor(profileId) + estimatedMaximumCostUsd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = reservedCostFor(profileId) - estimatedMaximumCostUsd;
      if (next > 1e-12) reservedCostByProfileId.set(profileId, next);
      else reservedCostByProfileId.delete(profileId);
    };
  }

  return Object.freeze({ reserve });
}

module.exports = { createProfileBudgetReservationManager };
