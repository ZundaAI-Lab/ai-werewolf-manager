/**
 * 責務: 夜間機密会話の共通発言順が、会話種別に依存せず参加者順のround-robinと連続発言防止を維持することを検証する。
 * 変更ルール: 人狼・共有者・墓場の固有参加資格は各専用テストへ委譲し、ここでは共通ポリシーだけを検査する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canPrivateConversationSpeakerTakeTurn,
  consumePrivateConversationSpeech,
  createPrivateConversationProgress,
  getPrivateConversationNextSpeakerId,
} from '../../../app/renderer/js/domain/night/privateConversationPolicy.js';

function session(participantIds = ['a', 'b', 'c'], count = 2) {
  return {
    participantIds: [...participantIds],
    messages: [],
    ...createPrivateConversationProgress(participantIds, count, 'テスト会話'),
  };
}

function speak(current, speakerId) {
  current.messages.push({ speakerId });
  consumePrivateConversationSpeech(current, speakerId);
}

test('機密会話の通常次話者は参加者順に一巡してから次の巡へ戻る', () => {
  const current = session();
  assert.equal(getPrivateConversationNextSpeakerId(current), 'a');

  speak(current, 'a');
  assert.equal(getPrivateConversationNextSpeakerId(current), 'b');
  speak(current, 'b');
  assert.equal(getPrivateConversationNextSpeakerId(current), 'c');
  speak(current, 'c');
  assert.equal(getPrivateConversationNextSpeakerId(current), 'a');
});

test('他に発言可能者がいる間は同一人物の連続発言を許可せず、一人だけ残れば連続を許可する', () => {
  const current = session();
  speak(current, 'a');
  assert.equal(canPrivateConversationSpeakerTakeTurn(current, 'a'), false);
  assert.equal(canPrivateConversationSpeakerTakeTurn(current, 'b'), true);
  assert.equal(canPrivateConversationSpeakerTakeTurn(current, 'c'), true, 'GMは次番以外の別参加者を選べる');

  current.remainingByParticipant.b = 0;
  current.remainingByParticipant.c = 0;
  assert.equal(canPrivateConversationSpeakerTakeTurn(current, 'a'), true, '発言可能者が一人だけなら残り回数を続けて消費できる');
  assert.equal(getPrivateConversationNextSpeakerId(current), 'a');
});
