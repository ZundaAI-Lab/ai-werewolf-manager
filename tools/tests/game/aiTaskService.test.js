/**
 * 責務: 本番タスク準備と候補評価を共通化し、元JSONの実在キー集合・生成時指紋・保存済み機密状態を次回入力へ再投影しない境界を維持することを検証する。
 * 変更ルール: UIやAPI通信を介さず、既存パーサー・バリデータへ同じ引数を渡す境界だけを確認する。質問関係と陣営戦略の意味を持つ不正値は原則として自動削除・置換せず再生成対象として維持し、投票だけは有効なactionAnswerを守って任意項目を劣化できることを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_DEFINITIONS } from '../../../app/renderer/js/config/constants.js';
import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import { beginVote } from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { shouldCompleteFullPublicHistorySync } from '../../../app/renderer/js/domain/game/aiTurnRegistrationPolicy.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { composeManualAiPrompt, prepareAiTask, evaluateAiTaskCandidate } from '../../../app/renderer/js/services/aiTaskService.js';
import { mergeTextPatch } from '../../../app/renderer/js/prompts/stages/generationStageResponse.js';


function prepareVoteState(state) {
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.discussion = {
    day: 1,
    mode: 'ordered',
    modeControl: null,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: state.players.map((player) => player.id),
    queue: state.players.map((player) => player.id),
    currentIndex: state.players.length,
    remainingByPlayer: Object.fromEntries(state.players.map((player) => [player.id, 0])),
    spokenInCurrentRound: state.players.map((player) => player.id),
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(state.players.map((player) => [player.id, 0])),
    allDeferred: false,
    designatedPlayerId: null,
    completed: true,
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
  };
  assert.equal(beginVote(state).ok, true);
}



test('投票人数分岐はvoteの直接生成・深度3/4草案だけへ渡し非voteタスクへ流さない', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  state.players[4].roleId = 'wolf';
  state.players[5].roleId = 'wolf';

  const speechArtifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  assert.deepEqual(speechArtifact.decision.vote.populationBranches, []);
  assert.deepEqual(speechArtifact.stageSource.roleTaskData.decision.vote.populationBranches, []);

  prepareVoteState(state);
  const voteArtifact = prepareAiTask(state, { playerId: actor.id, taskType: 'vote' });
  assert.ok(voteArtifact.decision.vote.populationBranches.length > 0);
  assert.deepEqual(
    voteArtifact.stageSource.roleTaskData.decision.vote.populationBranches,
    voteArtifact.decision.vote.populationBranches,
  );
});

test('手動送信用プロンプトはAPIと同じ常時システム契約を先頭へ結合する', () => {
  assert.equal(
    composeManualAiPrompt({ systemInstruction: '# 常時契約', text: '# 現在タスク' }),
    '# 常時契約\n\n---\n\n# 現在タスク',
  );
  assert.equal(composeManualAiPrompt({ systemInstruction: '', text: '# 役職通知' }), '# 役職通知');
});


test('保存済みheartVoiceと雪女の過去推定は次回プロンプトへ再投入せず生成・保存契約は維持する', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  actor.roleId = 'snowWoman';
  actor.heartVoice = '前回だけの秘密心情';
  actor.heartVoiceUpdatedAt = '2026-08-13T00:00:00.000Z';
  const estimatedWolfId = state.players[1].id;
  const predictedAttackId = state.players[2].id;
  const frozenTargetId = state.players[3].id;
  state.aiTurns.push({
    id: 'turn-freeze-prior',
    playerId: actor.id,
    taskType: 'freeze',
    day: 1,
    estimatedWerewolfIds: [estimatedWolfId],
    predictedAttackTargetIds: [predictedAttackId],
    parsedActionAnswer: frozenTargetId,
    parsedActionRationale: '前夜はこの対象を凍結した。',
  });

  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const prompt = artifact.promptEnvelope.dynamicTaskPrompt;
  const priorFreeze = artifact.stageSource.privateState.privateLocks.ownHistory.latestFreezeJudgment;

  assert.doesNotMatch(prompt, /latest-heart-voice|前回だけの秘密心情/u);
  assert.doesNotMatch(prompt, /estimatedWerewolves|predictedAttackTargets/u);
  assert.deepEqual(priorFreeze, {
    nightDay: 1,
    targetId: frozenTargetId,
    actionRationale: '前夜はこの対象を凍結した。',
  });
  assert.equal(Object.hasOwn(artifact.stageSource.privateState.privateLocks, 'latestHeartVoice'), false);
  assert.equal(Object.hasOwn(priorFreeze, 'estimatedWerewolfIds'), false);
  assert.equal(Object.hasOwn(priorFreeze, 'predictedAttackTargetIds'), false);

  assert.equal(actor.heartVoice, '前回だけの秘密心情');
  assert.deepEqual(state.aiTurns.at(-1).estimatedWerewolfIds, [estimatedWolfId]);
  assert.deepEqual(state.aiTurns.at(-1).predictedAttackTargetIds, [predictedAttackId]);
  assert.equal(artifact.stageSource.responseContract.allowedTopLevelKeys.includes('heartVoice'), true);
});

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
        roleId: ' SEER ',
        resultDay: '1',
        target: target.name,
        result: ' NOT-WOLF ',
        selectionBasis: null,
        evidenceEventSequences: null,
        selectionReasonAtTime: null,
      },
      {
        roleId: ' SEER ',
        resultDay: '1',
        target: target.name,
        result: ' NOT-WOLF ',
        selectionBasis: null,
        evidenceEventSequences: null,
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
      actionRationale: 'この理由も保持する',
    },
    issues: [{ path: 'response.actionAnswer', message: '必須項目がありません。' }],
  };

  const fallback = buildRequiredFieldFallbackCandidate(state, artifact, evaluation, { random: () => 0 });

  assert.equal(fallback.ok, true);
  assert.equal(fallback.candidateObject.actionAnswer, target.name);
  assert.equal(fallback.candidateObject.memoAdd, 'このメモはAI生成結果として保持する');
  assert.equal(fallback.candidateObject.actionRationale, 'この理由も保持する');
  assert.deepEqual(fallback.fallbackFields, [{
    key: 'actionAnswer',
    strategy: 'random-valid-target',
    targetId: target.id,
    value: target.name,
  }]);
});

test('speechInteractionの内部保存キーを黙って削除せず再生成対象にする', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const raw = JSON.stringify({
    publicSpeech: `${target.name}さんへ質問します。`,
    speechInteraction: { questionTargetNames: [target.name] },
  });
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.effectiveRawResponse, raw);
  assert.ok(evaluation.issues.some((issue) => String(issue.message).includes('questionTargetNames')));
  assert.equal((evaluation.autoRepair?.operations ?? []).some((item) => item.path === 'speechInteraction.questionTargetNames'), false);
});


test('単独人狼の不正なpartnerDispositionをnot-applicableへ置換せず再生成対象にする', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  actor.roleId = 'wolf';
  state.playerKnowledge[actor.id] = {
    knownWolfIds: [actor.id],
    knownMadmanIds: [],
    knownMasonIds: [],
    roleNotifiedAt: null,
    knowledgeRevision: 0,
  };
  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const raw = JSON.stringify({
    publicSpeech: '公開情報から候補を見ます。',
    factionStrategyUpdate: {
      mode: 'patch',
      changes: { partnerDisposition: 'separate' },
    },
  });
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  assert.equal(evaluation.ok, false);
  assert.equal(JSON.parse(evaluation.effectiveRawResponse).factionStrategyUpdate.changes.partnerDisposition, 'separate');
  assert.ok(evaluation.issues.some((issue) => String(issue.message).includes('not-applicable')));
  assert.equal((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'PARTNER_DISPOSITION_NORMALIZED'), false);
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
    factionStrategyUpdate: {
      mode: 'patch',
      changes: { partnerDisposition: 'separate' },
    },
  });
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.candidateObject.actionAnswer, target.name);
  assert.equal(Object.hasOwn(evaluation.candidateObject, 'factionStrategyUpdate'), false);
  assert.ok((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'INVALID_OPTIONAL_FIELD_DISCARDED'));
});

test('Day2以降の最終巡通常発言は投票相当の処刑比較を陣営別に適用する', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  state.game.day = 2;
  state.game.phase = 'discussion';
  state.discussion = {
    day: 2,
    mode: 'ordered',
    modeControl: null,
    round: 3,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: state.players.map((player) => player.id),
    queue: state.players.map((player) => player.id),
    currentIndex: 0,
    remainingByPlayer: Object.fromEntries(state.players.map((player) => [player.id, player.id === actor.id ? 1 : 2])),
    spokenInCurrentRound: [],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(state.players.map((player) => [player.id, 0])),
    allDeferred: false,
    designatedPlayerId: null,
    completed: false,
    reconsideration: {
      pending: false, active: false, items: [], reasons: [], sourceEventIds: [], affectedPlayerIds: [], updatedAt: null, handledRound: null,
    },
  };

  actor.roleId = 'villager';
  const villageFinalSpeech = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  assert.doesNotMatch(villageFinalSpeech.promptEnvelope.taskInvariantContext, /## 処刑判断/u);
  assert.match(villageFinalSpeech.promptEnvelope.taskVariableContext, /## 処刑判断/u);
  assert.match(villageFinalSpeech.promptEnvelope.taskVariableContext, /村人陣営では、対象が人狼でなかった場合の損失/u);
  assert.match(villageFinalSpeech.promptEnvelope.taskVariableContext, /最終巡です。投票時と同じ処刑比較/u);
  assert.match(villageFinalSpeech.promptEnvelope.taskVariableContext, /差がなければ未定のままで構いません/u);
  assert.doesNotMatch(villageFinalSpeech.promptEnvelope.taskVariableContext, /intendedVoteを決めてください/u);
  assert.match(villageFinalSpeech.stageSource.roleTaskData.promptGuidance.executionValuePolicy, /## 処刑判断/u);
  assert.match(villageFinalSpeech.stageSource.roleTaskData.promptGuidance.executionFactionPolicy, /村人陣営では/u);

  state.discussion.remainingByPlayer[actor.id] = 2;
  const villageEarlierSpeech = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  assert.doesNotMatch(villageEarlierSpeech.promptEnvelope.taskInvariantContext, /## 処刑判断/u);
  assert.doesNotMatch(villageEarlierSpeech.promptEnvelope.taskVariableContext, /最終巡です/u);
  assert.doesNotMatch(villageEarlierSpeech.promptEnvelope.taskVariableContext, /## 処刑判断/u);
  state.discussion.remainingByPlayer[actor.id] = 1;
  actor.roleId = 'wolf';
  state.playerKnowledge[actor.id] = {
    knownWolfIds: [actor.id], knownMadmanIds: [], knownMasonIds: [], knownOwnerId: null, knownOwnerRoleId: null, resolvedTeam: 'wolf', roleNotifiedAt: null, knowledgeRevision: 1,
  };
  const wolfFinalSpeech = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  assert.doesNotMatch(wolfFinalSpeech.promptEnvelope.taskInvariantContext, /## 処刑判断/u);
  assert.match(wolfFinalSpeech.promptEnvelope.taskVariableContext, /## 処刑判断/u);
  assert.doesNotMatch(wolfFinalSpeech.promptEnvelope.taskVariableContext, /村人陣営では、対象が人狼でなかった場合の損失/u);
  assert.equal(wolfFinalSpeech.stageSource.roleTaskData.promptGuidance.executionFactionPolicy, '');
});

test('投票タスクEnvelopeは有効対象名と本人役職に一致するSchemaを持つ', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  prepareVoteState(state);

  actor.roleId = 'villager';
  const villagerArtifact = prepareAiTask(state, { playerId: actor.id, taskType: 'vote' });
  const villagerSchema = villagerArtifact.promptEnvelope.structuredOutput?.schema;
  const cacheablePrefix = [
    villagerArtifact.promptEnvelope.commonGameContext,
    villagerArtifact.promptEnvelope.taskInvariantContext,
    villagerArtifact.promptEnvelope.stablePlayerContext,
  ].join('\n');
  assert.equal(villagerArtifact.promptEnvelope.schemaVersion, 5);
  assert.ok(cacheablePrefix.length > 0, 'キャッシュ対象接頭辞は空にしない');
  assert.doesNotMatch(villagerArtifact.promptEnvelope.taskInvariantContext, /### 必須|今回の必須出力/u);
  assert.doesNotMatch(villagerArtifact.promptEnvelope.taskVariableContext, /### 必須|今回の必須出力/u);
  assert.match(villagerArtifact.promptEnvelope.dynamicTaskPrompt, /## 最終確認/u);
  assert.match(villagerArtifact.promptEnvelope.dynamicTaskPrompt, /今回の必須出力: actionAnswer。/u);
  assert.equal(villagerSchema?.type, 'object');
  assert.deepEqual(villagerSchema?.required, ['actionAnswer']);
  assert.deepEqual(villagerSchema?.properties?.decisionPatch?.required, []);
  assert.equal(villagerSchema.required.includes('actionRationale'), false);
  assert.equal(villagerSchema.required.includes('decisionPatch'), false);
  assert.match(villagerArtifact.promptEnvelope.dynamicTaskPrompt, /項目: actionAnswer \/ actionRationale \/ decisionPatch \/ memoAdd。/u);
  assert.ok(Array.isArray(villagerSchema?.properties?.actionAnswer?.enum));
  assert.equal(villagerSchema.properties.actionAnswer.enum.every((name) => typeof name === 'string' && name.length > 0), true);
  assert.deepEqual(Object.keys(villagerSchema.properties.decisionPatch.properties), [
    'suspicionCandidates', 'executionCandidates', 'assessmentLevel', 'leaveAliveBenefit',
    'misexecutionCost', 'selectionDifference', 'uncertainty', 'nextDiscriminatingInformation',
    'correctedSpeechSequences', 'evidenceEventSequences',
  ]);
  assert.equal(villagerSchema.properties.decisionPatch.additionalProperties, false);
  assert.equal(Object.hasOwn(villagerSchema.properties, 'factionStrategyUpdate'), false);
  assert.equal(villagerArtifact.stageSource.responseContract.allowedTopLevelKeys.includes('factionStrategyUpdate'), false);

  actor.roleId = 'wolf';
  actor.knowledge = {
    knownWolfIds: [actor.id],
    knownMasonIds: [],
    roleNotifiedAt: null,
    knowledgeRevision: 0,
  };
  const wolfArtifact = prepareAiTask(state, { playerId: actor.id, taskType: 'vote' });
  const wolfSchema = wolfArtifact.promptEnvelope.structuredOutput?.schema;
  assert.equal(wolfArtifact.promptEnvelope.taskInvariantContext, villagerArtifact.promptEnvelope.taskInvariantContext, '同じvoteの意味ルールは役職差で変動させない');
  assert.notEqual(wolfArtifact.promptEnvelope.stablePlayerContext, villagerArtifact.promptEnvelope.stablePlayerContext, '本人固定情報は役職差を保持する');
  assert.notEqual(wolfArtifact.promptEnvelope.taskVariableContext, villagerArtifact.promptEnvelope.taskVariableContext, '役職固有の出力契約・戦術は可変区画へ残す');
  assert.equal(Object.hasOwn(wolfSchema.properties, 'factionStrategyUpdate'), true);
  assert.deepEqual(wolfSchema.properties.factionStrategyUpdate.required, ['mode', 'changes']);
  assert.equal(wolfSchema.properties.factionStrategyUpdate.additionalProperties, false);
  assert.deepEqual(Object.keys(wolfSchema.properties.factionStrategyUpdate.properties.changes.properties), [
    'publicWorld', 'dayWinPath', 'collapsePlan', 'failureRisk',
  ]);
  assert.equal(wolfSchema.properties.factionStrategyUpdate.properties.changes.additionalProperties, false);
  assert.equal(wolfArtifact.stageSource.responseContract.allowedTopLevelKeys.includes('factionStrategyUpdate'), true);
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

