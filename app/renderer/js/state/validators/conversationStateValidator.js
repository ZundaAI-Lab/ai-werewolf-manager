/**
 * 責務: 人狼・共有者・墓場の秘密会話について参加資格、回数、共有作戦、発言者整合を検査する。
 * 変更ルール: 夜行動・投票・処刑を扱わず、秘密会話セッションの保存事実だけを検証する。
 */

import { countsAsWolf, isMadmanClass } from '../../domain/roles/roleAttributes.js';
import { WOLF_CONVERSATION_PURPOSES, WOLF_SHARED_STRATEGY_KEYS } from './validatorShared.js';

export function validateConversationState(context) {
  const { raw, label, errors, checkId, checkIds } = context;
  const wolfConversationIds = (raw.wolfConversations ?? []).map((session) => session.id);
  const wolfConversationIdSet = new Set(wolfConversationIds);
  if (wolfConversationIdSet.size !== wolfConversationIds.length) errors.push(`${label}: 人狼共有会話IDが重複しています。`);
  (raw.wolfConversations ?? []).forEach((session) => {
    checkIds(session.participantIds, '人狼共有参加者');
    (session.participantIds ?? []).forEach((id) => {
      const participant = raw.players.find((player) => player.id === id);
      const allowed = countsAsWolf(raw, participant)
        || (raw.game.rules.wolfCommunication.participantMode === 'wolves-and-madman' && isMadmanClass(raw, participant));
      if (!allowed) errors.push(`${label}: 人狼共有会話に参加資格のない人物が含まれています。`);
    });
    if (!WOLF_CONVERSATION_PURPOSES.has(session.purpose)) errors.push(`${label}: 人狼共有会話の目的が不正です。`);
    if (!['open', 'closed'].includes(session.status)) errors.push(`${label}: 人狼共有会話の状態が不正です。`);
    if (!Number.isInteger(session.speechCountPerParticipant) || session.speechCountPerParticipant < 1 || session.speechCountPerParticipant > 10) errors.push(`${label}: 人狼共有会話の発言回数が不正です。`);
    if (!session.remainingByParticipant || typeof session.remainingByParticipant !== 'object' || Array.isArray(session.remainingByParticipant)) {
      errors.push(`${label}: 人狼共有会話の残り発言回数一覧がありません。`);
    } else {
      const participantSet = new Set(session.participantIds ?? []);
      Object.keys(session.remainingByParticipant).forEach((id) => { if (!participantSet.has(id)) errors.push(`${label}: 人狼共有会話の残り回数に参加者外の人物が含まれています。`); });
      (session.participantIds ?? []).forEach((id) => {
        const remaining = session.remainingByParticipant[id];
        if (!Number.isInteger(remaining) || remaining < 0 || remaining > session.speechCountPerParticipant) errors.push(`${label}: 人狼共有会話の残り発言回数が不正です: ${id}`);
        const messageCount = (session.messages ?? []).filter((message) => message.speakerId === id).length;
        if (Number.isInteger(remaining) && messageCount !== session.speechCountPerParticipant - remaining) errors.push(`${label}: 人狼共有会話の発言履歴と残り回数が一致しません: ${id}`);
      });
      if (session.status === 'open' && (session.participantIds ?? []).every((id) => session.remainingByParticipant[id] === 0)) errors.push(`${label}: 発言回数を使い切った人狼共有会話が開いたままです。`);
    }
    WOLF_SHARED_STRATEGY_KEYS.forEach((key) => { if (typeof session.sharedStrategy?.[key] !== 'string') errors.push(`${label}: 共有作戦${key}が不正です。`); });
    if (session.purpose === 'opening-strategy' && session.sharedStrategy?.attackPlan !== 'none') errors.push(`${label}: 初夜襲撃なしのattackPlanはnoneである必要があります。`);
    (session.messages ?? []).forEach((message) => checkId(message.speakerId, '共有会話話者'));
  });


  const masonConversationIds = (raw.masonConversations ?? []).map((session) => session.id);
  const masonConversationIdSet = new Set(masonConversationIds);
  if (masonConversationIdSet.size !== masonConversationIds.length) errors.push(`${label}: 共有者共有会話IDが重複しています。`);
  (raw.masonConversations ?? []).forEach((session) => {
    checkIds(session.participantIds, '共有者共有参加者');
    if (!['open', 'closed'].includes(session.status)) errors.push(`${label}: 共有者共有会話の状態が不正です。`);
    if (!Number.isInteger(session.speechCountPerParticipant) || session.speechCountPerParticipant < 1 || session.speechCountPerParticipant > 10) errors.push(`${label}: 共有者共有会話の発言回数が不正です。`);
    (session.participantIds ?? []).forEach((id) => {
      if (raw.players.find((player) => player.id === id)?.roleId !== 'mason') errors.push(`${label}: 共有者共有会話に共有者以外が含まれています。`);
    });
    if (!session.remainingByParticipant || typeof session.remainingByParticipant !== 'object' || Array.isArray(session.remainingByParticipant)) {
      errors.push(`${label}: 共有者共有会話の残り発言回数一覧がありません。`);
    } else {
      const participantSet = new Set(session.participantIds ?? []);
      Object.keys(session.remainingByParticipant).forEach((id) => { if (!participantSet.has(id)) errors.push(`${label}: 共有者共有会話の残り回数に参加者外の人物が含まれています。`); });
      (session.participantIds ?? []).forEach((id) => {
        const remaining = session.remainingByParticipant[id];
        if (!Number.isInteger(remaining) || remaining < 0 || remaining > session.speechCountPerParticipant) errors.push(`${label}: 共有者共有会話の残り発言回数が不正です: ${id}`);
        const messageCount = (session.messages ?? []).filter((message) => message.speakerId === id).length;
        if (Number.isInteger(remaining) && messageCount !== session.speechCountPerParticipant - remaining) errors.push(`${label}: 共有者共有会話の発言履歴と残り回数が一致しません: ${id}`);
      });
      if (session.status === 'open' && (session.participantIds ?? []).every((id) => session.remainingByParticipant[id] === 0)) errors.push(`${label}: 発言回数を使い切った共有者共有会話が開いたままです。`);
    }
    (session.messages ?? []).forEach((message) => {
      checkId(message.speakerId, '共有者共有会話話者');
      if (!(session.participantIds ?? []).includes(message.speakerId)) errors.push(`${label}: 共有者共有会話に参加者外の発言があります。`);
    });
  });

  const graveyardConversationIds = (raw.graveyardConversations ?? []).map((session) => session.id);
  const graveyardConversationIdSet = new Set(graveyardConversationIds);
  if (graveyardConversationIdSet.size !== graveyardConversationIds.length) errors.push(`${label}: 墓場会話IDが重複しています。`);
  (raw.graveyardConversations ?? []).forEach((session) => {
    checkIds(session.participantIds, '墓場会話参加者');
    if (!['open', 'closed'].includes(session.status)) errors.push(`${label}: 墓場会話の状態が不正です。`);
    if (!Number.isInteger(session.speechCountPerParticipant) || session.speechCountPerParticipant < 1 || session.speechCountPerParticipant > 10) errors.push(`${label}: 墓場会話の発言回数が不正です。`);
    (session.participantIds ?? []).forEach((id) => {
      const participant = raw.players.find((player) => player.id === id);
      if (!participant || participant.alive) errors.push(`${label}: 墓場会話に生存者が含まれています。`);
    });
    if (!session.remainingByParticipant || typeof session.remainingByParticipant !== 'object' || Array.isArray(session.remainingByParticipant)) {
      errors.push(`${label}: 墓場会話の残り発言回数一覧がありません。`);
    } else {
      const participantSet = new Set(session.participantIds ?? []);
      Object.keys(session.remainingByParticipant).forEach((id) => { if (!participantSet.has(id)) errors.push(`${label}: 墓場会話の残り回数に参加者外の人物が含まれています。`); });
      (session.participantIds ?? []).forEach((id) => {
        const remaining = session.remainingByParticipant[id];
        if (!Number.isInteger(remaining) || remaining < 0 || remaining > session.speechCountPerParticipant) errors.push(`${label}: 墓場会話の残り発言回数が不正です: ${id}`);
        const messageCount = (session.messages ?? []).filter((message) => message.speakerId === id).length;
        if (Number.isInteger(remaining) && messageCount !== session.speechCountPerParticipant - remaining) errors.push(`${label}: 墓場会話の発言履歴と残り回数が一致しません: ${id}`);
      });
      if (session.status === 'open' && (session.participantIds ?? []).every((id) => session.remainingByParticipant[id] === 0)) errors.push(`${label}: 発言回数を使い切った墓場会話が開いたままです。`);
    }
    (session.messages ?? []).forEach((message) => {
      checkId(message.speakerId, '墓場会話話者');
      if (!(session.participantIds ?? []).includes(message.speakerId)) errors.push(`${label}: 墓場会話に参加者外の発言があります。`);
    });
  });

}
