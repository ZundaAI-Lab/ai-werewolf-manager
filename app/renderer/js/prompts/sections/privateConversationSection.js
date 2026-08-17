/**
 * 責務: 共有者会話・人狼秘密会話・墓場会話を、参加者本人だけに渡す共有情報セクションへ変換する。
 * 変更ルール: 重複除去と過去要約の扱いを維持し、共有範囲外の情報を追加しない。
 */


import { renderPromptDataBlock } from '../serialization/promptDataSerializer.js';

import {
  uniqueSharedMessages,
  buildPastWolfConversationSummary,
  sharedStrategyLines,
  playerName,
} from './promptFormatters.js';

export function graveyardCommunicationSection(context) {
  const activeMessages = uniqueSharedMessages(context.graveyardCommunication.current?.messages ?? []);
  const activeConversation = activeMessages.map((message) => ({
    ref: `#${message.sequence}`,
    speaker: playerName(context, message.speakerId),
    text: message.content,
  }));
  const pastConversation = (context.graveyardCommunication.past ?? []).map((item) => ({
    day: item.day,
    participants: (item.participantIds ?? []).map((id) => playerName(context, id)),
    summary: String(item.summary ?? '').trim(),
    messages: (item.messages ?? []).map((message) => ({
      ref: `#${message.sequence}`,
      speaker: playerName(context, message.speakerId),
      text: message.content,
    })),
  }));
  const currentSession = context.graveyardCommunication.current;
  const speechProgress = currentSession ? {
    speechCountPerParticipant: currentSession.speechCountPerParticipant,
    remainingByParticipant: Object.fromEntries(
      currentSession.participantIds.map((id) => [playerName(context, id), currentSession.remainingByParticipant?.[id] ?? 0]),
    ),
  } : null;
  if (!activeConversation.length && !pastConversation.length && !speechProgress) return '';
  return `## 墓場共有情報
${renderPromptDataBlock('graveyard-communication', {
    rule: '死亡後の地上情報は自動共有されません。新しく墓場へ来た参加者が会話で伝えた内容だけを共有情報として扱います。',
    publicKnowledgeCutoffSequence: context.graveyardCommunication.knowledgeCutoffSequence ?? null,
    speechProgress,
    currentConversation: activeConversation,
    pastConversations: pastConversation,
  })}`;
}

export function masonCommunicationSection(context) {
  const activeMessages = uniqueSharedMessages(context.masonCommunication.current?.messages ?? []);
  const activeConversation = activeMessages.map((message) => ({
    ref: `#${message.sequence}`,
    speaker: playerName(context, message.speakerId),
    text: message.content,
  }));
  const pastConversation = (context.masonCommunication.past ?? [])
    .map((item) => ({ day: item.day, summary: String(item.summary ?? '').trim() }))
    .filter((item) => item.summary);
  const currentSession = context.masonCommunication.current;
  const speechProgress = currentSession ? {
    speechCountPerParticipant: currentSession.speechCountPerParticipant,
    remainingByParticipant: Object.fromEntries(
      currentSession.participantIds.map((id) => [playerName(context, id), currentSession.remainingByParticipant?.[id] ?? 0]),
    ),
  } : null;
  if (!activeConversation.length && !pastConversation.length && !speechProgress) return '';
  return `## 共有者共有情報
${renderPromptDataBlock('mason-communication', {
    speechProgress,
    currentConversation: activeConversation,
    pastConversations: pastConversation,
  })}`;
}

export function wolfCommunicationSection(context) {
  const activeMessages = uniqueSharedMessages(context.wolfCommunication.current?.messages ?? []);
  const activeConversation = activeMessages.map((message) => ({
    ref: `#${message.sequence}`,
    speaker: playerName(context, message.speakerId),
    text: message.content,
  }));
  const pastSummary = buildPastWolfConversationSummary(context.wolfCommunication.past ?? [], activeMessages);
  const currentSharedStrategy = sharedStrategyLines(context.wolfCommunication.current?.sharedStrategy);
  const currentSession = context.wolfCommunication.current;
  const speechProgress = currentSession ? {
    speechCountPerParticipant: currentSession.speechCountPerParticipant,
    remainingByParticipant: Object.fromEntries(
      currentSession.participantIds.map((id) => [playerName(context, id), currentSession.remainingByParticipant?.[id] ?? 0]),
    ),
  } : null;
  if (!currentSharedStrategy.length && !activeConversation.length && !pastSummary.strategySummary.length && !pastSummary.latestPastConversation && !speechProgress) return '';
  return `## 人狼共有情報
${renderPromptDataBlock('wolf-communication', {
    speechProgress,
    currentStrategy: currentSharedStrategy,
    accumulatedStrategySummary: pastSummary.strategySummary,
    currentConversation: activeConversation,
    latestPastConversation: pastSummary.latestPastConversation,
  })}`;
}
