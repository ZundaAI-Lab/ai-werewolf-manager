/**
 * 責務: 公開画面へ渡してよい情報だけを含む専用スナップショットを生成し、公開イベント1件の安全な表示射影を現在表示と観戦リプレイで共有し、当日生存中の凍結表示、通常発言・回答フェーズ・勝敗後感想の話者情報、機密表示時だけ許可された役職・心の声を表示用領域へ関連付ける。
 * 変更ルール: 元状態の参照を返さない。通常生成では秘密情報を含めず、機密会話は結果公開で明示許可された本文だけを射影する。真の役職と発言別の心の声はincludeConfidential指定時だけpayload外のconfidential領域へ複製する。公開イベントpayloadの射影規則はbuildPublicEventSnapshotを正本とし、観戦リプレイ側で複製しない。通常生成・回答フェーズ・AI代替の心の声は、登録イベントIDを正本として同じ関連付け規則で扱う。
 */

import { PHASE_LABELS } from '../config/constants.js';
import { getPublishedPublicEvents } from '../domain/events/eventStore.js';
import { formatInternalMemoryText } from '../domain/memory/memoryLedger.js';
import { isFrozenOnDay } from '../domain/game/playerStatus.js';

function publicPlayer(state, player) {
  const frozen = player.alive
    && !['result', 'ended'].includes(state.game.phase)
    && isFrozenOnDay(state, player.id, state.game.day);
  return {
    id: player.id,
    name: player.name,
    alive: player.alive,
    frozen,
    death: player.death ? {
      day: player.death.day,
      phase: player.death.phase,
    } : null,
  };
}


