/**
 * 責務: 順番制を既存契約のまま隔離し、指名制・発言希望制だけに追加された発言順制御を検証する。
 * 変更ルール: orderedへ専用キー・専用タスク・専用プロンプトを混入させず、designated/freeの発言権保証と非公開制御だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import {
  initializeDiscussion,
  recordDiscussionOpeningPreference,
  recordHumanPriorityAnswer,
  recordHumanSpeech,
  recordAiSpeech,
  recordSpeechPass,
} from '../../../app/renderer/js/domain/discussion/discussionRuntime.js';
import { getCurrentGmTask } from '../../../app/renderer/js/domain/game/workflow.js';
import { resolveAutomaticAction } from '../../../app/renderer/js/domain/game/automaticActionPolicy.js';
import { evaluateAiTaskCandidate, prepareAiTask } from '../../../app/renderer/js/services/aiTaskService.js';
import { resolveGenerationPlan } from '../../../app/renderer/js/services/generationDepthPolicy.js';
import { getResponseTopLevelKeys } from '../../../app/renderer/js/prompts/response/responseContract.js';

function prepareDiscussion(mode, { playerCount = 4, speechCountPerDay = 2 } = {}) {
  const state = createInitialState(playerCount);
  state.game.rules.discussion.mode = mode;
  state.game.rules.discussion.answerPriorityEnabled = true;
  state.game.rules.speechCountPerDay = speechCountPerDay;
  initializeDiscussion(state);
  return state;
}

function fullPrompt(artifact) {
  return `${artifact.systemInstruction}\n${artifact.text}`;
}

test('順番制は既存speech契約とプロンプトを維持し専用議論制御を一切含めない', () => {
  const state = prepareDiscussion('ordered');
  const firstId = state.players[0].id;
  assert.equal(state.discussion.modeControl, null);
  assert.equal(getCurrentGmTask(state).type, 'speech');
  assert.deepEqual(getResponseTopLevelKeys('speech'), [
    'publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims',
    'decisionPatch', 'factionStrategyUpdate', 'heartVoice', 'memoAdd',
  ]);

  const artifact = prepareAiTask(state, { playerId: firstId, taskType: 'speech' });
  const prompt = fullPrompt(artifact);
  for (const forbidden of [
    'openingPreference', 'nextSpeakerPreference', 'discussionPreference',
    'EARLY', 'WAIT_CO', 'DONE',
  ]) {
    assert.equal(prompt.includes(forbidden), false, `ordered promptへ${forbidden}を混入させない`);
  }

  assert.equal(recordHumanSpeech(state, {
    playerId: firstId,
    content: '順番制の通常発言',
    nextSpeakerPreference: state.players[3].id,
  }).ok, false);
  assert.equal(state.discussion.queue[1], state.players[1].id);
});

test('指名制は各巡で全員一回を保証し未発言者への指名だけを直後へ前倒しする', () => {
  const state = prepareDiscussion('designated', { speechCountPerDay: 2 });
  const [a, b, c, d] = state.players.map((player) => player.id);
  assert.equal(getCurrentGmTask(state).type, 'speech-designated');
  assert.deepEqual(state.discussion.queue, [a, b, c, d]);

  assert.equal(recordHumanSpeech(state, {
    playerId: a,
    content: 'Dさんから聞きたい。',
    nextSpeakerPreference: d,
  }).ok, true);
  assert.deepEqual(state.discussion.queue, [a, d, b, c]);
  assert.equal(state.discussion.designatedPlayerId, d);

  assert.equal(recordHumanSpeech(state, {
    playerId: d,
    content: 'Aさんへ返します。',
    nextSpeakerPreference: a,
  }).ok, true);
  assert.deepEqual(state.discussion.queue, [a, d, b, c], '既発言Aへの指名では順番を変えない');
  assert.equal(state.discussion.designatedPlayerId, b);

  assert.equal(recordHumanSpeech(state, { playerId: b, content: 'B発言' }).ok, true);
  assert.equal(recordHumanSpeech(state, { playerId: c, content: 'C発言' }).ok, true);
  assert.equal(state.discussion.round, 2);
  assert.deepEqual(state.discussion.queue, [a, b, c, d]);
  assert.deepEqual(state.discussion.spokenInCurrentRound, []);

  for (const playerId of [a, b, c, d]) {
    assert.equal(recordHumanSpeech(state, { playerId, content: `2巡目 ${playerId}` }).ok, true);
  }
  assert.equal(state.discussion.completed, true);
  assert.equal(Object.values(state.discussion.remainingByPlayer).every((value) => value === 0), true);
});

test('発言希望制は全員の開始希望を非公開で集めてから1巡目を開始し全員発言を必須にする', () => {
  const state = prepareDiscussion('free');
  const [a, b, c, d] = state.players.map((player) => player.id);

  assert.equal(state.discussion.modeControl.stage, 'opening-preference');
  assert.deepEqual(state.discussion.queue, []);
  assert.deepEqual(getCurrentGmTask(state), {
    type: 'discussion-opening-preference',
    label: '発言希望制・開始時発言希望',
    playerId: a,
  });

  assert.equal(recordDiscussionOpeningPreference(state, { playerId: a, preference: 'EARLY' }).ok, true);
  assert.equal(recordDiscussionOpeningPreference(state, { playerId: b, preference: 'NORMAL' }).ok, true);
  assert.equal(recordDiscussionOpeningPreference(state, { playerId: c, preference: 'WAIT_CO' }).ok, true);
  assert.equal(state.discussion.queue.length, 0, '全員分が揃う前は公開発言キューを作らない');
  assert.equal(recordDiscussionOpeningPreference(state, { playerId: d, preference: 'WAIT_CO' }).ok, true);

  assert.equal(state.discussion.modeControl.stage, 'discussion');
  assert.equal(state.discussion.queue[0], a);
  assert.equal(state.discussion.queue[1], b);
  assert.deepEqual(new Set(state.discussion.queue.slice(2)), new Set([c, d]));
  assert.equal(getCurrentGmTask(state).type, 'speech-free');
  assert.equal(recordSpeechPass(state, { playerId: a }).ok, false, '発言希望制の通常発言はパスできない');
  assert.equal(state.events.length, 0, '発言順希望自体は公開イベントへ記録しない');
});

test('発言希望制も1日あたり発言回数を上限にして全員到達後は投票開始へ進む', () => {
  const state = prepareDiscussion('free', { speechCountPerDay: 2 });
  for (const player of state.players) {
    assert.equal(recordDiscussionOpeningPreference(state, { playerId: player.id, preference: 'NORMAL' }).ok, true);
  }
  assert.equal(Object.values(state.discussion.remainingByPlayer).every((value) => value === 2), true);

  for (let round = 1; round <= 2; round += 1) {
    const queue = [...state.discussion.queue];
    for (const playerId of queue) {
      assert.equal(recordHumanSpeech(state, {
        playerId,
        content: `${round}巡目 ${playerId}`,
        discussionPreference: 'NORMAL',
      }).ok, true);
    }
  }

  assert.equal(state.discussion.completed, true);
  assert.equal(Object.values(state.discussion.remainingByPlayer).every((value) => value === 0), true);
  assert.equal(getCurrentGmTask(state).type, 'discussion-complete');
  const action = resolveAutomaticAction(state);
  assert.equal(action.kind, 'command');
  assert.equal(action.command, 'begin-vote');
});

test('発言希望制は次巡希望で並べ、DONE後も個人質問への回答だけ許可して全員DONEで終了する', () => {
  const state = prepareDiscussion('free');
  const [a, b, c, d] = state.players.map((player) => player.id);
  for (const [playerId, preference] of [[a, 'EARLY'], [b, 'NORMAL'], [c, 'WAIT_CO'], [d, 'WAIT_CO']]) {
    assert.equal(recordDiscussionOpeningPreference(state, { playerId, preference }).ok, true);
  }

  const nextPreference = new Map([
    [a, 'DONE'],
    [b, 'EARLY'],
    [c, 'DONE'],
    [d, 'WAIT_CO'],
  ]);
  const firstRoundQueue = [...state.discussion.queue];
  for (const playerId of firstRoundQueue) {
    assert.equal(recordHumanSpeech(state, {
      playerId,
      content: `1巡目 ${playerId}`,
      discussionPreference: nextPreference.get(playerId),
    }).ok, true);
  }

  assert.equal(state.discussion.round, 2);
  assert.deepEqual(state.discussion.queue, [b, d]);
  assert.deepEqual(new Set(state.discussion.modeControl.donePlayerIds), new Set([a, c]));

  const freeArtifact = prepareAiTask(state, { playerId: b, taskType: 'speech-free' });
  assert.ok(freeArtifact.internalReasoningDirective, '発言希望制でも非公開参考視点を解決する');
  assert.deepEqual(
    freeArtifact.stageSource.internalReasoningDirective,
    freeArtifact.internalReasoningDirective,
    '多段生成用stageSourceへ解決済み参考視点を引き継ぐ',
  );
  const prompt = fullPrompt(freeArtifact);
  for (const privateKey of ['openingPreferenceByPlayerId', 'nextPreferenceByPlayerId', 'donePlayerIds']) {
    assert.equal(prompt.includes(privateKey), false, `${privateKey}を他AIのプロンプトへ出さない`);
  }

  assert.equal(recordHumanSpeech(state, {
    playerId: b,
    content: 'Aさんに確認したい。',
    questionTargetId: a,
    discussionPreference: 'DONE',
  }).ok, true);
  const answerTask = getCurrentGmTask(state);
  assert.equal(answerTask.type, 'priority-answer');
  assert.equal(answerTask.playerId, a, 'DONE済みでも個人質問には回答する');
  assert.equal(recordHumanPriorityAnswer(state, {
    playerId: a,
    questionEventId: answerTask.questionEventId,
    content: 'Aからの回答',
  }).ok, true);
  assert.equal(state.discussion.modeControl.donePlayerIds.includes(a), true, '回答後もDONEを維持する');
  assert.deepEqual(state.discussion.queue, [b, d], '回答によって通常キューへ復帰させない');

  assert.equal(recordHumanSpeech(state, {
    playerId: d,
    content: 'Dの最終発言',
    discussionPreference: 'DONE',
  }).ok, true);
  assert.equal(state.discussion.completed, true);
  assert.equal(getCurrentGmTask(state).type, 'discussion-complete');

  const publicEvents = JSON.stringify(state.events);
  assert.equal(publicEvents.includes('discussionPreference'), false);
  assert.equal(publicEvents.includes('openingPreference'), false);
});


test('モード別AI応答は専用制御値だけを解決し、それぞれのDomain進行へ登録できる', () => {
  const designated = prepareDiscussion('designated');
  const [a, , , d] = designated.players;
  const designatedArtifact = prepareAiTask(designated, { playerId: a.id, taskType: 'speech-designated' });
  const designatedEvaluation = evaluateAiTaskCandidate(designated, designatedArtifact, JSON.stringify({
    publicSpeech: 'Dさんから聞きたいです。',
    nextSpeakerPreference: d.name,
  }));
  assert.equal(designatedEvaluation.ok, true);
  assert.equal(designatedEvaluation.validation.resolvedNextSpeakerPreferenceId, d.id);
  assert.equal(recordAiSpeech(designated, {
    playerId: a.id,
    content: designatedEvaluation.parsed.publicSpeech,
    rawResponse: JSON.stringify(designatedEvaluation.candidateObject),
    nextSpeakerPreference: designatedEvaluation.validation.resolvedNextSpeakerPreferenceId,
    aiTaskType: 'speech-designated',
  }).ok, true);
  assert.equal(designated.discussion.designatedPlayerId, d.id);

  const free = prepareDiscussion('free');
  for (const player of free.players) {
    assert.equal(recordDiscussionOpeningPreference(free, { playerId: player.id, preference: 'NORMAL' }).ok, true);
  }
  const freeSpeakerId = free.discussion.designatedPlayerId;
  const freeArtifact = prepareAiTask(free, { playerId: freeSpeakerId, taskType: 'speech-free' });
  const freeEvaluation = evaluateAiTaskCandidate(free, freeArtifact, JSON.stringify({
    publicSpeech: '現時点の考えは話し切りました。',
    discussionPreference: 'DONE',
  }));
  assert.equal(freeEvaluation.ok, true);
  assert.equal(freeEvaluation.validation.resolvedDiscussionPreference, 'DONE');
  assert.equal(recordAiSpeech(free, {
    playerId: freeSpeakerId,
    content: freeEvaluation.parsed.publicSpeech,
    rawResponse: JSON.stringify(freeEvaluation.candidateObject),
    discussionPreference: freeEvaluation.validation.resolvedDiscussionPreference,
    aiTaskType: 'speech-free',
  }).ok, true);
  assert.equal(free.discussion.modeControl.donePlayerIds.includes(freeSpeakerId), true);
});

test('発言希望制の開始希望はDONEをNORMALへ補正し、専用生成は常に1工程だけ使う', () => {
  const state = prepareDiscussion('free');
  const playerId = state.players[0].id;
  const response = recordDiscussionOpeningPreference(state, { playerId, preference: 'DONE' });
  assert.equal(response.ok, true);
  assert.equal(response.preference, 'NORMAL');

  const ownerProfile = {
    id: 'profile-main',
    label: 'main',
    enabled: true,
    generation: { depth: 4, taskOverrides: { speech: 4 } },
  };
  const plan = resolveGenerationPlan({
    ownerProfile,
    profiles: [ownerProfile],
    taskType: 'discussion-opening-preference',
  });
  assert.equal(plan.depth, 1);
  assert.deepEqual(plan.stages.map((stage) => stage.stageId), ['direct']);
});

test('自動実行は発言希望制の開始希望をAIなら非公開AIタスク、人間なら非公開入力待ちとして扱う', () => {
  const aiState = prepareDiscussion('free');
  const aiAction = resolveAutomaticAction(aiState);
  assert.equal(aiAction.kind, 'ai-task');
  assert.equal(aiAction.taskRequest.taskType, 'discussion-opening-preference');

  const humanState = prepareDiscussion('free');
  humanState.players[0].controller = 'human';
  const humanAction = resolveAutomaticAction(humanState);
  assert.equal(humanAction.kind, 'human-private');
  assert.equal(humanAction.taskType, 'discussion-opening-preference');
});
