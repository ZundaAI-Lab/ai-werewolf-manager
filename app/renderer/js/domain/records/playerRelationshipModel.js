/**
 * 責務: 公開CO・公開能力結果・公開投票と参加者別判断状態から、リアルタイム表示および日終了スナップショット用のプレイヤー相関モデルを決定的に構築・射影・保存する。
 * 変更ルール: 公開発言本文を自然言語解析しない。リアルタイム疑いは生存者同士だけへ射影し、日終了保存では当日死亡者に接続する最終疑いだけを保持して前日以前の死亡者との疑いを除去する。疑い対象と疑い線は公開議論上の対立関係に近い相関図の基礎情報として機密表示OFFでも保持し、真役職と内部確信度である疑い強度・判断更新日は機密表示時だけ射影する。この境界を役職等の秘密情報と同一視して疑い線まで隠さない。スナップショットは同じDayを一件だけ保持し、訂正後の再進行時は同Dayを置換する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { createId, nowIso } from '../../shared/utils.js';
import { DECISION_ASSESSMENT_LEVELS } from '../game/decisionState.js';
import { getCurrentDecisionProjection } from '../game/decisionTargetPolicy.js';
import { publicAbilityResultLabel } from '../policies/publicAbilityClaimPolicy.js';

const RELATION_TYPES = Object.freeze(['suspicion', 'ability', 'vote']);
const DECISION_ASSESSMENT_LEVEL_SET = new Set(DECISION_ASSESSMENT_LEVELS);

const RELATION_LABELS = Object.freeze({
  suspicion: '疑い',
  ability: '公開能力結果',
  vote: '公開投票',
});

function roleName(roleId) {
  return ROLE_DEFINITIONS[roleId]?.name ?? roleId ?? '';
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizedSuspicionStrength(value) {
  const strength = String(value ?? 'unresolved');
  return DECISION_ASSESSMENT_LEVEL_SET.has(strength) ? strength : 'unresolved';
}

function latestPublishedVoteEvent(state) {
  return [...(state.events ?? [])]
    .reverse()
    .find((event) => event?.type === 'vote-finalized'
      && event.status === 'published'
      && event.audience?.type === 'public'
      && Array.isArray(event.payload?.ballots)) ?? null;
}

function activeClaimByActor(state) {
  return new Map((state.claims ?? [])
    .filter((claim) => claim?.status === 'active')
    .map((claim) => [claim.actorId, claim]));
}

function activeAbilityClaims(state) {
  return (state.publicAbilityClaims ?? [])
    .filter((claim) => claim?.status === 'active')
    .sort((a, b) => Number(a.availableDay ?? a.announcedDay ?? 0) - Number(b.availableDay ?? b.announcedDay ?? 0));
}

function pushOrReplaceEdge(edgeMap, edge, { replace = false } = {}) {
  const key = `${edge.type}:${edge.sourceId}:${edge.targetId}`;
  if (!edgeMap.has(key) || replace) edgeMap.set(key, edge);
}

function normalizedEdge(edge) {
  return {
    id: String(edge.id ?? ''),
    type: String(edge.type ?? ''),
    sourceId: String(edge.sourceId ?? ''),
    targetId: String(edge.targetId ?? ''),
    label: String(edge.label ?? ''),
    graphLabel: String(edge.graphLabel ?? ''),
    day: Number(edge.day ?? 0),
    result: edge.result ?? null,
    sourceEventId: edge.sourceEventId ?? null,
  };
}

function storedEdge(edge) {
  return normalizedEdge(edge);
}

function storedDecisionState(player) {
  return player?.decisionState ?? null;
}

function currentDecisionState(state, player) {
  return getCurrentDecisionProjection(state, player.id, { taskType: 'speech' }).state;
}

function buildCounts(edges) {
  return Object.fromEntries(RELATION_TYPES.map((type) => [type, edges.filter((edge) => edge.type === type).length]));
}

function deathDay(player) {
  const value = Number(player?.death?.day);
  return Number.isInteger(value) ? value : null;
}

function canConnectSuspicion(player, snapshotDay) {
  if (!player) return false;
  if (snapshotDay === null) return Boolean(player.alive);
  return Boolean(player.alive) || deathDay(player) === snapshotDay;
}

function abilityRoleIdFromEvent(state, edge) {
  const sourceEvent = (state?.events ?? []).find((event) => event?.id === edge.sourceEventId) ?? null;
  const eventClaim = (sourceEvent?.payload?.structured?.abilityClaims ?? []).find((claim) => claim?.action === 'publish'
    && claim.targetId === edge.targetId
    && claim.result === edge.result);
  if (eventClaim?.claimedRoleId || eventClaim?.roleId) return String(eventClaim.claimedRoleId ?? eventClaim.roleId);

  const storedClaim = [...(state?.publicAbilityClaims ?? [])].reverse().find((claim) => claim?.sourceEventId === edge.sourceEventId
    && claim.actorId === edge.sourceId
    && claim.targetId === edge.targetId
    && claim.result === edge.result);
  return storedClaim?.claimedRoleId ? String(storedClaim.claimedRoleId) : null;
}

export function buildPlayerRelationshipModel(state, {
  showConfidential = false,
  snapshotDay = null,
  getRoleName = roleName,
} = {}) {
  const players = state.players ?? [];
  const normalizedSnapshotDay = snapshotDay === null || snapshotDay === undefined
    ? null
    : Number.isInteger(Number(snapshotDay))
      ? Number(snapshotDay)
      : null;
  const playerIds = new Set(players.map((player) => player.id));
  const playerById = new Map(players.map((player) => [player.id, player]));
  const claims = activeClaimByActor(state);
  const abilityClaims = activeAbilityClaims(state);
  const latestVote = latestPublishedVoteEvent(state);
  const edgeMap = new Map();
  const decisionByPlayerId = new Map(players.map((player) => [
    player.id,
    normalizedSnapshotDay === null ? currentDecisionState(state, player) : storedDecisionState(player),
  ]));
  const suspicionParticipantIds = new Set(players
    .filter((player) => canConnectSuspicion(player, normalizedSnapshotDay))
    .map((player) => player.id));

  // 疑い先は公開議論の対立関係とほぼ同質で、相関図の主要価値を構成する。
  // 機密表示OFFでも線自体は残し、内部確信度や真役職だけを後段で秘匿する。
  players.forEach((player) => {
    if (!suspicionParticipantIds.has(player.id)) return;
    const currentDecision = decisionByPlayerId.get(player.id);
    unique(currentDecision?.suspicionCandidateIds)
      .filter((targetId) => targetId !== player.id
        && playerIds.has(targetId)
        && suspicionParticipantIds.has(targetId))
      .forEach((targetId) => pushOrReplaceEdge(edgeMap, normalizedEdge({
        id: `suspicion:${player.id}:${targetId}`,
        type: 'suspicion',
        sourceId: player.id,
        targetId,
        label: '疑い',
        day: Number(currentDecision?.sourceDay ?? 0),
      })));
  });

  abilityClaims.forEach((claim) => {
    if (!playerIds.has(claim.actorId) || !playerIds.has(claim.targetId) || claim.actorId === claim.targetId) return;
    const claimedRoleName = getRoleName(claim.claimedRoleId) || claim.claimedRoleId || '能力';
    const edge = normalizedEdge({
      id: `ability:${claim.actorId}:${claim.targetId}`,
      type: 'ability',
      sourceId: claim.actorId,
      targetId: claim.targetId,
      label: `${claimedRoleName}・${publicAbilityResultLabel(claim.result, claim.claimedRoleId)}`,
      graphLabel: `${claimedRoleName}${claim.result === 'wolf' ? '●' : claim.result === 'not-wolf' ? '○' : '◇'}`,
      day: Number(claim.availableDay ?? claim.announcedDay ?? 0),
      result: claim.result,
      sourceEventId: claim.sourceEventId ?? null,
    });
    edge.abilityRoleId = claim.claimedRoleId ? String(claim.claimedRoleId) : null;
    pushOrReplaceEdge(edgeMap, edge, { replace: true });
  });

  (latestVote?.payload?.ballots ?? []).forEach((ballot) => {
    if (!playerIds.has(ballot?.voterId) || !playerIds.has(ballot?.targetId) || ballot.voterId === ballot.targetId) return;
    pushOrReplaceEdge(edgeMap, normalizedEdge({
      id: `vote:${ballot.voterId}:${ballot.targetId}`,
      type: 'vote',
      sourceId: ballot.voterId,
      targetId: ballot.targetId,
      label: '投票',
      day: Number(latestVote.day ?? 0),
      sourceEventId: latestVote.id,
    }));
  });

  const nodes = players.map((player) => {
    const claim = claims.get(player.id) ?? null;
    const currentDecision = decisionByPlayerId.get(player.id);
    const canConnect = suspicionParticipantIds.has(player.id);
    const suspicionTargetIds = canConnect
      ? unique(currentDecision?.suspicionCandidateIds)
        .filter((id) => playerIds.has(id) && id !== player.id && suspicionParticipantIds.has(id))
      : [];
    return {
      id: player.id,
      name: player.name,
      alive: Boolean(player.alive),
      controller: player.controller,
      claimedRoleId: claim?.roleId ?? null,
      claimedRoleName: claim ? getRoleName(claim.roleId) : '',
      actualRoleId: showConfidential ? player.roleId : null,
      actualRoleName: showConfidential ? getRoleName(player.roleId) : '',
      suspicionTargetIds,
      suspicionStrength: showConfidential && canConnect
        ? normalizedSuspicionStrength(currentDecision?.assessmentLevel)
        : null,
      decisionSourceDay: showConfidential && canConnect ? currentDecision?.sourceDay ?? null : null,
    };
  });
  const edges = [...edgeMap.values()];

  return {
    nodes,
    edges,
    latestVoteDay: latestVote ? Number(latestVote.day ?? 0) : null,
    showConfidential: Boolean(showConfidential),
    counts: buildCounts(edges),
  };
}

export function projectPlayerRelationshipSnapshot(snapshot, {
  showConfidential = false,
  state = null,
} = {}) {
  const confidential = Boolean(showConfidential);
  const nodes = (snapshot?.nodes ?? []).map((node) => ({
    ...node,
    actualRoleId: confidential ? node.actualRoleId : null,
    actualRoleName: confidential ? node.actualRoleName : '',
    suspicionTargetIds: [...(node.suspicionTargetIds ?? [])],
    suspicionStrength: confidential ? normalizedSuspicionStrength(node.suspicionStrength) : null,
    decisionSourceDay: confidential ? node.decisionSourceDay ?? null : null,
  }));
  const edges = (snapshot?.edges ?? [])
    .map((edge) => {
      const projected = { ...edge };
      if (edge.type === 'ability') projected.abilityRoleId = abilityRoleIdFromEvent(state, edge);
      return projected;
    });
  return {
    nodes,
    edges,
    latestVoteDay: snapshot?.latestVoteDay ?? null,
    showConfidential: confidential,
    counts: buildCounts(edges),
  };
}

export function captureDayEndPlayerRelationshipSnapshot(state, {
  sourceEventId,
} = {}) {
  const day = Number(state.game?.day ?? 0);
  if (!Number.isInteger(day) || day < 1) return null;
  const sourceEvent = (state.events ?? []).find((event) => event.id === sourceEventId) ?? null;
  const model = buildPlayerRelationshipModel(state, {
    showConfidential: true,
    snapshotDay: day,
  });
  const snapshot = {
    id: createId('relationship-snapshot'),
    day,
    capturedAt: nowIso(),
    sourceEventId: sourceEvent?.id ?? null,
    sourceRef: sourceEvent ? Number(sourceEvent.sequence ?? 0) : null,
    latestVoteDay: model.latestVoteDay,
    nodes: model.nodes.map((node) => ({
      ...node,
      suspicionTargetIds: [...node.suspicionTargetIds],
    })),
    edges: model.edges.map(storedEdge),
  };
  state.relationshipSnapshots = [
    ...(state.relationshipSnapshots ?? []).filter((item) => Number(item.day) !== day),
    snapshot,
  ].sort((left, right) => Number(left.day) - Number(right.day));
  return snapshot;
}

export const PLAYER_RELATIONSHIP_TYPES = RELATION_TYPES;
export const PLAYER_RELATIONSHIP_LABELS = RELATION_LABELS;
