/**
 * 責務: AI判断状態で使用可能な疑い候補・処刑価値候補・投票予定対象を現在盤面から導出し、永続化されたAI回答を変更せず利用時だけ現在盤面向けへ射影する。
 * 変更ルール: 永続判断状態を書き換えない。候補可否、候補依存文章の表示失効、日跨ぎ失効情報は本モジュールへ集約する。日跨ぎでは疑い候補を維持し、処刑価値候補・投票予定・当日比較情報だけを失効させ、対象消滅とは区別する。文章生成・応答解析・公開履歴生成は行わない。
 */

import { getAlivePlayers, getVoteCandidates } from './standardRules.js';

function uniqueIds(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value))];
}

function sameIds(left, right) {
  return JSON.stringify([...uniqueIds(left)].sort()) === JSON.stringify([...uniqueIds(right)].sort());
}

export function buildDecisionTargetPolicy(
  state,
  playerId,
  {
    taskType = 'speech',
    candidateIds = null,
  } = {},
) {
  const aliveIds = getAlivePlayers(state).map((player) => player.id);
  const voteCandidateIds = taskType === 'vote' && Array.isArray(candidateIds)
    ? candidateIds
    : null;
  const executionCandidateIds = getVoteCandidates(state, playerId, voteCandidateIds)
    .map((player) => player.id);

  return {
    suspicionCandidateIds: aliveIds.filter((candidateId) => candidateId !== playerId),
    executionCandidateIds,
    intendedVoteCandidateIds: [...executionCandidateIds],
    abstentionAllowed: taskType === 'vote' && Boolean(state.game?.rules?.vote?.abstentionAllowed),
  };
}

export function projectDecisionStateForPolicy(decisionState, policy, {
  resetDailyComparisons = false,
} = {}) {
  const source = decisionState ?? {};
  const sourceSuspicionIds = uniqueIds(source.suspicionCandidateIds);
  const sourceExecutionIds = uniqueIds(source.executionCandidateIds);
  const suspicionAllowed = new Set(policy?.suspicionCandidateIds ?? []);
  const executionAllowed = new Set(policy?.executionCandidateIds ?? []);
  const intendedAllowed = new Set(policy?.intendedVoteCandidateIds ?? []);
  const suspicionCandidateIds = sourceSuspicionIds.filter((candidateId) => suspicionAllowed.has(candidateId));
  const availableExecutionCandidateIds = sourceExecutionIds.filter((candidateId) => executionAllowed.has(candidateId));
  const executionCandidateIds = resetDailyComparisons ? [] : availableExecutionCandidateIds;
  const intendedVoteId = resetDailyComparisons
    ? null
    : source.intendedVoteId === 'abstain' && policy?.abstentionAllowed
      ? 'abstain'
      : intendedAllowed.has(source.intendedVoteId)
        ? source.intendedVoteId
        : null;
  const suspicionChanged = !sameIds(sourceSuspicionIds, suspicionCandidateIds);
  const executionTargetUnavailable = !sameIds(sourceExecutionIds, availableExecutionCandidateIds);
  const intendedChanged = (source.intendedVoteId ?? null) !== intendedVoteId;
  const intendedTargetUnavailable = !resetDailyComparisons && intendedChanged;
  const targetContextChanged = suspicionChanged || executionTargetUnavailable || intendedTargetUnavailable;
  const comparisonContextInvalid = targetContextChanged || resetDailyComparisons;
  const removedSuspicionCandidateIds = sourceSuspicionIds.filter((id) => !suspicionCandidateIds.includes(id));
  const removedExecutionCandidateIds = sourceExecutionIds.filter((id) => !availableExecutionCandidateIds.includes(id));
  const removedTargetIds = uniqueIds([
    ...removedSuspicionCandidateIds,
    ...removedExecutionCandidateIds,
    intendedTargetUnavailable && source.intendedVoteId !== 'abstain' ? source.intendedVoteId : null,
  ]);
  const invalidatedSemanticFields = targetContextChanged
    ? [
      'assessmentLevel',
      'keyPublicEvidenceEventIds',
      'leaveAliveBenefit',
      'misexecutionCost',
      'selectionDifference',
      'uncertainty',
      'nextDiscriminatingInformation',
      'decisionReason',
    ]
    : resetDailyComparisons
      ? ['executionCandidateIds', 'intendedVoteId', 'leaveAliveBenefit', 'misexecutionCost', 'selectionDifference', 'decisionReason']
      : [];
  const hasStoredDecision = Boolean(source.updatedAt);
  const usablePreviousDecision = hasStoredDecision && !targetContextChanged;

  return {
    state: {
      ...source,
      suspicionCandidateIds,
      executionCandidateIds,
      intendedVoteId,
      assessmentLevel: targetContextChanged ? 'unresolved' : String(source.assessmentLevel ?? 'unresolved'),
      keyPublicEvidenceEventIds: targetContextChanged ? [] : uniqueIds(source.keyPublicEvidenceEventIds),
      leaveAliveBenefit: comparisonContextInvalid ? '' : String(source.leaveAliveBenefit ?? ''),
      misexecutionCost: comparisonContextInvalid ? '' : String(source.misexecutionCost ?? ''),
      selectionDifference: comparisonContextInvalid ? '' : String(source.selectionDifference ?? ''),
      uncertainty: targetContextChanged ? '' : String(source.uncertainty ?? ''),
      nextDiscriminatingInformation: targetContextChanged || resetDailyComparisons
        ? ''
        : String(source.nextDiscriminatingInformation ?? ''),
    },
    displayDecisionReason: comparisonContextInvalid ? '' : String(source.decisionReason ?? ''),
    invalidation: {
      targetContextChanged,
      dailyComparisonReset: Boolean(resetDailyComparisons),
      removedSuspicionCandidateIds,
      removedExecutionCandidateIds,
      removedTargetIds,
      remainingCandidateIds: uniqueIds([...suspicionCandidateIds, ...executionCandidateIds]),
      intendedVoteInvalidated: intendedChanged,
      invalidatedSemanticFields,
      invalidationReason: targetContextChanged
        ? 'target-unavailable'
        : resetDailyComparisons
          ? 'daily-comparison-reset'
          : null,
      usablePreviousDecision,
      requiresReevaluation: targetContextChanged || Boolean(resetDailyComparisons),
    },
  };
}

export function getCurrentDecisionProjection(
  state,
  playerId,
  {
    taskType = 'speech',
    candidateIds = null,
  } = {},
) {
  const player = state.players.find((item) => item.id === playerId) ?? null;
  const policy = buildDecisionTargetPolicy(state, playerId, { taskType, candidateIds });
  const sourceDay = player?.decisionState?.sourceDay;
  const resetDailyComparisons = sourceDay !== null
    && sourceDay !== undefined
    && Number(sourceDay) < Number(state.game?.day ?? 0);
  return projectDecisionStateForPolicy(player?.decisionState, policy, { resetDailyComparisons });
}
