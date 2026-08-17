/**
 * 責務: ゲームイベントの作成、公開、無効化、訂正関連付け、時系列取得を担当する。
 * 変更ルール: 役職・勝敗・対象候補などのゲーム規則を判断しない。DOM・永続化を扱わない。
 */

import { createId, nowIso } from '../../shared/utils.js';

function bumpPublicRevision(state) {
  state.publicRevision = (state.publicRevision ?? 0) + 1;
}

export function createEvent(state, {
  type,
  actorId = null,
  targetIds = [],
  audience = { type: 'gm', targetIds: [] },
  payload = {},
  status = 'confirmed',
}) {
  const event = {
    id: createId('event'),
    sequence: ++state.game.eventSequence,
    day: state.game.day,
    phase: state.game.phase,
    type,
    actorId,
    targetIds: [...targetIds],
    audience: {
      type: audience.type ?? 'gm',
      targetIds: [...(audience.targetIds ?? [])],
    },
    payload,
    status,
    createdAt: nowIso(),
    publishedAt: status === 'published' ? nowIso() : null,
    voidedByEventId: null,
  };
  state.events.push(event);
  if (status === 'published' && event.audience.type === 'public') bumpPublicRevision(state);
  return event;
}

export function getEvent(state, eventId) {
  return state.events.find((event) => event.id === eventId) ?? null;
}

export function voidEvent(state, eventId, voidedByEventId = null) {
  const event = getEvent(state, eventId);
  if (!event || event.status === 'voided') return null;
  const wasPublic = event.status === 'published' && event.audience.type === 'public';
  event.status = 'voided';
  event.voidedByEventId = voidedByEventId;
  if (wasPublic) bumpPublicRevision(state);
  return event;
}

export function addCorrectionEvent(state, {
  targetEventId = null,
  reason,
  replacementText = '',
  actorId = null,
  audience = { type: 'public', targetIds: [] },
  payload = {},
}) {
  const target = targetEventId ? getEvent(state, targetEventId) : null;
  const correction = createEvent(state, {
    type: 'correction',
    actorId,
    targetIds: target ? [target.id] : [],
    audience,
    status: audience.type === 'public' ? 'published' : 'confirmed',
    payload: {
      text: replacementText,
      reason,
      targetEventId,
      ...payload,
    },
  });
  if (target) voidEvent(state, target.id, correction.id);
  return correction;
}

export function getPublishedPublicEvents(state) {
  return state.events
    .filter((event) => event.status === 'published' && event.audience?.type === 'public')
    .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
}

export function getVisibleEvents(state, playerId) {
  return state.events.filter((event) => {
    if (!['confirmed', 'published'].includes(event.status)) return false;
    const audience = event.audience ?? { type: 'gm', targetIds: [] };
    if (audience.type === 'public') return event.status === 'published';
    if (audience.type === 'player') return audience.targetIds?.includes(playerId);
    if (audience.type === 'participants') return audience.targetIds?.includes(playerId);
    return false;
  }).sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
}