function copyArray(value) {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function publicEventPayload(event) {
  const payload = event.payload ?? {};
  switch (event.type) {
    case 'public-speech':
      return {
        text: String(payload.text ?? ''),
        pass: Boolean(payload.pass),
        round: payload.round ?? null,
        roundKind: payload.roundKind ?? null,
      };
    case 'vote-cast':
      return {
        text: String(payload.text ?? ''),
        targetId: payload.targetId ?? null,
      };
    case 'vote-finalized':
      return {
        text: String(payload.text ?? ''),
        sessionId: payload.sessionId ?? null,
        type: payload.type ?? null,
        round: payload.round ?? null,
        tally: copyArray(payload.tally),
        ballots: copyArray(payload.ballots),
        result: payload.result ? structuredClone(payload.result) : null,
      };
    case 'execution':
      return {
        text: String(payload.text ?? ''),
        targetId: payload.targetId ?? null,
        collateralPlayerIds: [...(payload.collateralPlayerIds ?? [])],
        deadPlayerIds: [...(payload.deadPlayerIds ?? [])],
        revealedRoleId: payload.revealedRoleId ?? null,
      };
    case 'dawn':
      return {
        text: String(payload.text ?? ''),
        deadPlayerIds: [...(payload.deadPlayerIds ?? [])],
        frozenPlayerIds: [...(payload.frozenPlayerIds ?? [])],
      };
    case 'game-result':
      return {
        text: String(payload.text ?? ''),
        winner: payload.winner ?? null,
        reason: String(payload.reason ?? ''),
      };
    case 'result-impression':
      return { text: String(payload.text ?? '') };
    case 'correction':
      return {
        text: String(payload.text ?? ''),
        reason: String(payload.reason ?? ''),
        targetEventId: payload.targetEventId ?? null,
      };
    case 'system':
      return { text: String(payload.text ?? '') };
    default:
      return payload.text ? { text: String(payload.text) } : {};
  }
}

function findSpeakerHeartVoice(state, event) {
  const taskTypes = event.type === 'public-speech'
    ? ['speech', 'speech-fallback', 'speech-designated', 'speech-free', 'priority-answer', 'priority-answer-fallback']
    : event.type === 'result-impression'
      ? ['result-impression', 'result-impression-fallback']
      : [];
  if (!taskTypes.length) return '';
  const turn = (state.aiTurns ?? []).find((item) => taskTypes.includes(item.taskType)
    && item.playerId === event.actorId
    && (item.committedEntityIds ?? []).includes(event.id));
  return String(turn?.parsedHeartVoice ?? '').trim();
}


export function buildPublicEventSnapshot(state, event, { includeConfidential = false } = {}) {
  if (!event || typeof event !== 'object') throw new TypeError('公開イベントがありません。');
  const isSpeakerEvent = ['public-speech', 'result-impression'].includes(event.type) && Boolean(event.actorId);
  const actor = isSpeakerEvent ? state.players.find((player) => player.id === event.actorId) : null;
  const heartVoice = includeConfidential ? findSpeakerHeartVoice(state, event) : '';
  const confidential = includeConfidential && isSpeakerEvent && actor
    ? { roleId: actor.roleId, ...(heartVoice ? { heartVoice } : {}) }
    : null;
  return {
    id: event.id,
    sequence: event.sequence,
    day: event.day,
    phase: event.phase,
    type: event.type,
    actorId: event.actorId,
    targetIds: [...(event.targetIds ?? [])],
    payload: publicEventPayload(event),
    publishedAt: event.publishedAt,
    ...(confidential ? { confidential } : {}),
  };
}

export function buildPublicSnapshot(state, { includeConfidential = false } = {}) {
  const publishedResult = state.result?.status === 'published';
  const result = publishedResult ? {
    winner: state.result.winner,
    reason: state.result.reason,
    status: state.result.status,
    roles: state.result.revealAllRoles
      ? state.players.map((player) => ({ playerId: player.id, roleId: player.roleId }))
      : [],
    wolfConversations: state.result.revealWolfConversation
      ? state.wolfConversations.map((session) => ({
        id: session.id,
        day: session.day,
        purpose: session.purpose,
        participantIds: [...session.participantIds],
        messages: session.messages.map((message) => ({
          speakerId: message.speakerId,
          content: message.content,
          sequence: message.sequence,
        })),
      }))
      : [],
    masonConversations: state.result.revealMasonConversation
      ? state.masonConversations.map((session) => ({
        id: session.id,
        day: session.day,
        participantIds: [...session.participantIds],
        messages: session.messages.map((message) => ({
          speakerId: message.speakerId,
          content: message.content,
          sequence: message.sequence,
        })),
      }))
      : [],
    graveyardConversations: state.result.revealGraveyardConversation
      ? state.graveyardConversations.map((session) => ({
        id: session.id,
        day: session.day,
        participantIds: [...session.participantIds],
        messages: session.messages.map((message) => ({
          speakerId: message.speakerId,
          content: message.content,
          sequence: message.sequence,
        })),
      }))
      : [],
    internalMemos: state.result.revealInternalMemos
      ? state.players.map((player) => ({ playerId: player.id, heartVoice: player.heartVoice, memo: formatInternalMemoryText(player) }))
      : [],
    publishedAt: state.result.publishedAt,
  } : null;

  return {
    schemaVersion: state.schemaVersion,
    publicRevision: state.publicRevision,
    game: {
      title: state.game.title,
      day: state.game.day,
      phase: state.game.phase,
      phaseLabel: PHASE_LABELS[state.game.phase] ?? state.game.phase,
      status: state.game.status,
    },
    players: state.players.map((player) => publicPlayer(state, player)),
    claims: state.claims
      .filter((claim) => claim.status === 'active')
      .map((claim) => ({
        actorId: claim.actorId,
        roleId: claim.roleId,
        day: claim.day,
      })),
    publicAbilityClaims: state.publicAbilityClaims
      .filter((claim) => claim.status !== 'voided')
      .map((claim) => ({
        actorId: claim.actorId,
        claimedRoleId: claim.claimedRoleId,
        actionType: claim.actionType,
        targetId: claim.targetId,
        result: claim.result,
        actionDay: claim.actionDay,
        actionPhase: claim.actionPhase,
        availableDay: claim.availableDay,
        availablePhase: claim.availablePhase,
        announcedDay: claim.announcedDay,
        selectionBasis: claim.selectionBasis,
        evidenceEventIds: [...(claim.evidenceEventIds ?? [])],
        selectionReasonAtTime: claim.selectionReasonAtTime,
      })),
    events: getPublishedPublicEvents(state).map((event) => buildPublicEventSnapshot(state, event, { includeConfidential })),
    result,
  };
}
