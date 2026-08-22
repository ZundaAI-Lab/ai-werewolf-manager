/**
 * 責務: 自動/手動の生成工程が共通のtextPatch受理条件を使い、生成計画どおりに完全候補・発言化・校正を順次適用し、適用不能と回答取得後の内容不正を差し戻さず監査記録へ残し、API回答未取得だけは停止例外として維持することを検証する。
 * 変更ルール: API実装やゲーム状態更新を含めず、注入応答による工程遷移・予算・内容不正フォールバック・回答未取得停止、公開データ射影と内部ID境界、自動/手動共通の文章連続性拒否だけを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerationPipeline } from '../../../app/renderer/js/services/generationPipeline.js';
import { resolveGenerationStagePromptPolicy } from '../../../app/renderer/js/prompts/stages/generationStagePromptPolicy.js';
import { buildDraftStagePrompt, buildRenderStagePrompt, buildProofreadStagePrompt } from '../../../app/renderer/js/prompts/stages/generationStagePromptBuilder.js';



import { renderDynamicTaskPrompt } from '../../../app/renderer/js/prompts/templates/promptTemplates.js';
import { ManualGenerationController } from '../../../app/renderer/js/ui/ai/manualGenerationController.js';

function evaluate(raw) {
  try {
    const candidateObject = JSON.parse(raw);
    return { ok: Boolean(candidateObject && !Array.isArray(candidateObject)), candidateObject, presentTopLevelKeys: Object.keys(candidateObject).sort(), issues: [] };
  } catch (error) {
    return { ok: false, candidateObject: null, presentTopLevelKeys: [], issues: [{ code: 'INVALID', message: error.message }] };
  }
}

function artifact(taskType = 'speech') {
  return {
    taskType,
    text: 'DIRECT',
    publicHistoryMode: 'full',
    stageSource: {
      currentMoment: { day: 1, phase: 'discussion', taskType }, publicState: {}, privateState: {}, roleTaskData: {}, characterReasoning: {}, characterExpression: {}, promptPolicies: {}, histories: {}, responseContract: {},
    },
  };
}

const builders = {
  resolveStagePromptPolicy: resolveGenerationStagePromptPolicy,
  buildDraftPrompt: buildDraftStagePrompt,
  buildRenderPrompt: buildRenderStagePrompt,
  buildProofreadPrompt: buildProofreadStagePrompt,
};

test('手動renderも共通textPatch検証で長文から20文字未満への短文化を拒否する', () => {
  const controller = new ManualGenerationController({});
  const sourceText = '今日は占い結果と投票理由を順番に確認し、公開情報だけを使って候補を比較したいのだ。';
  const session = {
    candidateObject: { publicSpeech: sourceText },
    presentTopLevelKeys: ['publicSpeech'],
  };
  const result = controller.validateManualTextStagePatch(
    session,
    artifact('speech'),
    { stageId: 'render' },
    JSON.stringify({ textPatch: { publicSpeech: 'Aに投票するのだ' } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.candidateObject.publicSpeech, sourceText);
  assert.equal(result.issues.some((item) => item.code === 'TEXT_PATCH_SOURCE_DIVERGED'), true);
});

test('自動renderも共通textPatch検証で長文から20文字未満への短文化をフォールバックする', async () => {
  const sourceText = '今日は占い結果と投票理由を順番に確認し、公開情報だけを使って候補を比較したいのだ。';
  const plan = { depth: 3, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 2, maximumCallBudget: 5, stages: [
    { stageId: 'draft', executorProfileId: 'owner' },
    { stageId: 'render', executorProfileId: 'owner' },
  ] };
  const result = await runGenerationPipeline({
    plan,
    taskArtifact: artifact('speech'),
    evaluateCandidate: evaluate,
    ...builders,
    requestFullCandidate: async () => ({ ok: true, rawResponse: JSON.stringify({ publicSpeech: sourceText }), attemptCount: 1 }),
    requestTextPatch: async () => ({ ok: true, rawResponse: JSON.stringify({ textPatch: { publicSpeech: 'Aに投票するのだ' } }), attemptCount: 1 }),
  });
  assert.equal(result.evaluation.candidateObject.publicSpeech, sourceText);
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.status), ['accepted', 'fallback']);
  assert.equal(result.generationRun.stages[1].issues.some((item) => item.code === 'TEXT_PATCH_SOURCE_DIVERGED'), true);
  assert.equal(result.generationRun.finalStageId, 'draft');
});


test('深度4は草案・発言化・校正を各1回適用し最終候補だけを返す', async () => {
  const plan = { depth: 4, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 3, maximumCallBudget: 6, stages: [
    { stageId: 'draft', executorProfileId: 'owner' },
    { stageId: 'render', executorProfileId: 'owner' },
    { stageId: 'proofread', executorProfileId: 'proofreader' },
  ] };
  let patchCall = 0;
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact(), evaluateCandidate: evaluate, ...builders,
    requestFullCandidate: async () => ({ ok: true, rawResponse: JSON.stringify({ publicSpeech: '草案', heartVoice: '内心', decisionUpdate: { mode: 'keep' } }), attemptCount: 1, usage: { totalTokens: 10 } }),
    requestTextPatch: async ({ policy }) => {
      patchCall += 1;
      const suffix = patchCall === 1 ? '発言化' : '校正';
      return { ok: true, rawResponse: JSON.stringify({ textPatch: Object.fromEntries(policy.targetTextFields.map((field) => [field, `${field}-${suffix}`])) }), attemptCount: 1, usage: { totalTokens: 5 } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.evaluation.candidateObject.publicSpeech, 'publicSpeech-校正');
  assert.deepEqual(result.evaluation.candidateObject.decisionUpdate, { mode: 'keep' });
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.status), ['accepted', 'applied', 'applied']);
  assert.equal(result.generationRun.totalCallCount, 3);
  assert.equal(result.generationRun.finalStageId, 'proofread');
});

test('不正発言化は草案へフォールバックし校正を現在の有効候補へ適用する', async () => {
  const plan = { depth: 4, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 3, maximumCallBudget: 6, stages: [
    { stageId: 'draft', executorProfileId: 'owner' }, { stageId: 'render', executorProfileId: 'owner' }, { stageId: 'proofread', executorProfileId: 'owner' },
  ] };
  let calls = 0;
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact(), evaluateCandidate: evaluate, ...builders,
    requestFullCandidate: async () => ({ ok: true, rawResponse: '{"publicSpeech":"草案"}', attemptCount: 1 }),
    requestTextPatch: async ({ policy }) => {
      calls += 1;
      return calls === 1
        ? { ok: true, rawResponse: '{"textPatch":{"heartVoice":"対象外"}}', attemptCount: 1 }
        : { ok: true, rawResponse: JSON.stringify({ textPatch: Object.fromEntries(policy.targetTextFields.map((field) => [field, '校正済み'])) }), attemptCount: 1 };
    },
  });
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.status), ['accepted', 'fallback', 'applied']);
  assert.equal(result.evaluation.candidateObject.publicSpeech, '校正済み');
  assert.equal(result.generationRun.finalStageId, 'proofread');
});

test('多段草案は公開履歴射影だけを使い生イベント管理情報・空値・内部UUIDを渡さない', () => {
  const playerId = 'player-64a90611-8b3f-4c89-afbc-e8748dcd2935';
  const otherId = 'player-b6615b15-88c5-42d5-b63d-33914c3f75f4';
  const eventId = 'event-11111111-2222-4333-8444-555555555555';
  const sourceQuestionEventId = 'event-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource.currentMoment = { day: 1, phase: 'discussion', taskType: 'speech', playerId, playerName: 'ずんだもん' };
  taskArtifact.stageSource.publicState = {
    alivePlayers: [{ id: playerId, name: 'ずんだもん' }, { id: otherId, name: 'めたん' }],
    deadPlayers: [],
    publicLocks: {},
    currentVoteState: null,
    recentOutcomeSummary: [],
  };
  taskArtifact.stageSource.privateState = { ownRole: { roleId: 'villager', team: 'village' }, teammates: {}, ownAbilityResults: [], privateLocks: {} };
  taskArtifact.stageSource.roleTaskData = {
    promptGuidance: {},
    validTargetIds: [],
    emptyArray: [],
    emptyObject: {},
    emptyText: '',
    sourceQuestionEventId,
    keyedByPlayer: { [otherId]: { remaining: 1 } },
  };
  taskArtifact.stageSource.characterReasoning = {};
  taskArtifact.stageSource.histories = {
    publicHistoryMode: 'full',
    publicHistoryProjection: {
      rows: [{ sequence: 7, actor: 'めたん', text: '占い師ではないよ。' }],
    },
    ownPublicHistoryProjection: [],
    recentPublicTimeline: [{
      id: eventId,
      sequence: 7,
      type: 'public-speech',
      actorId: otherId,
      payload: { text: '占い師ではないよ。' },
      opportunityContext: {
        mode: 'ordered',
    modeControl: null,
        queuePosition: 2,
        remainingByPlayerAtSpeechStart: { [playerId]: 1, [otherId]: 1 },
      },
    }],
    existingInternalMemo: {},
    privateTeamStrategy: null,
  };
  taskArtifact.stageSource.responseContract = {
    mode: 'speech',
    allowedTopLevelKeys: ['publicSpeech'],
    requiredTopLevelKeys: ['publicSpeech'],
    optionalTopLevelKeys: [],
    conditionalExamples: {},
    fieldDescriptions: { publicSpeech: '発言' },
    completeExample: { publicSpeech: '発言例' },
  };
  const policy = resolveGenerationStagePromptPolicy({ stageId: 'draft', taskType: 'speech' });
  const prompt = buildDraftStagePrompt({ taskArtifact, policy });

  assert.match(prompt, /publicHistoryProjection/u);
  assert.match(prompt, /占い師ではないよ。/u);
  assert.doesNotMatch(prompt, /recentPublicTimeline|opportunityContext|remainingByPlayerAtSpeechStart/u);
  assert.doesNotMatch(prompt, /player-[0-9a-f-]{36}|event-[0-9a-f-]{36}|ai-turn-[0-9a-f-]{36}/iu);
  assert.doesNotMatch(prompt, /sourceQuestionEventId|emptyArray|emptyObject|emptyText/u);
  assert.doesNotMatch(prompt, /\n\s{2,}"/u, 'draftのgame-data JSONはpretty-printしない');
});


test('多段renderも内部UUIDを漏らさず公開名とイベント番号だけを境界へ出す', () => {
  const playerId = 'player-64a90611-8b3f-4c89-afbc-e8748dcd2935';
  const otherId = 'player-b6615b15-88c5-42d5-b63d-33914c3f75f4';
  const eventId = 'event-11111111-2222-4333-8444-555555555555';
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource.currentMoment = { day: 1, phase: 'discussion', taskType: 'speech', playerId, playerName: 'ずんだもん' };
  taskArtifact.stageSource.publicState = {
    alivePlayers: [{ id: playerId, name: 'ずんだもん' }, { id: otherId, name: 'めたん' }],
    deadPlayers: [], activeClaims: [], publicAbilityClaims: [],
  };
  taskArtifact.stageSource.histories = {
    recentPublicTimeline: [{ id: eventId, sequence: 12, type: 'public-speech', actorId: otherId, payload: { text: '質問するね。' } }],
    publicHistoryProjection: { rows: [{ sequence: 12, actor: 'めたん', text: '質問するね。' }] },
  };
  taskArtifact.stageSource.characterExpression = { callNames: [] };
  taskArtifact.stageSource.roleTaskData = { promptGuidance: {} };
  taskArtifact.stageSource.promptPolicies = { publicSpeechLengthPolicy: { targetChars: 120 }, outputLimits: { maxPublicSpeechLength: 450, maxHeartVoiceLength: 120 } };
  const candidateObject = {
    publicSpeech: 'めたんの質問には答えるのだ。',
    speechInteraction: { questionTargets: [otherId], answerToRefs: [12] },
    decisionPatch: { suspects: [otherId], evidenceRefs: [12] },
  };
  const policy = resolveGenerationStagePromptPolicy({ stageId: 'render', taskType: 'speech', candidateObject, presentTopLevelKeys: Object.keys(candidateObject) });
  const prompt = buildRenderStagePrompt({ taskArtifact, candidateObject, policy });

  assert.doesNotMatch(prompt, /player-[0-9a-f-]{36}|event-[0-9a-f-]{36}|ai-turn-[0-9a-f-]{36}/iu);
  assert.match(prompt, /めたん/u);
  assert.match(prompt, /12/u);
});


test('遺言・墓場会話はheartVoiceを多段生成せずproofreadも通常発言と回答だけに限定する', () => {
  const testamentCandidate = { publicSpeech: '最後に残す遺言です。' };
  const testamentRender = resolveGenerationStagePromptPolicy({
    stageId: 'render',
    taskType: 'testament',
    candidateObject: testamentCandidate,
    presentTopLevelKeys: ['publicSpeech', 'heartVoice'],
  });
  assert.deepEqual(testamentRender.targetTextFields, ['publicSpeech']);

  const graveyardCandidate = { graveyardMessage: '墓場だけの会話です。' };
  const graveyardRender = resolveGenerationStagePromptPolicy({
    stageId: 'render',
    taskType: 'graveyard-conversation',
    candidateObject: graveyardCandidate,
    presentTopLevelKeys: ['graveyardMessage', 'heartVoice'],
  });
  assert.deepEqual(graveyardRender.targetTextFields, ['graveyardMessage']);

  const testamentProofread = resolveGenerationStagePromptPolicy({
    stageId: 'proofread',
    taskType: 'testament',
    candidateObject: testamentCandidate,
    presentTopLevelKeys: ['publicSpeech'],
  });
  assert.equal(testamentProofread.applicable, false);
  assert.equal(testamentProofread.skipReason, 'NO_APPLICABLE_TEXT_FIELD');

  const answerProofread = resolveGenerationStagePromptPolicy({
    stageId: 'proofread',
    taskType: 'priority-answer',
    candidateObject: { publicSpeech: '回答です。' },
    presentTopLevelKeys: ['publicSpeech'],
  });
  assert.equal(answerProofread.applicable, true);
  assert.deepEqual(answerProofread.targetTextFields, ['publicSpeech']);
});


test('現在タスクの最終確認は常にdynamicTaskPromptの末尾から動かさない', () => {
  const finalResponseReminder = '## 最終確認\n\n固定された最低限の確認事項';
  const rendered = renderDynamicTaskPrompt({
    playerDataBlock: '[game-data:player]{}[/game-data]',
    publicHistoryTitle: '公開履歴',
    finalResponseReminder,
  });
  assert.equal(rendered.trimEnd().endsWith(finalResponseReminder), true);
  assert.equal(rendered.lastIndexOf('## 最終確認'), rendered.length - finalResponseReminder.length);
});

test('対象文章がない後段工程はAPIを呼ばずskippedで記録する', async () => {
  const plan = { depth: 2, ownerProfileId: 'owner', taskCategory: 'vote', normalCallCount: 2, maximumCallBudget: 5, stages: [
    { stageId: 'direct', executorProfileId: 'owner' }, { stageId: 'proofread', executorProfileId: 'owner' },
  ] };
  let patchCalls = 0;
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact('vote'), evaluateCandidate: evaluate, ...builders,
    requestFullCandidate: async () => ({ ok: true, rawResponse: '{"actionAnswer":"p2"}', attemptCount: 1 }),
    requestTextPatch: async () => { patchCalls += 1; return { ok: false }; },
  });
  assert.equal(patchCalls, 0);
  assert.equal(result.generationRun.totalCallCount, 1);
  assert.equal(result.generationRun.stages[1].status, 'skipped');
  assert.equal(result.generationRun.stages[1].skipReason, 'NO_APPLICABLE_TEXT_FIELD');
  assert.equal(result.generationRun.finalStageId, 'direct');
});


