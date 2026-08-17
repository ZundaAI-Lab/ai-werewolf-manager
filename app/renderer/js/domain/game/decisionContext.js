/**
 * 責務: AI本人に可視な情報だけから、生存人数・必要票数・処刑／襲撃分岐・公開主張の整合性・襲撃候補ごとの公開主張上の注意事実・前回判断後の公開差分を計算する。
 * 変更ルール: 実配役やGM専用情報を直接参照しない。投票専用のpopulationBranchesはvote時だけ生成し、speechや夜行動など非voteタスクへ判断材料として流さない。本人が人狼で生存人狼数と仲間を確定把握している場合は、有効候補と本人可視のknownWolfIdsをvotePopulationAnalysis.jsへ渡し、秘密情報と矛盾する仮定分岐を作らない。襲撃候補の注意事実は本人が既知の人狼IDと公開済み能力結果だけから算出し、対象優先度や禁止判定へ変換しない。文章生成と状態更新を行わず、純粋な構造化データだけを返す。白狼の占い判定分岐は、公開配役に占いで非人狼となる人狼が存在する場合だけ有効化する。
 */

import { getStrictMajorityCount, evaluateWolfPopulation } from './standardRules.js';
import { countConfiguredRole, countConfiguredWolves, countConfiguredWolvesByMediumResult, countConfiguredWolvesBySeerResult } from '../roles/roleAttributes.js';
import { buildRunoffAnalysis } from '../vote/voteAnalysis.js';
import { buildVotePopulationBranches } from '../vote/votePopulationAnalysis.js';

function configuredWolfCount(context) {
  return countConfiguredWolves(context.game.roleComposition);
}

function aliveIdSet(context) {
  return new Set(context.board.alive.map((player) => player.id));
}

function knownAliveWolfIds(context) {
  const alive = aliveIdSet(context);
  return (context.player.knowledge.knownWolfIds ?? []).filter((id) => alive.has(id));
}

function uniqueIds(ids) {
  return [...new Set(ids)];
}

function possibleCandidateIds(allPlayers, actorId, claimedRole, excludedIds) {
  const excluded = new Set(excludedIds);
  return allPlayers
    .map((player) => player.id)
    .filter((id) => id !== actorId || claimedRole !== 'seer')
    .filter((id) => !excluded.has(id));
}

