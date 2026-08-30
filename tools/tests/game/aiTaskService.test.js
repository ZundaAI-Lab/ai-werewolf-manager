/**
 * 責務: 本番タスク準備と候補評価を共通化し、元JSONの実在キー集合・生成時指紋・保存済み機密状態を次回入力へ再投影しない境界を維持することを検証する。
 * 変更ルール: UIやAPI通信を介さず、既存パーサー・バリデータへ同じ引数を渡す境界だけを確認する。speechInteractionは公開本文から独立した補助制御として利用不能部分だけ自動除去し、判断根拠・陣営戦略の意味を持つ不正値は原則として再生成対象に維持する。投票だけは有効なactionAnswerを守って意味を変えない任意項目を劣化できることを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';


import { initializeDiscussion, finishDiscussion } from '../../../app/renderer/js/domain/discussion/discussionRuntime.js';
import { beginVote } from '../../../app/renderer/js/domain/vote/voteCommands.js';

import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { composeManualAiPrompt, prepareAiTask, evaluateAiTaskCandidate } from '../../../app/renderer/js/services/aiTaskService.js';
import { buildDecideStagePrompt } from '../../../app/renderer/js/prompts/stages/generationStagePromptBuilder.js';
import { resolveGenerationStagePromptPolicy } from '../../../app/renderer/js/prompts/stages/generationStagePromptPolicy.js';



function prepareVoteState(state) {
  state.game.day = 1;
  initializeDiscussion(state);
  assert.equal(finishDiscussion(state).ok, true);
  assert.equal(beginVote(state).ok, true);
}


test('投票人数分岐はvoteの直接生成・判断用データだけへ渡し非voteタスクへ流さない', () => {
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

test('Day2以降の通常昼議論第1巡では夜明け状況ガイドを直接生成と判断回答の両方へ同条件で渡す', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  state.game.day = 2;
  initializeDiscussion(state);

  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const dynamicPrompt = artifact.promptEnvelope.dynamicTaskPrompt;
  const guide = artifact.stageSource.publicState.roleCompositionSituationGuide;
  const decidePrompt = buildDecideStagePrompt({
    taskArtifact: artifact,
    policy: resolveGenerationStagePromptPolicy({ stageId: 'decide', taskType: 'speech' }),
  });

  assert.ok(dynamicPrompt.indexOf('## ゲーム状態') < dynamicPrompt.indexOf('## 初期役職構成から起こりうる夜明けの状況'));
  assert.deepEqual(guide, {
    multipleDeaths: [],
    noDeaths: ['護衛による襲撃阻止'],
    noFreeze: [],
    singleDeathMayCombine: false,
  });
  assert.match(decidePrompt, /roleCompositionSituationGuide/u);
  assert.match(decidePrompt, /護衛による襲撃阻止/u);
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
    parsedSelectionRationale: '前夜はこの対象を凍結した。',
  });

  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const prompt = artifact.promptEnvelope.dynamicTaskPrompt;
  const priorFreeze = artifact.stageSource.privateState.privateLocks.ownHistory.latestFreezeJudgment;

  assert.doesNotMatch(prompt, /latest-heart-voice|前回だけの秘密心情/u);
  assert.doesNotMatch(prompt, /estimatedWerewolves|predictedAttackTargets/u);
  assert.deepEqual(priorFreeze, {
    nightDay: 1,
    targetId: frozenTargetId,
    selectionRationale: '前夜はこの対象を凍結した。',
  });
  assert.equal(Object.hasOwn(artifact.stageSource.privateState.privateLocks, 'latestHeartVoice'), false);
  assert.equal(Object.hasOwn(priorFreeze, 'estimatedWerewolfIds'), false);
  assert.equal(Object.hasOwn(priorFreeze, 'predictedAttackTargetIds'), false);

  assert.equal(actor.heartVoice, '前回だけの秘密心情');
  assert.deepEqual(state.aiTurns.at(-1).estimatedWerewolfIds, [estimatedWolfId]);
  assert.deepEqual(state.aiTurns.at(-1).predictedAttackTargetIds, [predictedAttackId]);
  assert.equal(artifact.stageSource.responseContract.allowedTopLevelKeys.includes('heartVoice'), true);
});

test('decisionPatchの非公開・不正参照は黙って除去せず再生成対象にする', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const raw = JSON.stringify({
    publicSpeech: '現時点ではこの相手を疑う。',
    decisionPatch: {
      suspects: [target.name],
      evidenceRefs: [999999],
    },
  });

  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);

  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.candidateObject.decisionPatch.evidenceRefs, [999999]);
  assert.match(evaluation.validation.errors.join('\n'), /decisionPatch\.evidenceRefsの#999999は現在参照できる公開イベントではありません/u);
  assert.equal((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'INVALID_DECISION_EVENT_SEQUENCES_REMOVED'), false);
  assert.equal((evaluation.autoRepair?.operations ?? []).some((item) => item.path === 'decisionPatch.evidenceRefs'), false);
});


test('speechInteractionの不正な補助制御だけを除去しpublicSpeechを保持する', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const raw = JSON.stringify({
    publicSpeech: `${target.name}さんへ質問します。`,
    speechInteraction: { questionTargetNames: [target.name] },
  });
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  const repaired = JSON.parse(evaluation.effectiveRawResponse);
  assert.equal(evaluation.ok, true, evaluation.errors?.join?.('\n') ?? '');
  assert.equal(repaired.publicSpeech, `${target.name}さんへ質問します。`);
  assert.equal(Object.hasOwn(repaired, 'speechInteraction'), false);
  assert.ok((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'INVALID_SPEECH_CONTROL_DISCARDED' && item.path === 'speechInteraction.questionTargetNames'));
});


test('凍結中の質問先だけを除去しpublicSpeech全体をfallbackさせない', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  target.statusEffects = [{ type: 'frozen', day: state.game.day }];
  const artifact = prepareAiTask(state, { playerId: actor.id, taskType: 'speech' });
  const publicSpeech = `${target.name}さんは最後に誰を疑っているか教えてください。`;
  const raw = JSON.stringify({
    publicSpeech,
    speechInteraction: { questionTargets: [target.name] },
  });

  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  const repaired = JSON.parse(evaluation.effectiveRawResponse);
  assert.equal(evaluation.ok, true, evaluation.errors?.join?.('\n') ?? '');
  assert.equal(repaired.publicSpeech, publicSpeech);
  assert.deepEqual(repaired.speechInteraction?.questionTargets ?? [], []);
  assert.ok((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'INVALID_SPEECH_CONTROL_DISCARDED' && item.path === 'speechInteraction.questionTargets[0]'));
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
    factionStrategy: {
      mode: 'patch',
      changes: { partnerDisposition: 'separate' },
    },
  });
  const evaluation = evaluateAiTaskCandidate(state, artifact, raw);
  assert.equal(evaluation.ok, false);
  assert.equal(JSON.parse(evaluation.effectiveRawResponse).factionStrategy.changes.partnerDisposition, 'separate');
  assert.ok(evaluation.issues.some((issue) => String(issue.message).includes('not-applicable')));
  assert.equal((evaluation.autoRepair?.operations ?? []).some((item) => item.code === 'PARTNER_DISPOSITION_NORMALIZED'), false);
});

