/**
 * 責務: 回答優先モードが通常議論の順番・発言数を消費せず未回答質問を処理し、未回答中の投票遷移を止め、スキップ時も最新判断を正しく反映することを検証する。
 * 変更ルール: 公開本文解析やプロンプト文言へ依存せず、質問先・回答元の構造化情報、進行ブロック、判断状態の更新だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordHumanPriorityAnswer,
  recordHumanSpeech,
  skipAiPriorityAnswer,
} from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import { getCurrentGmTask } from '../../../app/renderer/js/domain/game/workflow.js';
import { beginVote } from '../../../app/renderer/js/domain/game/gameRuntime.js';


import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';

import { synchronizePlayerKnowledgeForTest } from './testStateHelpers.js';

function discussionFixture({ remaining = null } = {}) {
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
    queue: [...ids],
    currentIndex: 0,
    designatedPlayerId: null,
    spokenInCurrentRound: [],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])),
    allDeferred: false,
    remainingByPlayer: remaining ?? Object.fromEntries(ids.map((id) => [id, 2])),
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

function independentPriorityFixture(options = {}) {
  const fixture = discussionFixture(options);
  const { state, ids } = fixture;
  state.discussion.queue = [ids[0], ids[2], ids[1], ids[3]];
  state.discussion.currentIndex = 0;
  return fixture;
}

test('回答優先モードは既定で有効で、発言数0の個人質問先へ無料回答を割り込ませる', () => {
  const { state, ids } = discussionFixture();
  state.discussion.remainingByPlayer = {
    [ids[0]]: 1,
    [ids[1]]: 0,
    [ids[2]]: 1,
    [ids[3]]: 1,
  };
  assert.equal(state.game.rules.discussion.answerPriorityEnabled, true);

  const question = recordHumanSpeech(state, {
    playerId: ids[0],
    content: '昨日の判断理由を説明してください。',
    coOperation: { action: 'none', roleId: 'none' },
    questionTargetId: ids[1],
  });
  assert.equal(question.ok, true, question.message);
  assert.equal(state.discussion.currentIndex, 2, '通常の次発言者は発言数0の質問先を飛ばして確定する');
  const remainingBeforeAnswer = structuredClone(state.discussion.remainingByPlayer);
  const spokenBeforeAnswer = [...state.discussion.spokenInCurrentRound];

  const task = getCurrentGmTask(state);
  assert.equal(task.type, 'priority-answer');
  assert.equal(task.playerId, ids[1]);
  assert.equal(task.questionEventId, question.eventId);

  const answer = recordHumanPriorityAnswer(state, {
    playerId: ids[1],
    questionEventId: question.eventId,
    content: '公開情報の前提を確認したかったためです。',
  });
  assert.equal(answer.ok, true, answer.message);
  assert.deepEqual(state.discussion.remainingByPlayer, remainingBeforeAnswer);
  assert.deepEqual(state.discussion.spokenInCurrentRound, spokenBeforeAnswer);
  assert.equal(state.discussion.currentIndex, 2);

  const answerEvent = state.events.find((event) => event.id === answer.eventId);
  assert.equal(answerEvent.payload.speechKind, 'priority-answer');
  assert.equal(answerEvent.payload.sourceQuestionEventId, question.eventId);
  assert.deepEqual(answerEvent.payload.structured.interaction, {
    questionTargetIds: [],
    answersEventIds: [question.eventId],
  });
  assert.equal(getCurrentGmTask(state).type, 'speech');
  assert.equal(getCurrentGmTask(state).playerId, ids[2]);
  { const validation = validateImportedState(state); assert.equal(validation.ok, true, validation.errors?.join('\n')); }
});

test('未回答の優先質問が残る間はbeginVoteを直接実行しても投票へ進めない', () => {
  const { state, ids } = discussionFixture();
  state.discussion.queue = [ids[0]];
  state.discussion.roundEligiblePlayerIds = [ids[0]];
  state.discussion.remainingByPlayer = {
    [ids[0]]: 1,
    [ids[1]]: 0,
    [ids[2]]: 0,
    [ids[3]]: 0,
  };
  const question = recordHumanSpeech(state, {
    playerId: ids[0],
    content: '投票前に回答してください。',
    coOperation: { action: 'none', roleId: 'none' },
    questionTargetId: ids[1],
  });
  assert.equal(question.ok, true, question.message);
  assert.equal(state.discussion.completed, true);

  const vote = beginVote(state);
  assert.equal(vote.ok, false);
  assert.match(vote.message, /優先回答/);
  assert.equal(state.game.phase, 'discussion');
  assert.equal(getCurrentGmTask(state).type, 'priority-answer');
});

test('AI優先回答スキップでも最新の疑い判断を即時反映する', () => {
  const { state, ids } = independentPriorityFixture();
  const question = recordHumanSpeech(state, {
    playerId: ids[0],
    content: '現在最も疑っている相手を説明してください。',
    coOperation: { action: 'none', roleId: 'none' },
    questionTargetId: ids[1],
  });
  assert.equal(question.ok, true, question.message);
  assert.equal(getCurrentGmTask(state).type, 'priority-answer');

  const skipped = skipAiPriorityAnswer(state, {
    playerId: ids[1],
    questionEventId: question.eventId,
    reason: 'AI回答本文を取得できませんでした。',
    rawResponse: '{"decisionPatch":{}}',
    decisionUpdate: {
      suspicionCandidateIds: [ids[2]],
      executionCandidateIds: [ids[2]],
      intendedVoteId: ids[2],
      assessmentLevel: 'strong',
      keyPublicEvidenceEventIds: [question.eventId],
      leaveAliveBenefit: '',
      misexecutionCost: '',
      selectionDifference: '',
      uncertainty: '',
      nextDiscriminatingInformation: '',
      decisionReason: '質問を踏まえた最新判断',
      revisionCause: 'response-evaluation',
    },
  });
  assert.equal(skipped.ok, true, skipped.message);
  assert.deepEqual(state.players[1].decisionState.suspicionCandidateIds, [ids[2]]);
  assert.equal(state.players[1].decisionState.sourceAiTurnId, skipped.aiTurnId);
  const validation = validateImportedState(state);
  assert.equal(validation.ok, true, validation.errors?.join('\n'));
});
