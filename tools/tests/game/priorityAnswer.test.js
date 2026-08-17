/**
 * 責務: 回答優先モードが通常議論の順番・発言数を消費せず単一の個人質問へ回答し、次の通常発言者が質問先の場合は回答を通常発言へ統合し、心の声と通常議論同等のCO判断材料を保持することを検証する。
 * 変更ルール: 公開本文解析へ依存せず、質問先・回答元の構造化情報、次発言者への回答統合、心の声任意契約、役職・戦術情報の可視投影、公開イベントから導出される挙動だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordAiSpeech,
  recordAiPriorityAnswer,
  recordHumanPriorityAnswer,
  recordHumanSpeech,
  recordSpeechPass,
  skipAiPriorityAnswer,
  skipPriorityAnswer,
} from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import { getCurrentGmTask } from '../../../app/renderer/js/domain/game/workflow.js';
import { beginVote, correctPublicSpeech, enterCorrectionMode, exitCorrectionMode } from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { prepareAiTask, evaluateAiTaskCandidate } from '../../../app/renderer/js/services/aiTaskService.js';
import { buildResponseExampleReferences } from '../../../app/renderer/js/prompts/response/responseExampleReferences.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';
import { isFactionStrategyRole } from '../../../app/renderer/js/domain/game/factionStrategyState.js';
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

test('最終巡の優先回答は本人最終発言の前後どちらでも通常発言と同じ処刑判断粒度を使う', () => {
  for (const remaining of [1, 0]) {
    const { state, ids } = independentPriorityFixture();
    state.game.day = 2;
    state.discussion.day = 2;
    state.discussion.round = 3;
    state.discussion.remainingByPlayer[ids[1]] = remaining;
    state.players[1].roleId = 'villager';
    synchronizePlayerKnowledgeForTest(state);

    const question = recordHumanSpeech(state, {
      playerId: ids[0],
      content: remaining === 1 ? '最終発言の前に、今日の処刑候補をどう見ていますか。' : '最終発言後ですが、今日の処刑候補をどう見ていますか。',
      coOperation: { action: 'none', roleId: 'none' },
      questionTargetId: ids[1],
    });
    assert.equal(question.ok, true, question.message);
    const task = getCurrentGmTask(state);
    assert.equal(task.type, 'priority-answer');
    assert.equal(task.playerId, ids[1]);

    const artifact = prepareAiTask(state, { playerId: ids[1], taskType: 'priority-answer', slotId: question.eventId });
    assert.doesNotMatch(artifact.promptEnvelope.taskInvariantContext, /## 処刑判断/u);
    assert.match(artifact.promptEnvelope.taskVariableContext, /最終巡です。投票時と同じ処刑比較/u);
    assert.match(artifact.promptEnvelope.taskVariableContext, /説明できる差が処刑優先度を分ける場合だけ現時点のintendedVoteを設定/u);
    assert.match(artifact.promptEnvelope.taskVariableContext, /差がなければ未定のままで構いません/u);
    assert.match(artifact.promptEnvelope.taskVariableContext, /## 処刑判断/u);
    assert.match(artifact.promptEnvelope.taskVariableContext, /村人陣営では、対象が人狼でなかった場合の損失/u);
    assert.match(artifact.stageSource.roleTaskData.promptGuidance.executionValuePolicy, /## 処刑判断/u);
    assert.match(artifact.stageSource.roleTaskData.promptGuidance.executionFactionPolicy, /村人陣営では/u);
  }

  const { state, ids } = independentPriorityFixture();
  state.game.day = 2;
  state.discussion.day = 2;
  state.discussion.round = 2;
  state.discussion.remainingByPlayer[ids[1]] = 2;
  state.players[1].roleId = 'villager';
  synchronizePlayerKnowledgeForTest(state);
  const question = recordHumanSpeech(state, {
    playerId: ids[0],
    content: 'まだ中盤ですが、今の見方を教えてください。',
    coOperation: { action: 'none', roleId: 'none' },
    questionTargetId: ids[1],
  });
  assert.equal(question.ok, true, question.message);
  assert.equal(getCurrentGmTask(state).type, 'priority-answer');
  const earlierArtifact = prepareAiTask(state, { playerId: ids[1], taskType: 'priority-answer', slotId: question.eventId });
  assert.doesNotMatch(earlierArtifact.promptEnvelope.taskVariableContext, /最終巡です/u);
  assert.doesNotMatch(earlierArtifact.promptEnvelope.taskVariableContext, /## 処刑判断/u);
});

test('質問先が次の通常発言者なら独立回答フェーズを省略しAI通常発言へ回答参照を統合する', () => {
  const { state, ids } = discussionFixture();
  const question = recordHumanSpeech(state, {
    playerId: ids[0],
    content: '次の発言で判断理由を説明してください。',
    coOperation: { action: 'none', roleId: 'none' },
    questionTargetId: ids[1],
  });
  assert.equal(question.ok, true, question.message);
  assert.equal(state.discussion.currentIndex, 1);

  const task = getCurrentGmTask(state);
  assert.equal(task.type, 'speech');
  assert.equal(task.playerId, ids[1]);

  const artifact = prepareAiTask(state, {
    playerId: ids[1],
    taskType: 'speech',
  });
  assert.deepEqual(artifact.context.task.normalSpeechAnswers, [{
    questionEventId: question.eventId,
    questionSequence: state.events.find((event) => event.id === question.eventId).sequence,
    askerId: ids[0],
    askerName: state.players[0].name,
    questionText: '次の発言で判断理由を説明してください。',
  }]);
  assert.match(artifact.text, /requiredAnswers/u);
  assert.match(artifact.text, /current-task.requiredAnswersの全件へ今回の通常発言内で直接答え/u);

  const missingSpeech = evaluateAiTaskCandidate(state, artifact, JSON.stringify({ heartVoice: '回答内容を考えている。' }));
  assert.equal(missingSpeech.ok, false);
  assert.match(JSON.stringify(missingSpeech), /publicSpeech/u);

  const answer = recordAiSpeech(state, {
    playerId: ids[1],
    content: '公開された発言を比較して判断したためです。',
    speechInteraction: {
      questionTargetIds: [],
      answersEventIds: [],
    },
  });
  assert.equal(answer.ok, true, answer.message);
  const answerEvent = state.events.find((event) => event.id === answer.eventId);
  assert.equal(answerEvent.payload.speechKind, 'normal');
  assert.deepEqual(answerEvent.payload.structured.interaction.answersEventIds, [question.eventId]);
  assert.equal(state.discussion.remainingByPlayer[ids[1]], 1, '統合回答は通常発言数を1回消費する');
  assert.equal(getCurrentGmTask(state).type, 'speech');
  assert.equal(getCurrentGmTask(state).playerId, ids[2]);
  const validation = validateImportedState(state);
  assert.equal(validation.ok, true, validation.errors?.join('\n'));
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
