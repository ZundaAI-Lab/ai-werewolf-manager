/**
 * 責務: 日終了時点のプレイヤー相関スナップショットについて、保存元時点の公開イベントからCO・公開能力結果・公開投票を再構築し、参加者不変情報・疑い関係・機密情報を含む完全保存形の整合性を検査する。
 * 変更ルール: スナップショットを補正・再生成しない。公開関係は保存元イベントsequence時点の構造化公開イベントを正本とし、疑い対象・疑い強度は保存済み判断状態として相互整合を検査する。表示時の機密情報除去はdomain/records/playerRelationshipModel.jsへ委譲する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';
import {
  PUBLIC_ABILITY_RESULTS,
  publicAbilityResultLabel,
} from '../../domain/policies/publicAbilityClaimPolicy.js';
import {
  validateStoredEntityId,
  validateStoredEntityIds,
} from './validatorShared.js';

const RELATION_TYPES = new Set(['suspicion', 'ability', 'vote']);
const ROLE_IDS = new Set(Object.keys(ROLE_DEFINITIONS));
const ABILITY_RESULTS = new Set(PUBLIC_ABILITY_RESULTS);
const SUSPICION_STRENGTHS = new Set(DECISION_ASSESSMENT_LEVELS);

function roleName(roleId) {
  return ROLE_DEFINITIONS[roleId]?.name ?? roleId ?? '';
}

function relationKey(type, sourceId, targetId) {
  return `${type}:${sourceId}:${targetId}`;
}

function publishedPublicAtSequence(event, maximumSequence, eventById) {
  if (!event || Number(event.sequence) > maximumSequence || event.audience?.type !== 'public') return false;
  if (event.status === 'published') return true;
  if (event.status !== 'voided' || !event.publishedAt || !event.voidedByEventId) return false;
  const voidingEvent = eventById.get(event.voidedByEventId) ?? null;
  return Boolean(voidingEvent && Number(voidingEvent.sequence) > maximumSequence);
}

function publicSpeechEventsAtSequence(events, maximumSequence, eventById) {
  return events
    .filter((event) => event.type === 'public-speech' && publishedPublicAtSequence(event, maximumSequence, eventById))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function activeRoleByActorAtSequence(events, maximumSequence, eventById) {
  const activeByActor = new Map();
  publicSpeechEventsAtSequence(events, maximumSequence, eventById).forEach((event) => {
    const operation = event.payload?.structured?.coOperation ?? {};
    const action = String(operation.action ?? 'none');
    if (action === 'withdraw') {
      activeByActor.delete(event.actorId);
      return;
    }
    if (['declare', 'change'].includes(action)) activeByActor.set(event.actorId, String(operation.roleId ?? 'none'));
  });
  return activeByActor;
}

function expectedAbilityEdges(events, maximumSequence, eventById, playerIdSet) {
  const claims = publicSpeechEventsAtSequence(events, maximumSequence, eventById)
    .flatMap((event) => (event.payload?.structured?.abilityClaims ?? []).map((claim, index) => ({ event, claim, index })))
    .filter(({ claim }) => claim?.action === 'publish')
    .sort((left, right) => {
      const dayDifference = Number(left.claim.observedDay ?? left.event.day ?? 0) - Number(right.claim.observedDay ?? right.event.day ?? 0);
      return dayDifference || Number(left.event.sequence) - Number(right.event.sequence) || left.index - right.index;
    });
  const expected = new Map();
  claims.forEach(({ event, claim }) => {
    const sourceId = event.actorId;
    const targetId = claim.targetId;
    if (!playerIdSet.has(sourceId) || !playerIdSet.has(targetId) || sourceId === targetId) return;
    const claimedRoleId = claim.claimedRoleId ?? claim.roleId;
    const claimedRoleName = roleName(claimedRoleId) || claimedRoleId || '能力';
    const result = claim.result;
    const key = relationKey('ability', sourceId, targetId);
    expected.set(key, {
      id: key,
      type: 'ability',
      sourceId,
      targetId,
      label: `${claimedRoleName}・${publicAbilityResultLabel(result, claimedRoleId)}`,
      graphLabel: `${claimedRoleName}${result === 'wolf' ? '●' : result === 'not-wolf' ? '○' : '◇'}`,
      day: Number(claim.observedDay ?? event.day ?? 0),
      result,
      sourceEventId: event.id,
    });
  });
  return expected;
}

function latestVoteEventAtSequence(events, maximumSequence, eventById) {
  return events
    .filter((event) => event.type === 'vote-finalized'
      && Array.isArray(event.payload?.ballots)
      && publishedPublicAtSequence(event, maximumSequence, eventById))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .at(-1) ?? null;
}

function expectedVoteEdges(latestVoteEvent, playerIdSet) {
  const expected = new Map();
  (latestVoteEvent?.payload?.ballots ?? []).forEach((ballot) => {
    const sourceId = ballot?.voterId;
    const targetId = ballot?.targetId;
    if (!playerIdSet.has(sourceId) || !playerIdSet.has(targetId) || sourceId === targetId) return;
    const key = relationKey('vote', sourceId, targetId);
    if (expected.has(key)) return;
    expected.set(key, {
      id: key,
      type: 'vote',
      sourceId,
      targetId,
      label: '投票',
      graphLabel: '',
      day: Number(latestVoteEvent.day ?? 0),
      result: null,
      sourceEventId: latestVoteEvent.id,
    });
  });
  return expected;
}

function expectedSuspicionEdges(nodes, playerIdSet) {
  const expected = new Map();
  nodes.forEach((node) => {
    [...new Set(node.suspicionTargetIds ?? [])].forEach((targetId) => {
      if (!playerIdSet.has(node.id) || !playerIdSet.has(targetId) || node.id === targetId) return;
      const key = relationKey('suspicion', node.id, targetId);
      expected.set(key, {
        id: key,
        type: 'suspicion',
        sourceId: node.id,
        targetId,
        label: '疑い',
        graphLabel: '',
        day: Number(node.decisionSourceDay ?? 0),
        result: null,
        sourceEventId: null,
      });
    });
  });
  return expected;
}

function expectedAliveAtDay(player, day) {
  const deathDay = Number(player?.death?.day);
  return !(Number.isInteger(deathDay) && deathDay <= Number(day));
}

function validateCanonicalEdges(actualEdges, expectedEdges, type, itemLabel, errors) {
  const actualByKey = new Map(actualEdges.filter((edge) => edge.type === type).map((edge) => [relationKey(type, edge.sourceId, edge.targetId), edge]));
  expectedEdges.forEach((expected, key) => {
    const actual = actualByKey.get(key);
    if (!actual) {
      errors.push(`${itemLabel}.edgesに保存時点の${type}関係${key}がありません。`);
      return;
    }
    ['id', 'type', 'sourceId', 'targetId', 'label', 'graphLabel', 'day', 'result', 'sourceEventId'].forEach((field) => {
      if (actual[field] !== expected[field]) errors.push(`${itemLabel}.edgesの${key}.${field}が保存時点の正本と一致しません。`);
    });
  });
  actualByKey.forEach((_actual, key) => {
    if (!expectedEdges.has(key)) errors.push(`${itemLabel}.edgesの${key}に保存時点の公開根拠がありません。`);
  });
}

export function validateRelationshipSnapshots(context) {
  const {
    raw,
    label,
    errors,
    playerIdSet,
  } = context;
  const snapshots = Array.isArray(raw.relationshipSnapshots) ? raw.relationshipSnapshots : [];
  validateStoredEntityIds(snapshots, `${label}: relationshipSnapshots`, errors);
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  if (new Set(snapshotIds).size !== snapshotIds.length) errors.push(`${label}: 相関スナップショットIDが重複しています。`);
  const days = snapshots.map((snapshot) => Number(snapshot.day));
  if (new Set(days).size !== days.length) errors.push(`${label}: 同じDayの相関スナップショットが重複しています。`);
  if (days.some((day, index) => !Number.isInteger(day) || day < 1 || (index > 0 && day <= days[index - 1]))) {
    errors.push(`${label}: 相関スナップショットがDay昇順の正整数ではありません。`);
  }

  const events = Array.isArray(raw.events) ? raw.events : [];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const playerById = new Map((raw.players ?? []).map((player) => [player.id, player]));
  snapshots.forEach((snapshot, snapshotIndex) => {
    const itemLabel = `${label}: relationshipSnapshots[${snapshotIndex}]`;
    validateStoredEntityId(snapshot.id, `${itemLabel}.id`, errors);
    if (typeof snapshot.capturedAt !== 'string' || !snapshot.capturedAt.trim()) errors.push(`${itemLabel}.capturedAtがありません。`);
    const sourceEvent = eventById.get(snapshot.sourceEventId) ?? null;
    if (!sourceEvent) {
      errors.push(`${itemLabel}.sourceEventIdが存在するイベントを参照していません。`);
    } else {
      if (sourceEvent.status !== 'published' || sourceEvent.audience?.type !== 'public') errors.push(`${itemLabel}.保存元イベントが公開済みではありません。`);
      if (!['execution', 'vote-finalized'].includes(sourceEvent.type)) errors.push(`${itemLabel}.保存元イベントが日終了イベントではありません。`);
      if (sourceEvent.type === 'vote-finalized' && sourceEvent.payload?.result?.type === 'execution') errors.push(`${itemLabel}.処刑あり投票結果を日終了保存元にできません。`);
      if (Number(sourceEvent.day) !== Number(snapshot.day)) errors.push(`${itemLabel}.Dayが保存元イベントと一致しません。`);
      if (Number(sourceEvent.sequence) !== Number(snapshot.sourceEventSequence)) errors.push(`${itemLabel}.sourceEventSequenceが保存元イベントと一致しません。`);
    }
    const sourceSequence = Number(snapshot.sourceEventSequence);
    const maximumSequence = Number.isFinite(sourceSequence) ? sourceSequence : 0;
    const latestVoteEvent = latestVoteEventAtSequence(events, maximumSequence, eventById);
    const expectedLatestVoteDay = latestVoteEvent ? Number(latestVoteEvent.day ?? 0) : null;
    if (snapshot.latestVoteDay !== expectedLatestVoteDay) errors.push(`${itemLabel}.latestVoteDayが保存時点の公開投票と一致しません。`);

    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    if (nodes.length !== playerIdSet.size) errors.push(`${itemLabel}.nodesが参加人数と一致しません。`);
    const nodeIds = nodes.map((node) => node.id);
    if (new Set(nodeIds).size !== nodeIds.length) errors.push(`${itemLabel}.nodesのプレイヤーIDが重複しています。`);
    const activeRoleByActor = activeRoleByActorAtSequence(events, maximumSequence, eventById);
    nodes.forEach((node, nodeIndex) => {
      const nodeLabel = `${itemLabel}.nodes[${nodeIndex}]`;
      const player = playerById.get(node.id) ?? null;
      if (!player) errors.push(`${nodeLabel}.idが存在しないプレイヤーです。`);
      if (raw.players?.[nodeIndex]?.id !== node.id) errors.push(`${nodeLabel}.idが参加者の保存順と一致しません。`);
      if (typeof node.name !== 'string' || !node.name.trim()) errors.push(`${nodeLabel}.nameがありません。`);
      if (typeof node.alive !== 'boolean') errors.push(`${nodeLabel}.aliveが真偽値ではありません。`);
      if (!['ai', 'human'].includes(node.controller)) errors.push(`${nodeLabel}.controllerが不正です。`);
      if (node.claimedRoleId !== null && !ROLE_IDS.has(node.claimedRoleId)) errors.push(`${nodeLabel}.claimedRoleIdが不正です。`);
      if (!ROLE_IDS.has(node.actualRoleId)) errors.push(`${nodeLabel}.actualRoleIdが不正です。`);
      if (player) {
        if (node.name !== player.name) errors.push(`${nodeLabel}.nameが参加者情報と一致しません。`);
        if (node.controller !== player.controller) errors.push(`${nodeLabel}.controllerが参加者情報と一致しません。`);
        if (node.actualRoleId !== player.roleId) errors.push(`${nodeLabel}.actualRoleIdが参加者情報と一致しません。`);
        if (node.actualRoleName !== roleName(player.roleId)) errors.push(`${nodeLabel}.actualRoleNameが参加者情報と一致しません。`);
        if (node.alive !== expectedAliveAtDay(player, snapshot.day)) errors.push(`${nodeLabel}.aliveがDay終了時点の生死と一致しません。`);
      }
      const expectedClaimedRoleId = activeRoleByActor.get(node.id) ?? null;
      if (node.claimedRoleId !== expectedClaimedRoleId) errors.push(`${nodeLabel}.claimedRoleIdが保存時点の公開COと一致しません。`);
      if (node.claimedRoleName !== (expectedClaimedRoleId ? roleName(expectedClaimedRoleId) : '')) errors.push(`${nodeLabel}.claimedRoleNameが保存時点の公開COと一致しません。`);
      if (!Array.isArray(node.suspicionTargetIds)) errors.push(`${nodeLabel}.suspicionTargetIdsが配列ではありません。`);
      else {
        if (new Set(node.suspicionTargetIds).size !== node.suspicionTargetIds.length) errors.push(`${nodeLabel}.suspicionTargetIdsが重複しています。`);
        node.suspicionTargetIds.forEach((targetId) => {
          if (!playerIdSet.has(targetId) || targetId === node.id) errors.push(`${nodeLabel}.suspicionTargetIdsに不正な対象があります。`);
        });
      }
      if (node.suspicionStrength !== null && !SUSPICION_STRENGTHS.has(node.suspicionStrength)) {
        errors.push(`${nodeLabel}.suspicionStrengthが不正です。`);
      }
      if ((node.suspicionTargetIds ?? []).length && node.suspicionStrength === null) {
        errors.push(`${nodeLabel}.疑い対象がありますがsuspicionStrengthがありません。`);
      }
      if (node.decisionSourceDay !== null && (!Number.isInteger(Number(node.decisionSourceDay)) || Number(node.decisionSourceDay) > Number(snapshot.day))) {
        errors.push(`${nodeLabel}.decisionSourceDayが不正です。`);
      }
      if ((node.suspicionTargetIds ?? []).length && node.decisionSourceDay === null) errors.push(`${nodeLabel}.疑い対象がありますがdecisionSourceDayがありません。`);
    });

    const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
    validateStoredEntityIds(edges, `${itemLabel}.edges`, errors);
    const edgeKeys = new Set();
    edges.forEach((edge, edgeIndex) => {
      const edgeLabel = `${itemLabel}.edges[${edgeIndex}]`;
      const edgeKey = relationKey(edge.type, edge.sourceId, edge.targetId);
      if (edgeKeys.has(edgeKey)) errors.push(`${edgeLabel}が同一関係と重複しています。`);
      edgeKeys.add(edgeKey);
      if (!RELATION_TYPES.has(edge.type)) errors.push(`${edgeLabel}.typeが不正です。`);
      if (!playerIdSet.has(edge.sourceId) || !playerIdSet.has(edge.targetId) || edge.sourceId === edge.targetId) errors.push(`${edgeLabel}のプレイヤー参照が不正です。`);
      if (!Number.isInteger(Number(edge.day)) || Number(edge.day) < 0 || Number(edge.day) > Number(snapshot.day)) errors.push(`${edgeLabel}.dayが不正です。`);
      if (edge.type === 'ability') {
        if (!ABILITY_RESULTS.has(edge.result)) errors.push(`${edgeLabel}.resultが公開能力結果ではありません。`);
      } else if (edge.result !== null) errors.push(`${edgeLabel}.resultは能力結果以外ではnullでなければなりません。`);
      if (edge.type !== 'suspicion' && edge.sourceEventId === null) errors.push(`${edgeLabel}.公開関係のsourceEventIdがありません。`);
      if (edge.type === 'suspicion' && edge.sourceEventId !== null) errors.push(`${edgeLabel}.疑い関係のsourceEventIdはnullでなければなりません。`);
    });

    validateCanonicalEdges(edges, expectedSuspicionEdges(nodes, playerIdSet), 'suspicion', itemLabel, errors);
    validateCanonicalEdges(edges, expectedAbilityEdges(events, maximumSequence, eventById, playerIdSet), 'ability', itemLabel, errors);
    validateCanonicalEdges(edges, expectedVoteEdges(latestVoteEvent, playerIdSet), 'vote', itemLabel, errors);
  });
}
