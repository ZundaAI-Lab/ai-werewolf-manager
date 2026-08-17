/**
 * 責務: 村人陣営の家主が本人へ通知済みの役職をCOし同役職対抗がいる事実から、座敷わらしCOによる追認候補を純粋に導出する。
 * 変更ルール: 状態を変更せず文章も生成しない。信用差・処刑危険・襲撃危険を推定せず、playerKnowledgeの家主情報と公開COだけを使用する。家主のGM内部役職へフォールバックしない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

import { getRoleDefinition } from '../roles/roleAttributes.js';


function getPlayer(state, playerId) {
  return state?.players?.find((player) => player.id === playerId) ?? null;
}

function activeClaimForPlayer(state, playerId) {
  return (state?.claims ?? []).find((claim) => claim.status === 'active' && claim.actorId === playerId) ?? null;
}

function activeClaims(state, roleId) {
  return (state?.claims ?? []).filter((claim) => (
    claim.status === 'active'
    && claim.roleId === roleId
    && getPlayer(state, claim.actorId)?.alive
  ));
}

function eventSequence(state, eventId) {
  return Number((state?.events ?? []).find((event) => event.id === eventId)?.sequence ?? -1);
}

function latestRelevantSequence(state, claims) {
  return Math.max(
    ...claims.map((claim) => eventSequence(state, claim.sourceEventId)).filter(Number.isFinite),
    -1,
  );
}

export function resolveOwnerClaimCorroborationOpportunity(state, {
  playerId,
  taskType,
  sinceSequence = null,
} = {}) {
  const player = getPlayer(state, playerId);
  if (!(isNormalSpeechTask(taskType) || taskType === 'priority-answer') || player?.roleId !== 'zashikiWarashi' || !player.alive) return null;
  const knowledge = state?.playerKnowledge?.[playerId] ?? null;
  if (knowledge?.resolvedTeam !== 'village' || activeClaimForPlayer(state, playerId)) return null;

  const ownerId = knowledge?.knownOwnerId ?? null;
  const ownerRole = getRoleDefinition(knowledge?.knownOwnerRoleId ?? null);
  const owner = getPlayer(state, ownerId);
  if (!owner?.alive || !ownerRole || ownerRole.baseTeam !== 'village' || ownerRole.id === 'villager') return null;

  const ownerClaim = activeClaimForPlayer(state, owner.id);
  if (ownerClaim?.roleId !== ownerRole.id) return null;

  const sameRoleClaims = activeClaims(state, ownerRole.id);
  if (sameRoleClaims.length < 2) return null;
  if (Number.isInteger(sinceSequence) && latestRelevantSequence(state, sameRoleClaims) <= sinceSequence) return null;

  return Object.freeze({
    type: 'owner-role-corroboration',
    ownerId: owner.id,
    ownerName: owner.name,
    ownerRoleId: ownerRole.id,
    ownerRoleName: ownerRole.name,
    counterClaimantIds: Object.freeze(sameRoleClaims.filter((claim) => claim.actorId !== owner.id).map((claim) => claim.actorId)),
    sourceEventIds: Object.freeze(sameRoleClaims.map((claim) => claim.sourceEventId).filter(Boolean)),
  });
}