function buildPublicClaimConsistency(context, actorId) {
  const actorClaims = context.board.publicAbilityClaims.filter((claim) => claim.actorId === actorId);
  const claimedNotWolfIds = [];
  const claimedWolfIds = [];
  actorClaims.forEach((claim) => {
    const kind = claim.result;
    if (kind === 'not-wolf') claimedNotWolfIds.push(claim.targetId);
    if (kind === 'wolf') claimedWolfIds.push(claim.targetId);
  });
  const uniqueClaimedNotWolfIds = uniqueIds(claimedNotWolfIds);
  const uniqueClaimedWolfIds = uniqueIds(claimedWolfIds);
  const claimedRole = context.board.claims.find((claim) => claim.actorId === actorId && claim.status === 'active')?.roleId ?? null;
  const allPlayers = [...context.board.alive, ...context.board.dead];
  const requiredWolfCount = configuredWolfCount(context);
  const seerVisibleWolfCount = countConfiguredWolvesBySeerResult(context.game.roleComposition, 'wolf');
  const mediumVisibleWolfCount = countConfiguredWolvesByMediumResult(context.game.roleComposition, 'wolf');
  const configuredWhiteWolfCount = countConfiguredRole(context.game.roleComposition, 'whiteWolf');
  const seerWhiteWolfRuleActive = claimedRole === 'seer' && configuredWhiteWolfCount > 0;
  const seerHiddenWolfCount = seerWhiteWolfRuleActive ? configuredWhiteWolfCount : 0;
  const remainingPossibleNormalWolfCandidateIds = seerWhiteWolfRuleActive
    ? possibleCandidateIds(allPlayers, actorId, claimedRole, uniqueClaimedNotWolfIds)
    : [];
  const remainingPossibleWhiteWolfCandidateIds = seerWhiteWolfRuleActive
    ? possibleCandidateIds(allPlayers, actorId, claimedRole, uniqueClaimedWolfIds)
    : [];
  const remainingPossibleWolfCandidateIds = seerWhiteWolfRuleActive
    ? uniqueIds([
      ...remainingPossibleNormalWolfCandidateIds,
      ...remainingPossibleWhiteWolfCandidateIds,
    ])
    : possibleCandidateIds(allPlayers, actorId, claimedRole, uniqueClaimedNotWolfIds);
  const aliveIdSetValue = new Set(context.board.alive.map((player) => player.id));
  const remainingAliveWolfCandidateIds = remainingPossibleWolfCandidateIds.filter((id) => aliveIdSetValue.has(id));
  const remainingAliveNormalWolfCandidateIds = remainingPossibleNormalWolfCandidateIds.filter((id) => aliveIdSetValue.has(id));
  const remainingAliveWhiteWolfCandidateIds = remainingPossibleWhiteWolfCandidateIds.filter((id) => aliveIdSetValue.has(id));
  const contradictionWarnings = [];
  const notWolfSet = new Set(uniqueClaimedNotWolfIds);
  if (uniqueClaimedWolfIds.some((id) => notWolfSet.has(id))) {
    contradictionWarnings.push('同じ人物へ人狼結果と非人狼結果の両方を公開しています。');
  }
  if (claimedRole === 'seer') {
    const blackResultLimit = seerWhiteWolfRuleActive ? seerVisibleWolfCount : requiredWolfCount;
    if (uniqueClaimedWolfIds.length > blackResultLimit) {
      contradictionWarnings.push(seerWhiteWolfRuleActive
        ? '公開済み人狼結果が、占いで人狼判定になり得る通常人狼数を超えています。'
        : '公開済み人狼結果が、配役上の人狼数を超えています。');
    }
    if (seerWhiteWolfRuleActive) {
      const enoughNormalWolfCandidates = remainingPossibleNormalWolfCandidateIds.length >= seerVisibleWolfCount;
      const enoughWhiteWolfCandidates = remainingPossibleWhiteWolfCandidateIds.length >= seerHiddenWolfCount;
      const enoughDistinctWolfCandidates = remainingPossibleWolfCandidateIds.length >= requiredWolfCount;
      if (!enoughNormalWolfCandidates || !enoughWhiteWolfCandidates || !enoughDistinctWolfCandidates) {
        contradictionWarnings.push('公開済み占い結果を同時に成立させるために、通常人狼と白狼を別人として配置できる候補数が不足しています。');
      }
    } else if (remainingPossibleWolfCandidateIds.length < requiredWolfCount) {
      contradictionWarnings.push('公開済み結果を同時に成立させるために必要な人狼候補数が不足しています。');
    }
  }
  if (claimedRole === 'medium') {
    if (uniqueClaimedWolfIds.length > mediumVisibleWolfCount) {
      contradictionWarnings.push('公開済み人狼結果が、霊能で人狼判定になり得る人数を超えています。');
    }
    if (remainingPossibleWolfCandidateIds.length < requiredWolfCount) {
      contradictionWarnings.push('公開済み霊能結果を同時に成立させるために必要な人狼候補数が不足しています。');
    }
  }
  return {
    actorId,
    claimedRoleId: claimedRole,
    claimedNotWolfIds: uniqueClaimedNotWolfIds,
    claimedWolfIds: uniqueClaimedWolfIds,
    remainingPossibleWolfCandidateIds,
    remainingAliveWolfCandidateIds,
    requiredWolfCount,
    seerWhiteWolfRuleActive,
    seerVisibleWolfCount: seerWhiteWolfRuleActive ? seerVisibleWolfCount : null,
    seerHiddenWolfCount: seerWhiteWolfRuleActive ? seerHiddenWolfCount : null,
    mediumVisibleWolfCount: claimedRole === 'medium' ? mediumVisibleWolfCount : null,
    remainingPossibleNormalWolfCandidateIds,
    remainingAliveNormalWolfCandidateIds,
    remainingPossibleWhiteWolfCandidateIds,
    remainingAliveWhiteWolfCandidateIds,
    contradictionWarnings,
  };
}

function buildOwnPublicClaimConsistency(context) {
  return buildPublicClaimConsistency(context, context.player.id);
}

function buildOtherPublicClaimContradictions(context) {
  return uniqueIds(context.board.publicAbilityClaims.map((claim) => claim.actorId))
    .filter((actorId) => actorId !== context.player.id)
    .map((actorId) => buildPublicClaimConsistency(context, actorId))
    .filter((consistency) => consistency.contradictionWarnings.length > 0)
    .map((consistency) => ({
      actorId: consistency.actorId,
      claimedRoleId: consistency.claimedRoleId,
      contradictionWarnings: [...consistency.contradictionWarnings],
    }));
}

function buildAttackCandidatePublicClaimFacts(context, targetId) {
  const knownWolfIds = new Set(context.player.knowledge.knownWolfIds ?? []);
  const publicAbilityClaims = context.board.publicAbilityClaims ?? [];
  return {
    alliedWolfResultClaimActorIds: uniqueIds(publicAbilityClaims
      .filter((claim) => (
        claim.result === 'wolf'
        && claim.targetId === targetId
        && knownWolfIds.has(claim.actorId)
      ))
      .map((claim) => claim.actorId)),
    targetWolfResultClaimedKnownWolfIds: uniqueIds(publicAbilityClaims
      .filter((claim) => (
        claim.result === 'wolf'
        && claim.actorId === targetId
        && knownWolfIds.has(claim.targetId)
      ))
      .map((claim) => claim.targetId)),
  };
}

