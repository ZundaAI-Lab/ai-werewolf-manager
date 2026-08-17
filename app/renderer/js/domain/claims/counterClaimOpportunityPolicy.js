/**
 * 責務: 公開済みCO・能力結果だけから、人狼陣営の未CO本人へ一度だけ提示する固定的な対抗CO候補を純粋に導出する。
 * 変更ルール: 状態を変更せず文章も生成しない。信用差・勝率・発言本文・GM内部役職を解析せず、Day 1の公開CO・公開能力結果と本人の既知陣営だけを使用する。白狼は潜伏戦術を優先するため対象外とする。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

const DIRECT_ELIGIBLE_ROLE_IDS = new Set(['wolf', 'madman', 'snowWoman']);

function getPlayer(state, playerId) {
  return state?.players?.find((player) => player.id === playerId) ?? null;
}

function isAlive(state, playerId) {
  return Boolean(getPlayer(state, playerId)?.alive);
}

function activeClaims(state, roleId) {
  return (state?.claims ?? []).filter((claim) => (
    claim.status === 'active'
    && claim.roleId === roleId
    && isAlive(state, claim.actorId)
  ));
}

function activeClaimForPlayer(state, playerId) {
  return (state?.claims ?? []).find((claim) => claim.status === 'active' && claim.actorId === playerId) ?? null;
}

function eventSequence(state, eventId) {
  return Number((state?.events ?? []).find((event) => event.id === eventId)?.sequence ?? -1);
}

function latestRelevantSequence(state, sourceEventIds) {
  return Math.max(
    ...sourceEventIds.map((eventId) => eventSequence(state, eventId)).filter(Number.isFinite),
    -1,
  );
}

function isNewOpportunity(state, sourceEventIds, sinceSequence) {
  if (!Number.isInteger(sinceSequence)) return true;
  return latestRelevantSequence(state, sourceEventIds) > sinceSequence;
}

function isEligibleActor(state, player) {
  if (!player?.alive || player.roleId === 'whiteWolf') return false;
  if (DIRECT_ELIGIBLE_ROLE_IDS.has(player.roleId)) return true;
  return player.roleId === 'zashikiWarashi'
    && state?.playerKnowledge?.[player.id]?.resolvedTeam === 'wolf';
}

function playerName(state, playerId) {
  return getPlayer(state, playerId)?.name ?? playerId;
}

function buildOpportunity(type, targetRoleId, sourceEventIds, details) {
  return Object.freeze({
    type,
    targetRoleId,
    sourceEventIds: Object.freeze([...new Set(sourceEventIds.filter(Boolean))]),
    ...details,
  });
}

export function resolveCounterClaimOpportunity(state, {
  playerId,
  taskType,
  sinceSequence = null,
} = {}) {
  const player = getPlayer(state, playerId);
  if (!(isNormalSpeechTask(taskType) || taskType === 'priority-answer') || Number(state?.game?.day ?? 0) !== 1) return null;
  if (!isEligibleActor(state, player) || activeClaimForPlayer(state, playerId)) return null;

  const seerClaims = activeClaims(state, 'seer');
  const mediumClaims = activeClaims(state, 'medium');

  if (mediumClaims.length === 1) {
    const mediumClaim = mediumClaims[0];
    const conflictingWolfResult = (state?.publicAbilityClaims ?? []).find((claim) => (
      claim.status !== 'voided'
      && claim.claimedRoleId === 'seer'
      && claim.result === 'wolf'
      && claim.targetId === mediumClaim.actorId
      && seerClaims.some((seerClaim) => seerClaim.actorId === claim.actorId)
    ));
    if (conflictingWolfResult) {
      const sourceEventIds = [mediumClaim.sourceEventId, conflictingWolfResult.sourceEventId];
      if (isNewOpportunity(state, sourceEventIds, sinceSequence)) {
        return buildOpportunity('medium-counter-black-conflict', 'medium', sourceEventIds, {
          soleClaimantId: mediumClaim.actorId,
          soleClaimantName: playerName(state, mediumClaim.actorId),
          resultClaimantId: conflictingWolfResult.actorId,
          resultClaimantName: playerName(state, conflictingWolfResult.actorId),
        });
      }
    }
  }

  if (seerClaims.length === 1) {
    const claim = seerClaims[0];
    const sourceEventIds = [claim.sourceEventId];
    if (isNewOpportunity(state, sourceEventIds, sinceSequence)) {
      return buildOpportunity('single-seer-counter', 'seer', sourceEventIds, {
        soleClaimantId: claim.actorId,
        soleClaimantName: playerName(state, claim.actorId),
      });
    }
  }

  if (mediumClaims.length === 1) {
    const claim = mediumClaims[0];
    const sourceEventIds = [claim.sourceEventId];
    if (isNewOpportunity(state, sourceEventIds, sinceSequence)) {
      return buildOpportunity('single-medium-counter', 'medium', sourceEventIds, {
        soleClaimantId: claim.actorId,
        soleClaimantName: playerName(state, claim.actorId),
      });
    }
  }

  return null;
}
