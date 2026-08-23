/**
 * 責務: 現在のGame Stateを変更せず、過去に公開されたイベント列と再生event sequenceから観戦用の歴史的公開Snapshotを再構築する。
 * 変更ルール: 追っかけ観戦の再生位置だけを解釈し、ゲーム進行・観戦会話・AI通信を行わない。再生位置が非公開event sequence上でも、盤面時点と神視点用cutoffは最後に再生済みの公開イベントへ正規化し、非公開イベントを時点判定へ混入させない。現在voidedの公開イベントも訂正イベント到達前は当時のpublished状態として復元する。生死・凍結・CO・公開能力結果・結果公開はcutoff以前の公開情報だけから決定し、未来の現在Stateを混入させない。公開イベントのpayload射影はpublicSnapshot.jsのbuildPublicEventSnapshotを正本とする。
 */

import { PHASE_LABELS } from '../config/constants.js';
import { rebuildPublicAbilityClaims, rebuildRoleClaims } from '../domain/events/publicDerivation.js';
import { buildPublicEventSnapshot } from './publicSnapshot.js';

function bySequence(a, b) {
  return Number(a?.sequence ?? 0) - Number(b?.sequence ?? 0);
}

function sequenceOf(value) {
  return Math.max(0, Math.trunc(Number(value ?? 0) || 0));
}

function wasEverPublishedPublic(event) {
  return event?.audience?.type === 'public'
    && (event.status === 'published' || Boolean(event.publishedAt));
}

export function getHistoricalPublicTimeline(state) {
  return (state?.events ?? []).filter(wasEverPublishedPublic).sort(bySequence);
}

export function latestHistoricalPublicSequence(state) {
  return getHistoricalPublicTimeline(state).reduce((max, event) => Math.max(max, sequenceOf(event.sequence)), 0);
}

export function resolveHistoricalPublicCutoffSequence(state, cutoffSequence) {
  const requestedCutoff = sequenceOf(cutoffSequence);
  return getHistoricalPublicTimeline(state)
    .filter((event) => sequenceOf(event.sequence) <= requestedCutoff)
    .reduce((max, event) => Math.max(max, sequenceOf(event.sequence)), 0);
}

export function nextHistoricalPublicEvent(state, afterSequence = 0) {
  const threshold = sequenceOf(afterSequence);
  return getHistoricalPublicTimeline(state).find((event) => sequenceOf(event.sequence) > threshold) ?? null;
}

export function resolvePublicReplayStart(state, requestedLogNumber) {
  const timeline = getHistoricalPublicTimeline(state);
  const latestEventSequence = timeline.reduce((max, event) => Math.max(max, sequenceOf(event.sequence)), 0);
  const requested = Math.max(1, Math.trunc(Number(requestedLogNumber ?? 1) || 1));
  const target = timeline.find((event) => sequenceOf(event.sequence) >= requested) ?? null;
  if (!target) {
    return {
      followingLive: true,
      playbackEventSequence: latestEventSequence,
      targetEventSequence: null,
      latestEventSequence,
      requestedLogNumber: requested,
    };
  }
  const targetSequence = sequenceOf(target.sequence);
  return {
    followingLive: false,
    playbackEventSequence: Math.max(0, targetSequence - 1),
    targetEventSequence: targetSequence,
    latestEventSequence,
    requestedLogNumber: requested,
  };
}

function eventStatusAtCutoff(state, event, cutoffSequence) {
  if (event.status !== 'voided') return event.status;
  const voider = event.voidedByEventId
    ? (state.events ?? []).find((candidate) => candidate.id === event.voidedByEventId)
    : null;
  if (!voider) return 'voided';
  return sequenceOf(voider.sequence) <= cutoffSequence ? 'voided' : 'published';
}

function historicalEventsAtCutoff(state, cutoffSequence) {
  return getHistoricalPublicTimeline(state)
    .filter((event) => sequenceOf(event.sequence) <= cutoffSequence)
    .map((event) => ({
      ...structuredClone(event),
      status: eventStatusAtCutoff(state, event, cutoffSequence),
      voidedByEventId: eventStatusAtCutoff(state, event, cutoffSequence) === 'voided' ? event.voidedByEventId ?? null : null,
    }));
}

