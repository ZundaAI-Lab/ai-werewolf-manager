/**
 * 責務: 人狼共有会話へ共通の夜間機密会話ポリシーを適用する。
 * 変更ルール: 人狼固有の襲撃・共有作戦は扱わず、発言回数・次話者・連続発言防止を共通モジュールへ委譲する。
 */
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
export const createWolfConversationProgress = (participantIds, count) => createPrivateConversationProgress(participantIds, count, '人狼共有会話');
export const getWolfConversationRemaining = getPrivateConversationRemaining;
export const getWolfConversationEligibleSpeakerIds = getPrivateConversationEligibleSpeakerIds;
export const getWolfConversationNextSpeakerId = getPrivateConversationNextSpeakerId;
export const canWolfConversationSpeakerTakeTurn = canPrivateConversationSpeakerTakeTurn;
export const consumeWolfConversationSpeech = consumePrivateConversationSpeech;
export const isWolfConversationComplete = isPrivateConversationComplete;
