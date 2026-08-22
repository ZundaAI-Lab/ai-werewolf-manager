/**
 * 責務: 共有者共有会話の参加者抽出と、共通の夜間機密会話ポリシー適用を行う。
 * 変更ルール: 襲撃や人狼共有作戦を扱わず、生存共有者だけを参加者とし、発言回数・次話者・連続発言防止は共通モジュールへ委譲する。
 */
import { getPlayersByRole } from '../game/standardRules.js';
import {
  canPrivateConversationSpeakerTakeTurn,
  consumePrivateConversationSpeech,
  createPrivateConversationProgress,
  getPrivateConversationEligibleSpeakerIds,
  getPrivateConversationNextSpeakerId,
  getPrivateConversationRemaining,
  isPrivateConversationComplete,
  validatePrivateConversationSpeechCount,
} from './privateConversationPolicy.js';

export function getMasonConversationParticipantIds(state) {
  if (state.game.rules.masonCommunication?.enabled === false) return [];
  return getPlayersByRole(state, 'mason', { aliveOnly: true }).map((player) => player.id);
}
export const createMasonConversationProgress = (participantIds, count) => createPrivateConversationProgress(participantIds, count, '共有者共有会話');
export const getMasonConversationRemaining = getPrivateConversationRemaining;
export const getMasonConversationEligibleSpeakerIds = getPrivateConversationEligibleSpeakerIds;
export const getMasonConversationNextSpeakerId = getPrivateConversationNextSpeakerId;
export const canMasonConversationSpeakerTakeTurn = canPrivateConversationSpeakerTakeTurn;
export const consumeMasonConversationSpeech = consumePrivateConversationSpeech;
export const isMasonConversationComplete = isPrivateConversationComplete;
