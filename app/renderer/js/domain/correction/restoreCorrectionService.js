/**
 * 責務: 復元理由の検証、進行結果に対応する復元ポイントの選定、影響範囲の算出、StateStoreによる安全復元、無効化された後続イベントのGM監査保存、公開訂正通知を一つの訂正ユースケースとして実行する。
 * 変更ルール: スナップショット保存・履歴上限・状態正規化はStateStoreへ委譲し、DOMや画面状態を扱わない。復元影響のイベント比較はStateStoreと同じキー順非依存比較を使う。公開通知へ無効化イベントの機密内容を含めず、完全な旧イベントはGM限定監査イベントだけへ保存する。進行結果と復元地点の対応はこのモジュールを正本とし、UIで再判定しない。
 */

import { addEvent } from '../game/gameRuntime.js';
import { stableStringify } from '../../shared/utils.js';
import { RESTORE_POINT_LABELS, RESTORE_POINT_TYPES } from './restorePointPolicy.js';

const PROGRESSION_RESTORE_LABEL_BY_EVENT_TYPE = Object.freeze({
  'vote-finalized': RESTORE_POINT_LABELS[RESTORE_POINT_TYPES.BEFORE_VOTE_FINALIZE],
  execution: RESTORE_POINT_LABELS[RESTORE_POINT_TYPES.BEFORE_EXECUTION_PUBLISH],
  dawn: RESTORE_POINT_LABELS[RESTORE_POINT_TYPES.BEFORE_DAWN_PUBLISH],
  'game-result': RESTORE_POINT_LABELS[RESTORE_POINT_TYPES.BEFORE_RESULT_PUBLISH],
});

function eventSequence(event) {
  return Number(event?.sequence ?? -1);
}

function lastSnapshotEventSequence(point) {
  return Math.max(-1, ...(point?.state?.events ?? []).map(eventSequence));
}

function changedEventsSincePoint(state, point) {
  const pointEventsById = new Map((point?.state?.events ?? []).map((event) => [event.id, event]));
  return (state?.events ?? []).filter((event) => {
    const pointEvent = pointEventsById.get(event.id);
    return !pointEvent || stableStringify(pointEvent) !== stableStringify(event);
  });
}

export function summarizeRestoreImpact(state, pointId) {
  const point = state?.restorePoints?.find((item) => item.id === pointId) ?? null;
  if (!point) return null;
  const supersededEvents = changedEventsSincePoint(state, point);
  return {
    pointId: point.id,
    label: point.label,
    day: Number(point.state?.game?.day ?? 0),
    phase: point.state?.game?.phase ?? 'setup',
    supersededEventCount: supersededEvents.length,
    publicEventCount: supersededEvents.filter((event) => event.audience?.type === 'public').length,
    aiTurnCount: Math.max(0, Number(state?.aiTurns?.length ?? 0) - Number(point.state?.aiTurns?.length ?? 0)),
  };
}

export function recommendRestorePointForProgressionEvent(state, eventId) {
  const event = state?.events?.find((item) => item.id === eventId) ?? null;
  const label = PROGRESSION_RESTORE_LABEL_BY_EVENT_TYPE[event?.type];
  if (!event || event.status !== 'published' || event.audience?.type !== 'public' || !label) return null;
  const targetSequence = eventSequence(event);
  const candidates = (state.restorePoints ?? [])
    .filter((point) => point.label === label
      && point.state?.game?.id === state.game?.id
      && !(point.state?.events ?? []).some((item) => item.id === event.id)
      && lastSnapshotEventSequence(point) < targetSequence)
    .sort((left, right) => {
      const sequenceDifference = lastSnapshotEventSequence(right) - lastSnapshotEventSequence(left);
      if (sequenceDifference) return sequenceDifference;
      const revisionDifference = Number(right.state?.revision ?? 0) - Number(left.state?.revision ?? 0);
      if (revisionDifference) return revisionDifference;
      return String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
    });
  const point = candidates[0] ?? null;
  return point ? { event, point, impact: summarizeRestoreImpact(state, point.id) } : null;
}

export function appendRestoreCorrectionAudit(state, { reason, context }) {
  const normalizedReason = String(reason ?? '').trim();
  if (!normalizedReason) throw new Error('復元理由を入力してください。');
  if (!context?.restorePointId) throw new Error('復元監査情報が不正です。');

  const auditEvent = addEvent(state, {
    type: 'correction-audit',
    audience: { type: 'gm', targetIds: [] },
    status: 'confirmed',
    payload: {
      text: `復元ポイント「${context.restorePointLabel}」へ戻しました。`,
      reason: normalizedReason,
      restorePointId: context.restorePointId,
      restoredFromRevision: context.restoredFromRevision,
      restoredToRevision: context.restoredToRevision,
      supersededEventIds: context.supersededEvents.map((event) => event.id),
      supersededEvents: context.supersededEvents,
    },
  });
  const publicEvent = addEvent(state, {
    type: 'correction',
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: {
      text: `GM訂正: ゲーム進行を復元してやり直します。理由: ${normalizedReason}`,
      reason: normalizedReason,
    },
  });
  return { auditEventId: auditEvent.id, publicEventId: publicEvent.id };
}

export function restoreGameFromPoint(store, { pointId, reason }) {
  const normalizedReason = String(reason ?? '').trim();
  if (!normalizedReason) return { ok: false, message: '復元理由を入力してください。' };
  let audit = null;
  let restoreContext = null;
  const restored = store.restoreFromPoint(pointId, `復元: ${normalizedReason}`, (state, context) => {
    restoreContext = context;
    audit = appendRestoreCorrectionAudit(state, { reason: normalizedReason, context });
  });
  if (!restored) return { ok: false, message: '復元ポイントが見つかりません。' };
  return {
    ok: true,
    message: '復元ポイントへ戻しました。訂正内容を確認してから訂正モードを終了してください。',
    restoreContext,
    ...audit,
  };
}
