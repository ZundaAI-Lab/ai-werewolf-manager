/**
 * 責務: 公開発言イベントから回答優先モードの未回答質問を決定的に導出し、次の通常発言者宛ての質問だけは独立回答フェーズではなく当人の通常発言へ統合する。
 * 変更ルール: 状態を更新せず、公開発言本文を解析しない。質問の現在正本・回答済み・スキップ済み判定はpublicQuestionResolution.jsへ委譲し、回答フェーズから新しい割り込みを発生させない。通常発言へ統合する対象は、現在確定している次発言者本人宛ての未解決質問だけとする。
 */

import { canSpeakDuringDay } from '../game/playerStatus.js';
import {
  getCurrentPublicQuestionEvents,
  getQuestionTargetIds,
  isPublicQuestionAnswered,
  isPublicQuestionResolved,
  isPublicQuestionSkipped,
  resolveCurrentPublicQuestionEvent,
} from './publicQuestionResolution.js';

export function isPriorityAnswerQuestion(state, event) {
  if (state?.game?.rules?.discussion?.answerPriorityEnabled !== true) return false;
  const current = resolveCurrentPublicQuestionEvent(state, event);
  if (!current || current.id !== event?.id) return false;
  if (current.payload?.speechKind !== 'normal') return false;
  if (Number(current.day) !== Number(state?.game?.day)) return false;
  const targetIds = getQuestionTargetIds(current);
  if (targetIds.length !== 1) return false;
  const targetId = targetIds[0];
  if (!targetId || targetId === current.actorId) return false;
  const target = (state?.players ?? []).find((player) => player.id === targetId);
  return Boolean(target?.alive && canSpeakDuringDay(state, targetId));
}

function getCurrentNormalSpeakerId(state) {
  const discussion = state?.discussion;
  if (!discussion || discussion.completed) return null;
  if (discussion.mode === 'ordered') {
    return discussion.queue?.[discussion.currentIndex] ?? null;
  }
  if (['designated', 'free'].includes(discussion.mode)) {
    return discussion.designatedPlayerId ?? null;
  }
  return null;
}

function deriveUnresolvedPriorityAnswerTasks(state) {
  return getCurrentPublicQuestionEvents(state)
    .filter((event) => isPriorityAnswerQuestion(state, event))
    .filter((event) => !isPublicQuestionResolved(state, event))
    .map((event) => ({
      questionEventId: event.id,
      questionSequence: Number(event.sequence),
      askerPlayerId: event.actorId,
      targetPlayerId: getQuestionTargetIds(event)[0],
      questionText: String(event.payload?.text ?? ''),
    }));
}

export function getCurrentNormalSpeechAnswerTasks(state, playerId = null) {
  const currentSpeakerId = getCurrentNormalSpeakerId(state);
  const requestedPlayerId = String(playerId ?? currentSpeakerId ?? '');
  if (!currentSpeakerId || requestedPlayerId !== currentSpeakerId) return [];
  return deriveUnresolvedPriorityAnswerTasks(state)
    .filter((task) => task.targetPlayerId === currentSpeakerId);
}

export function getPendingPriorityAnswerTasks(state) {
  const currentSpeakerId = getCurrentNormalSpeakerId(state);
  return deriveUnresolvedPriorityAnswerTasks(state)
    .filter((task) => task.targetPlayerId !== currentSpeakerId);
}

export function getCurrentPriorityAnswerTask(state) {
  return getPendingPriorityAnswerTasks(state)[0] ?? null;
}
