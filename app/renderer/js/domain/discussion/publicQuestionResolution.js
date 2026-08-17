/**
 * 責務: 公開発言の構造化質問と構造化回答から、訂正系列を含む各質問の現在正本・対象・回答済み・スキップ済み・未解決状態を決定的に判定する。
 * 変更ルール: 公開発言本文を自然言語解析しない。questionTargetIds、answersEventIds、sourceQuestionEventId、priority-answer-resolutionだけを正本とし、状態・イベントを更新しない。質問の訂正系列は現在公開中の正本を使用し、旧対象者の回答を新対象者の回答へ流用しない。
 */

import {
  collectCorrectionLineageIds,
  getCorrectionRootEvent,
  resolvePublishedCorrectionHead,
} from '../events/correctionLineage.js';

function bySequence(left, right) {
  return Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}

function publishedSpeechEvents(state) {
  return (state?.events ?? [])
    .filter((event) => event.type === 'public-speech' && event.status === 'published')
    .sort(bySequence);
}

export function getQuestionTargetIds(questionEvent) {
  return [...new Set((questionEvent?.payload?.structured?.interaction?.questionTargetIds ?? [])
    .map(String)
    .filter(Boolean))];
}

export function resolveCurrentPublicQuestionEvent(state, questionEventOrId) {
  const events = state?.events ?? [];
  const source = typeof questionEventOrId === 'object'
    ? questionEventOrId
    : events.find((event) => event.id === questionEventOrId) ?? null;
  if (!source || source.type !== 'public-speech') return null;
  const head = resolvePublishedCorrectionHead(events, source);
  if (!head || head.type !== 'public-speech' || head.status !== 'published') return null;
  return head;
}

export function getCurrentPublicQuestionEvents(state) {
  const events = state?.events ?? [];
  const byRootId = new Map();
  publishedSpeechEvents(state).forEach((event) => {
    const root = getCorrectionRootEvent(events, event);
    const head = resolveCurrentPublicQuestionEvent(state, event);
    if (!root || !head || head.payload?.speechKind !== 'normal') return;
    if (!getQuestionTargetIds(head).length) return;
    byRootId.set(root.id, head);
  });
  return [...byRootId.values()].sort(bySequence);
}

function logicalQuestionIds(state, questionEvent) {
  return new Set(collectCorrectionLineageIds(state?.events ?? [], questionEvent));
}

export function isPublicQuestionAnswered(state, questionEvent, targetPlayerId = null) {
  const current = resolveCurrentPublicQuestionEvent(state, questionEvent);
  if (!current) return false;
  const targetId = String(targetPlayerId ?? getQuestionTargetIds(current)[0] ?? '');
  if (!targetId || !getQuestionTargetIds(current).includes(targetId)) return false;
  const logicalIds = logicalQuestionIds(state, current);
  return publishedSpeechEvents(state).some((event) => {
    if (event.actorId !== targetId) return false;
    const interactionRefs = event.payload?.structured?.interaction?.answersEventIds ?? [];
    return logicalIds.has(event.payload?.sourceQuestionEventId)
      || interactionRefs.some((eventId) => logicalIds.has(eventId));
  });
}

export function isPublicQuestionSkipped(state, questionEvent, targetPlayerId = null) {
  const current = resolveCurrentPublicQuestionEvent(state, questionEvent);
  if (!current) return false;
  const targetId = String(targetPlayerId ?? getQuestionTargetIds(current)[0] ?? '');
  if (!targetId || !getQuestionTargetIds(current).includes(targetId)) return false;
  const logicalIds = logicalQuestionIds(state, current);
  return (state?.events ?? []).some((event) => (
    event.type === 'priority-answer-resolution'
    && event.status === 'confirmed'
    && event.payload?.resolution === 'skipped'
    && logicalIds.has(event.payload?.questionEventId)
    && event.payload?.targetPlayerId === targetId
  ));
}

export function isPublicQuestionResolved(state, questionEvent, targetPlayerId = null) {
  return isPublicQuestionAnswered(state, questionEvent, targetPlayerId)
    || isPublicQuestionSkipped(state, questionEvent, targetPlayerId);
}

export function getUnresolvedPublicQuestionsForPlayer(state, playerId, {
  currentDayOnly = false,
} = {}) {
  const targetId = String(playerId ?? '');
  return getCurrentPublicQuestionEvents(state)
    .filter((event) => !currentDayOnly || Number(event.day) === Number(state?.game?.day))
    .filter((event) => event.actorId !== targetId)
    .filter((event) => getQuestionTargetIds(event).includes(targetId))
    .filter((event) => !isPublicQuestionResolved(state, event, targetId));
}
