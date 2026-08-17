/**
 * 責務: 夜間機密会話に共通する参加者別発言回数を初期化・参照・消費する。
 * 変更ルール: ゲーム状態全体・イベント・夜行動を変更しない。会話種別固有の参加資格や作戦情報を扱わない。
 */

export function validatePrivateConversationSpeechCount(value, label = '夜間機密会話') {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new RangeError(`${label}の1人あたり発言回数は1～10回で指定してください。`);
  }
  return count;
}

export function createPrivateConversationProgress(participantIds, speechCountPerNight, label) {
  const count = validatePrivateConversationSpeechCount(speechCountPerNight, label);
  return {
    speechCountPerParticipant: count,
    remainingByParticipant: Object.fromEntries(participantIds.map((id) => [id, count])),
  };
}

export function getPrivateConversationRemaining(session, playerId) {
  return Number(session?.remainingByParticipant?.[playerId] ?? 0);
}

export function getPrivateConversationEligibleSpeakerIds(session) {
  return (session?.participantIds ?? []).filter((id) => getPrivateConversationRemaining(session, id) > 0);
}

export function consumePrivateConversationSpeech(session, playerId) {
  if (!(session?.participantIds ?? []).includes(playerId)) throw new RangeError('機密会話参加者ではありません。');
  const remaining = getPrivateConversationRemaining(session, playerId);
  if (remaining <= 0) throw new RangeError('この参加者の機密会話発言回数は残っていません。');
  session.remainingByParticipant[playerId] = remaining - 1;
  return session.remainingByParticipant[playerId];
}

export function isPrivateConversationComplete(session) {
  return getPrivateConversationEligibleSpeakerIds(session).length === 0;
}
