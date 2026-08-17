/**
 * 責務: 現在の状態から、人間GMが次に行うべき一つのタスクを導出する。
 * 変更ルール: 状態変更を行わず、局面判定に必要な状態参照はstate/selectors.jsと各domainの専用規則モジュールを正本とする。内部メモ整理推奨は通常フェーズを進める前の独立タスクとして一人ずつ返す。
 */

import { TASK_LABELS } from '../../config/constants.js';
import { speechTaskTypeForDiscussionMode } from '../../config/discussionAiTaskTypes.js';
import { getPendingDiscussionOpeningPreferencePlayerId } from '../discussion/discussionRuntime.js';
import { getPendingResultImpressionPlayerId } from '../result/resultImpressions.js';
import {
  getActiveGraveyardConversation,
  getActiveMasonConversation,
  getActiveWolfConversation,
  getCurrentDiscussionPlayer,
  getCurrentNightSlot,
  getCurrentPriorityAnswerTask,
  getCurrentVotePlayer,
} from '../../state/selectors.js';

function task(type, extra = {}) {
  return { type, label: TASK_LABELS[type] ?? type, ...extra };
}

function getPendingMemoConsolidationPlayerId(state) {
  return (state.players ?? []).find((player) => (
    player.controller === 'ai'
    && player.internalMemory?.consolidationRecommended === true
  ))?.id ?? null;
}

export function getCurrentGmTask(state) {
  if (state.game.correctionMode?.enabled) return task('correction');
  const { phase } = state.game;

  if (phase === 'setup') return task('setup');

  const memoConsolidationPlayerId = getPendingMemoConsolidationPlayerId(state);
  if (memoConsolidationPlayerId) return task('memo-consolidate', { playerId: memoConsolidationPlayerId });

  if (phase === 'briefing') {
    const pendingId = state.briefing?.eligiblePlayerIds.find((id) => !['acknowledged', 'gm-forced'].includes(state.briefing.noticeStatusByPlayerId[id]));
    return pendingId ? task('briefing', { playerId: pendingId }) : task('briefing-complete');
  }

  if (phase === 'night') {
    const pendingHumanNotice = state.events.find((event) => event.type === 'private-result'
      && event.status === 'confirmed'
      && !event.payload?.acknowledgedAt
      && event.audience?.type === 'player'
      && event.audience.targetIds?.some((id) => state.players.find((player) => player.id === id && player.controller === 'human')));
    if (pendingHumanNotice) return task('private-notification', { playerId: pendingHumanNotice.audience.targetIds[0] });
    const graveyardConversation = getActiveGraveyardConversation(state);
    if (state.night?.plan?.graveyardConversationRequired && graveyardConversation?.status === 'open') {
      return task('graveyard-conversation', { conversationId: graveyardConversation.id });
    }
    const masonConversation = getActiveMasonConversation(state);
    if (state.night?.plan?.masonConversationRequired && masonConversation?.status === 'open') {
      return task('mason-conversation', { conversationId: masonConversation.id });
    }
    const conversation = getActiveWolfConversation(state);
    if (state.night?.plan?.wolfConversationRequired && conversation?.status === 'open') {
      return task('wolf-conversation', { conversationId: conversation.id });
    }
    const attack = state.night?.wolfAttack;
    if (state.night?.plan?.wolfAttackRequired && attack?.status === 'voting') {
      const pendingWolfId = attack.voterWolfIds.find((id) => !attack.voteByWolfId?.[id]);
      if (pendingWolfId) return task('wolf-attack', { playerId: pendingWolfId });
    }
    const slot = getCurrentNightSlot(state);
    if (slot) return task(slot.type, { playerId: slot.actorId, slotId: slot.id });
    return task('resolve-night');
  }

  if (phase === 'dawn') return task('publish-dawn');

  if (phase === 'discussion') {
    const pendingHumanNotice = state.events.find((event) => event.type === 'private-result'
      && event.status === 'confirmed'
      && !event.payload?.acknowledgedAt
      && event.audience?.type === 'player'
      && event.audience.targetIds?.some((id) => state.players.find((player) => player.id === id && player.controller === 'human')));
    if (pendingHumanNotice) return task('private-notification', { playerId: pendingHumanNotice.audience.targetIds[0] });
    if (state.discussion?.mode === 'free' && state.discussion?.modeControl?.stage === 'opening-preference') {
      const playerId = getPendingDiscussionOpeningPreferencePlayerId(state);
      if (playerId) return task('discussion-opening-preference', { playerId });
    }
    const priorityAnswer = getCurrentPriorityAnswerTask(state);
    if (priorityAnswer) {
      return task('priority-answer', {
        playerId: priorityAnswer.targetPlayerId,
        slotId: priorityAnswer.questionEventId,
        questionEventId: priorityAnswer.questionEventId,
      });
    }
    if (state.discussion?.completed) return task('discussion-complete');
    if (state.discussion?.allDeferred) return task('discussion-all-deferred');
    const player = getCurrentDiscussionPlayer(state);
    if (!player) {
      if (state.discussion?.mode === 'free') return task('unknown', { label: '発言希望制の発言キューを確認してください' });
      return task('discussion-designate');
    }
    return task(speechTaskTypeForDiscussionMode(state.discussion.mode), { playerId: player.id });
  }

  if (phase === 'vote' || phase === 'runoff') {
    if (state.voteSession?.status === 'input') {
      const player = getCurrentVotePlayer(state);
      return task('vote', { playerId: player?.id ?? null });
    }
    if (state.voteSession?.status === 'ready') return task('finalize-vote');
    if (state.voteSession?.status === 'finalized') return task('publish-vote');
  }

  if (phase === 'execution') {
    if (state.executionResolution?.status !== 'resolved') return task('resolve-execution', { playerId: state.voteSession?.result?.targetId ?? null });
    if (state.executionResolution.testament?.status === 'pending') return task('testament', { playerId: state.executionResolution.targetId });
    return task('publish-execution', { playerId: state.voteSession?.result?.targetId ?? null });
  }
  if (phase === 'result') {
    if (state.result?.status === 'detected') return task('confirm-result');
    if (state.result?.status === 'confirmed') return task('publish-result');
    if (state.result?.status === 'published') {
      const playerId = getPendingResultImpressionPlayerId(state);
      return playerId ? task('result-impression', { playerId }) : task('ended');
    }
    return task('publish-result');
  }
  if (phase === 'ended') return task('ended');
  return task('unknown', { label: '状態を確認してください' });
}
