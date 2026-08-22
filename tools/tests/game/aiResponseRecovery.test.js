/**
 * 責務: AI応答の自動修復と必須項目fallbackを、通常成功経路とは分離した回復専用契約として検証する。
 * 変更ルール: 回復処理の成功をプロンプト品質や通常AI応答の成功として数えない。生回答を改変しない通常経路はproductionPlaythrough.test.jsで検証し、本ファイルでは修復・代替が明示的に要求された場合だけを扱う。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDiscussion, finishDiscussion } from '../../../app/renderer/js/domain/discussion/discussionRuntime.js';
import { beginVote } from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { prepareAiTask, evaluateAiTaskCandidate } from '../../../app/renderer/js/services/aiTaskService.js';

function prepareVoteState(state) {
  state.game.day = 1;
  initializeDiscussion(state);
  assert.equal(finishDiscussion(state).ok, true);
  assert.equal(beginVote(state).ok, true);
}

test('コードフェンス・キー誤字・任意nullを自動補正して受理する', () => {
  const state = createInitialState(6);
  const playerId = state.players[0].id;
  const artifact = prepareAiTask(state, { playerId, taskType: 'speech' });
  const raw = '```json\n{"publicSpech":"公開文","heartVoice":null}\n```';
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.candidateObject.publicSpeech, '公開文');
  assert.equal(Object.hasOwn(evaluation.candidateObject, 'heartVoice'), false);
  assert.equal(evaluation.autoRepair.accepted, true);
  assert.ok(evaluation.autoRepair.operations.some((item) => item.code === 'CODE_FENCE_REMOVED'));
  assert.ok(evaluation.autoRepair.operations.some((item) => item.code === 'KEY_TYPO_RENAMED'));
});

test('任意構造のnull除去・列挙正規化・重複除去を未定義参照なしで完了する', async () => {
  const { repairAiResponseCandidate } = await import('../../../app/renderer/js/prompts/response/responseAutoRepair.js');
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const raw = JSON.stringify({
    publicSpeech: '公開文',
    coOperation: {
      action: ' DECLARE ',
      roleId: ' SEER ',
    },
    abilityClaims: [
      {
        intent: ' DECEPTION ',
        roleId: ' SEER ',
        resultDay: '1',
        target: target.name,
        result: ' NOT-WOLF ',
        selectionBasis: null,
        evidenceRefs: null,
        selectionReasonAtTime: null,
      },
      {
        intent: ' DECEPTION ',
        roleId: ' SEER ',
        resultDay: '1',
        target: target.name,
        result: ' NOT-WOLF ',
        selectionBasis: null,
        evidenceRefs: null,
        selectionReasonAtTime: null,
      },
    ],
  });

  const repaired = repairAiResponseCandidate(state, {
    mode: 'speech',
    taskType: 'speech',
    playerId: actor.id,
    validTargetIds: [],
  }, raw);
  const candidate = JSON.parse(repaired.repairedRawResponse);

  assert.deepEqual(candidate.coOperation, { action: 'declare', roleId: 'seer' });
  assert.deepEqual(candidate.abilityClaims, [{
    intent: 'deception',
    roleId: 'seer',
    resultDay: 1,
    target: target.name,
    result: 'not-wolf',
  }]);
});

test('座敷わらしCOのcanonical roleIdを小文字化せず構造化COとして保持する', async () => {
  const { repairAiResponseCandidate } = await import('../../../app/renderer/js/prompts/response/responseAutoRepair.js');
  const state = createInitialState(6);
  const actor = state.players[0];
  state.game.publicRoleComposition = {
    zashikiWarashi: 1,
    villager: 3,
    wolf: 1,
    seer: 1,
  };
  const raw = JSON.stringify({
    publicSpeech: '座敷わらしCOです。',
    coOperation: {
      action: 'declare',
      roleId: 'zashikiWarashi',
    },
  });

  const repaired = repairAiResponseCandidate(state, {
    mode: 'speech',
    taskType: 'speech',
    playerId: actor.id,
    validTargetIds: [],
  }, raw);
  const candidate = JSON.parse(repaired.repairedRawResponse);

  assert.deepEqual(candidate.coOperation, { action: 'declare', roleId: 'zashikiWarashi' });
  assert.equal(repaired.operations.some((item) => item.code === 'INVALID_CO_ROLE_REMOVED'), false);
});

test('必須行動項目だけを代替し回収済み任意項目を保持する', async () => {
  const { buildRequiredFieldFallbackCandidate } = await import('../../../app/renderer/js/services/aiTaskFallbackService.js');
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const artifact = {
    playerId: actor.id,
    taskType: 'vote',
    mode: 'vote',
    validTargetIds: [target.id],
  };
  const evaluation = {
    candidateObject: {
      memoAdd: 'このメモはAI生成結果として保持する',
      rationale: 'この理由も保持する',
    },
    issues: [{ path: 'response.actionAnswer', message: '必須項目がありません。' }],
  };

  const fallback = buildRequiredFieldFallbackCandidate(state, artifact, evaluation, { random: () => 0 });

  assert.equal(fallback.ok, true);
  assert.equal(fallback.candidateObject.actionAnswer, target.name);
  assert.equal(fallback.candidateObject.memoAdd, 'このメモはAI生成結果として保持する');
  assert.equal(fallback.candidateObject.rationale, 'この理由も保持する');
  assert.deepEqual(fallback.fallbackFields, [{
    key: 'actionAnswer',
    strategy: 'random-valid-target',
    targetId: target.id,
    value: target.name,
  }]);
});

test('投票先が有効なら不正な任意陣営戦略だけを破棄して受理する', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  actor.roleId = 'wolf';
  state.playerKnowledge[actor.id] = {
    knownWolfIds: [actor.id],
    knownMadmanIds: [],
    knownMasonIds: [],
    roleNotifiedAt: null,
    knowledgeRevision: 0,
  };
  prepareVoteState(state);
  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'vote' });
  const raw = JSON.stringify({
    actionAnswer: target.name,
    factionStrategy: {
      mode: 'patch',
      changes: { partnerDisposition: 'separate' },
    },
  });
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.candidateObject.actionAnswer, target.name);
  assert.equal(Object.hasOwn(evaluation.candidateObject, 'factionStrategy'), false);
  assert.ok((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'INVALID_OPTIONAL_FIELD_DISCARDED'));
});

test('投票必須項目の代替は投票予定、処刑価値候補、ランダムの順で選ぶ', async () => {
  const { buildRequiredFieldFallbackCandidate } = await import('../../../app/renderer/js/services/aiTaskFallbackService.js');
  const state = createInitialState(6);
  const actor = state.players[0];
  const first = state.players[1];
  const second = state.players[2];
  const artifact = { playerId: actor.id, taskType: 'vote', mode: 'vote', validTargetIds: [first.id, second.id] };
  const evaluation = { candidateObject: {}, issues: [{ path: 'response.actionAnswer' }] };

  actor.decisionState.intendedVoteId = second.id;
  actor.decisionState.executionCandidateIds = [first.id];
  let fallback = buildRequiredFieldFallbackCandidate(state, artifact, evaluation, { random: () => 0 });
  assert.equal(fallback.fallbackFields[0].strategy, 'decision-intended-vote');
  assert.equal(fallback.fallbackFields[0].targetId, second.id);

  actor.decisionState.intendedVoteId = null;
  fallback = buildRequiredFieldFallbackCandidate(state, artifact, evaluation, { random: () => 0.99 });
  assert.equal(fallback.fallbackFields[0].strategy, 'decision-execution-candidate');
  assert.equal(fallback.fallbackFields[0].targetId, first.id);

  actor.decisionState.executionCandidateIds = [];
  fallback = buildRequiredFieldFallbackCandidate(state, artifact, evaluation, { random: () => 0.99 });
  assert.equal(fallback.fallbackFields[0].strategy, 'random-valid-target');
  assert.equal(fallback.fallbackFields[0].targetId, second.id);
});
