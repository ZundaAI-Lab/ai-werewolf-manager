/**
 * 責務: 状態からUI・ワークフローに必要な参照データを純粋関数で生成する。
 * 変更ルール: 状態を書き換えず、公開専用状態生成とAI可視情報抽出は各専用モジュールへ委譲する。
 */

import { ROLE_DEFINITIONS } from '../config/constants.js';
import { getPlayer } from '../domain/game/standardRules.js';
import { getCurrentPriorityAnswerTask as deriveCurrentPriorityAnswerTask } from '../domain/discussion/priorityAnswerPolicy.js';

export function getCurrentDiscussionPlayer(state) {
  if (!state.discussion || state.discussion.completed) return null;
  const id = state.discussion.designatedPlayerId
    ?? state.discussion.queue?.[state.discussion.currentIndex]
    ?? null;
  return getPlayer(state, id);
}


export function getCurrentPriorityAnswerTask(state) {
  return deriveCurrentPriorityAnswerTask(state);
}

export function getCurrentVotePlayer(state) {
  if (!state.voteSession || state.voteSession.status !== 'input') return null;
  if (state.voteSession.inputMode !== 'sequential') return null;
  const id = state.voteSession.eligibleVoterIds[state.voteSession.currentVoterIndex];
  return getPlayer(state, id);
}

export function getPendingNightSlots(state) {
  return state.night?.slots?.filter((slot) => slot.status === 'pending') ?? [];
}

export function getCurrentNightSlot(state) {
  return getPendingNightSlots(state)[0] ?? null;
}

export function getActiveGraveyardConversation(state) {
  if (!state.night?.graveyardConversationId) return null;
  return state.graveyardConversations.find((session) => session.id === state.night.graveyardConversationId) ?? null;
}

export function getActiveMasonConversation(state) {
  if (!state.night?.masonConversationId) return null;
  return state.masonConversations.find((session) => session.id === state.night.masonConversationId) ?? null;
}

export function getActiveWolfConversation(state) {
  if (!state.night?.wolfConversationId) return null;
  return state.wolfConversations.find((session) => session.id === state.night.wolfConversationId) ?? null;
}

export function getRoleName(roleId) {
  return ROLE_DEFINITIONS[roleId]?.name ?? roleId ?? '';
}

export function getPlayerName(state, playerId, fallback = '不明') {
  return getPlayer(state, playerId)?.name ?? fallback;
}