function publicRevisionAtCutoff(state, cutoffSequence) {
  return getHistoricalPublicTimeline(state).filter((event) => sequenceOf(event.sequence) <= cutoffSequence).length;
}

function replayGamePoint(state, cutoffSequence) {
  const timeline = getHistoricalPublicTimeline(state);
  const point = timeline.filter((event) => sequenceOf(event.sequence) <= cutoffSequence).at(-1) ?? null;
  const phase = String(point?.phase ?? 'briefing');
  const resultPublished = timeline.some((event) => event.type === 'game-result' && sequenceOf(event.sequence) <= cutoffSequence
    && eventStatusAtCutoff(state, event, cutoffSequence) === 'published');
  return {
    title: String(state.game?.title ?? 'AI人狼'),
    day: Number(point?.day ?? 0) || 0,
    phase,
    phaseLabel: PHASE_LABELS[phase] ?? phase,
    status: resultPublished ? 'result-impressions' : 'running',
  };
}

function replayPlayers(state, activeEvents, game) {
  const deaths = new Map();
  for (const event of activeEvents) {
    if (!['execution', 'dawn'].includes(event.type)) continue;
    for (const playerId of event.payload?.deadPlayerIds ?? []) {
      if (!deaths.has(playerId)) deaths.set(playerId, { day: event.day, phase: event.phase });
    }
  }
  const frozen = new Set(activeEvents
    .filter((event) => event.type === 'dawn' && Number(event.day) === Number(game.day))
    .flatMap((event) => event.payload?.frozenPlayerIds ?? []));
  return (state.players ?? []).map((player) => ({
    id: player.id,
    name: player.name,
    alive: !deaths.has(player.id),
    frozen: !deaths.has(player.id) && frozen.has(player.id) && !['result', 'ended'].includes(game.phase),
    death: deaths.get(player.id) ?? null,
  }));
}

function replayResult(activeEvents) {
  const event = activeEvents.findLast((item) => item.type === 'game-result') ?? null;
  if (!event) return null;
  const payload = event.payload ?? {};
  return {
    winner: payload.winner ?? null,
    reason: String(payload.reason ?? ''),
    status: 'published',
    roles: structuredClone(payload.roles ?? []),
    wolfConversations: structuredClone(payload.wolfConversations ?? []),
    masonConversations: structuredClone(payload.masonConversations ?? []),
    graveyardConversations: structuredClone(payload.graveyardConversations ?? []),
    internalMemos: structuredClone(payload.internalMemos ?? []),
    publishedAt: event.publishedAt ?? null,
  };
}

export function buildPublicReplaySnapshot(state, cutoffSequence, { includeConfidential = false } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Game Stateがありません。');
  const cutoff = resolveHistoricalPublicCutoffSequence(state, cutoffSequence);
  const historicalEvents = historicalEventsAtCutoff(state, cutoff);
  const derivationState = {
    players: structuredClone(state.players ?? []),
    events: historicalEvents,
    claims: [],
    publicAbilityClaims: [],
  };
  rebuildRoleClaims(derivationState);
  rebuildPublicAbilityClaims(derivationState);
  const activeEvents = historicalEvents.filter((event) => event.status === 'published');
  const game = replayGamePoint(state, cutoff);
  return {
    schemaVersion: state.schemaVersion,
    publicRevision: publicRevisionAtCutoff(state, cutoff),
    game,
    players: replayPlayers(state, activeEvents, game),
    claims: derivationState.claims
      .filter((claim) => claim.status === 'active')
      .map((claim) => ({ actorId: claim.actorId, roleId: claim.roleId, day: claim.day })),
    publicAbilityClaims: derivationState.publicAbilityClaims
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
    events: activeEvents.map((event) => buildPublicEventSnapshot(state, event, { includeConfidential })),
    result: replayResult(activeEvents),
  };
}
