/**
 * 責務: 墓場会話の参加者抽出と、共通の夜間機密会話ポリシー適用を行う。
 * 変更ルール: 夜開始時点ですでに死亡している者だけを参加者とし、生存者・その夜に死亡する者を途中参加させない。発言回数・次話者・連続発言防止は共通モジュールへ委譲する。
 */
import { getDeadPlayers } from '../game/standardRules.js';
import {
  canPrivateConversationSpeakerTakeTurn,
  consumePrivateConversationSpeech,
  createPrivateConversationProgress,
  getPrivateConversationEligibleSpeakerIds,
  getPrivateConversationNextSpeakerId,
  getPrivateConversationRemaining,
  isPrivateConversationComplete,
} from './privateConversationPolicy.js';

export function getGraveyardConversationParticipantIds(state) {
  if (state.game.rules.graveyardCommunication?.enabled !== true) return [];
  return getDeadPlayers(state).map((player) => player.id);
}
export const createGraveyardConversationProgress = (participantIds, count) => createPrivateConversationProgress(participantIds, count, '墓場会話');
export const getGraveyardConversationRemaining = getPrivateConversationRemaining;
export const getGraveyardConversationEligibleSpeakerIds = getPrivateConversationEligibleSpeakerIds;
export const getGraveyardConversationNextSpeakerId = getPrivateConversationNextSpeakerId;
export const canGraveyardConversationSpeakerTakeTurn = canPrivateConversationSpeakerTakeTurn;
export const consumeGraveyardConversationSpeech = consumePrivateConversationSpeech;
export const isGraveyardConversationComplete = isPrivateConversationComplete;