function buildAttackContext(context, knownAliveWolves) {
  const aliveCount = context.board.alive.length;
  const successAliveCount = Math.max(0, aliveCount - 1);
  const failureAliveCount = aliveCount;
  const successNonWolves = knownAliveWolves === null ? null : successAliveCount - knownAliveWolves;
  const failureNonWolves = knownAliveWolves === null ? null : failureAliveCount - knownAliveWolves;
  return {
    successAliveCount,
    successMajorityThreshold: getStrictMajorityCount(successAliveCount),
    failureAliveCount,
    failureMajorityThreshold: getStrictMajorityCount(failureAliveCount),
    successWolfOutcome: knownAliveWolves === null ? null : evaluateWolfPopulation(knownAliveWolves, successNonWolves),
    failureWolfOutcome: knownAliveWolves === null ? null : evaluateWolfPopulation(knownAliveWolves, failureNonWolves),
    candidateBranches: context.task.validTargetIds.map((targetId) => ({
      targetId,
      claimedRoleId: context.board.claims.find((claim) => claim.actorId === targetId && claim.status === 'active')?.roleId ?? null,
      ...buildAttackCandidatePublicClaimFacts(context, targetId),
      successAliveCount,
      successMajorityThreshold: getStrictMajorityCount(successAliveCount),
      failureAliveCount,
      failureMajorityThreshold: getStrictMajorityCount(failureAliveCount),
    })),
  };
}


function uniqueEventsById(events) {
  const byId = new Map();
  (events ?? []).forEach((event) => {
    if (!event?.id) return;
    byId.set(event.id, event);
  });
  return [...byId.values()]
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
}

function buildDecisionDelta(context, historyCursorSequence = null) {
  const previous = context.player.decisionState ?? {};
  const sourceEventId = previous.sourceEventId ?? null;
  const explicitCursor = Number.isInteger(historyCursorSequence) && historyCursorSequence >= 0
    ? historyCursorSequence
    : null;
  if (explicitCursor === null && !sourceEventId) {
    return { hasPreviousDecision: false, sourceEventId: null, sourceSequence: null, newPublicEvents: [] };
  }

  const publicEvents = uniqueEventsById([
    ...(context.board.publicTimeline?.speeches ?? []),
    ...(context.board.publicTimeline?.voteResults ?? []),
    ...(context.board.publicTimeline?.executions ?? []),
    ...(context.board.publicTimeline?.dawns ?? []),
    ...(context.board.publicTimeline?.corrections ?? []),
    ...(context.board.publicTimeline?.gameResults ?? []),
    ...(context.board.publicTimeline?.other ?? []),
  ]);
  const visibleSourceEvents = [
    ...publicEvents,
    ...(context.ownHistory?.votes ?? []),
  ];
  const sourceEvent = visibleSourceEvents.find((event) => event.id === sourceEventId) ?? null;
  const sourceSequence = explicitCursor ?? (sourceEvent ? Number(sourceEvent.sequence ?? 0) : null);
  return {
    hasPreviousDecision: context.player.decisionInvalidation?.usablePreviousDecision !== false,
    sourceEventId,
    sourceSequence,
    newPublicEvents: sourceSequence === null
      ? []
      : publicEvents.filter((event) => Number(event.sequence ?? 0) > sourceSequence),
  };
}

export function buildDecisionContext(visibleContext, taskType = visibleContext.task.type, { historyCursorSequence = null } = {}) {
  const aliveCount = visibleContext.board.alive.length;
  const knownWolves = knownAliveWolfIds(visibleContext);
  const exactKnownAliveWolfCount = visibleContext.player.strategyProfile === 'wolf' ? knownWolves.length : null;
  const configuredWolves = configuredWolfCount(visibleContext);
  return {
    population: {
      aliveCount,
      majorityThreshold: getStrictMajorityCount(aliveCount),
      tieVoteCount: Math.floor(aliveCount / 2),
      configuredWolfCount: configuredWolves,
      knownAliveWolfCount: exactKnownAliveWolfCount,
    },
    vote: {
      executionRule: 'plurality',
      pluralityCanExecuteBelowMajority: true,
      round: visibleContext.game.vote?.round ?? null,
      runoffLimit: visibleContext.game.rules.vote.runoffLimit,
      tieResolution: visibleContext.game.rules.vote.tieResolution,
      populationBranches: taskType === 'vote'
        ? buildVotePopulationBranches({
          aliveCount,
          configuredWolfCount: configuredWolves,
          exactKnownAliveWolfCount,
          candidateIds: visibleContext.task.validTargetIds,
          knownWolfIds: knownWolves,
        })
        : [],
    },
    runoff: taskType === 'vote' ? buildRunoffAnalysis(visibleContext) : null,
    attack: (
      taskType === 'wolf-attack'
      || (taskType === 'wolf-conversation' && visibleContext.task.wolfAttackRequired)
    )
      ? buildAttackContext(visibleContext, exactKnownAliveWolfCount)
      : null,
    ownPublicClaimConsistency: buildOwnPublicClaimConsistency(visibleContext),
    otherPublicClaimContradictions: buildOtherPublicClaimContradictions(visibleContext),
    discussionReconsideration: visibleContext.game.discussion?.reconsideration ?? { pending: false, reasons: [], affectedPlayerIds: [] },
    decisionDelta: buildDecisionDelta(visibleContext, historyCursorSequence),
  };
}
