/**
 * 責務: 人狼共有会話へ共通の夜間機密会話ポリシーを適用する。
 * 変更ルール: 人狼固有の襲撃・共有作戦は扱わず、発言回数だけを共通モジュールへ委譲する。
 */
import {
  consumePrivateConversationSpeech,
  createPrivateConversationProgress,
  getPrivateConversationEligibleSpeakerIds,
  getPrivateConversationRemaining,
  isPrivateConversationComplete,
  validatePrivateConversationSpeechCount,
} from './privateConversationPolicy.js';
export const createWolfConversationProgress = (participantIds, count) => createPrivateConversationProgress(participantIds, count, '人狼共有会話');
export const getWolfConversationRemaining = getPrivateConversationRemaining;
export const getWolfConversationEligibleSpeakerIds = getPrivateConversationEligibleSpeakerIds;
export const consumeWolfConversationSpeech = consumePrivateConversationSpeech;
export const isWolfConversationComplete = isPrivateConversationComplete;
