/**
 * 責務: 公開質問の現在正本・対象・回答済み・スキップ済み・未解決状態を、訂正系列を含めて構造化情報だけから判定できることを確認する。
 * 変更ルール: 発言本文の自然言語解析や表示文言には依存せず、質問先・回答参照・解決イベントの正本だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordHumanPriorityAnswer,
  recordHumanSpeech,
  skipPriorityAnswer,
} from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import {
  getUnresolvedPublicQuestionsForPlayer,
  isPublicQuestionAnswered,
  isPublicQuestionResolved,
  isPublicQuestionSkipped,
  resolveCurrentPublicQuestionEvent,
} from '../../../app/renderer/js/domain/discussion/publicQuestionResolution.js';
import { correctPublicEventWithMode } from '../../../app/renderer/js/domain/correction/correctionCommands.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { synchronizePlayerKnowledgeForTest } from './testStateHelpers.js';

function fixture() {
  const state = createInitialState(4);
  state.game.phase = 'discussion';
  state.game.day = 1;
  const ids = state.players.map((player) => player.id);
  state.discussion = {
    day: 1,
    mode: 'ordered',
    modeControl: null,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: [...ids],
    queue: [ids[0], ids[2], ids[1], ids[3]],
    currentIndex: 0,
    designatedPlayerId: null,
    spokenInCurrentRound: [],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])),
    allDeferred: false,
    remainingByPlayer: Object.fromEntries(ids.map((id) => [id, 2])),
    reconsideration: {
      pending: false,
      active: false,
      items: [],
      reasons: [],
      sourceEventIds: [],
      affectedPlayerIds: [],
      updatedAt: null,
      handledRound: null,
    },
    completed: false,
  };
  synchronizePlayerKnowledgeForTest(state);
  return { state, ids };
}

function ask(state, fromId, targetId) {
  const result = recordHumanSpeech(state, {
    playerId: fromId,
    content: '判断理由を説明してください。',
    coOperation: { action: 'none', roleId: 'none' },
    questionTargetId: targetId,
  });
  assert.equal(result.ok, true, result.message);
  return state.events.find((event) => event.id === result.eventId);
}

test('未回答質問は対象者の未解決一覧へ入り、回答後は回答済みとして除外される', () => {
  const invalidFixture = fixture();
  const invalidCorrection = correctPublicEventWithMode(invalidFixture.state, {
    targetEventId: 'missing-event',
    reason: '存在しない対象の確認',
    replacementText: '訂正文',
  });
  assert.equal(invalidCorrection.ok, false);
  assert.equal(invalidFixture.state.game.correctionMode.enabled, false, '訂正に失敗した場合は一時的に開始した訂正モードを残さない');

  const { state, ids } = fixture();
  const question = ask(state, ids[0], ids[1]);
  assert.deepEqual(getUnresolvedPublicQuestionsForPlayer(state, ids[1]).map((event) => event.id), [question.id]);
  assert.equal(isPublicQuestionResolved(state, question, ids[1]), false);

  const answer = recordHumanPriorityAnswer(state, {
    playerId: ids[1],
    questionEventId: question.id,
    content: '公開情報を比較した結果です。',
  });
  assert.equal(answer.ok, true, answer.message);
  assert.equal(isPublicQuestionAnswered(state, question, ids[1]), true);
  assert.equal(isPublicQuestionResolved(state, question, ids[1]), true);
  assert.deepEqual(getUnresolvedPublicQuestionsForPlayer(state, ids[1]), []);

  const corrected = correctPublicEventWithMode(state, {
    targetEventId: question.id,
    reason: '質問本文の入力誤り',
    replacementText: '訂正後の質問本文です。',
    replacementQuestionTargetId: 'preserve',
    replacementStructured: null,
  });
  assert.equal(corrected.ok, true, corrected.message);
  assert.equal(state.game.correctionMode.enabled, true, '事前操作なしで訂正モードへ入り公開済み内容を訂正する');
  assert.equal(state.events.find((event) => event.id === question.id).status, 'voided');
  assert.ok(state.events.some((event) => event.type === 'correction' && event.payload.reason === '質問本文の入力誤り'));
  assert.ok(state.events.some((event) => event.type === 'public-speech' && event.payload.correctsEventId === question.id && event.payload.text === '訂正後の質問本文です。'));
});


