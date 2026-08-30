/**
 * 責務: 生成深度2～4の新しい段階分離、自由記述分析、最終候補JSONの一回生成、render共通検証、情報境界、呼び出し予約を検証する。
 * 変更ルール: API実装やゲーム状態更新を含めず、注入応答による段階遷移・予算・自由記述フォールバック・公開データ射影・人物情報境界・文章連続性だけを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerationPipeline } from '../../../app/renderer/js/services/generationPipeline.js';
import { buildGenerationStageSource } from '../../../app/renderer/js/prompts/context/generationStageSource.js';
import { resolveGenerationStagePromptPolicy } from '../../../app/renderer/js/prompts/stages/generationStagePromptPolicy.js';
import {
  buildDecideStagePrompt,
  buildAnalyzeStagePrompt,
  buildCritiqueStagePrompt,
  buildFinalizeStagePrompt,
  buildRenderStagePrompt,
} from '../../../app/renderer/js/prompts/stages/generationStagePromptBuilder.js';
import { projectGenerationStagePromptEnvelope } from '../../../app/renderer/js/prompts/stages/generationStageEnvelope.js';
import { renderDynamicTaskPrompt, renderFinalResponseReminder } from '../../../app/renderer/js/prompts/templates/promptTemplates.js';
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
    promptEnvelope: {
      commonSystemInstruction: 'SYSTEM',
      commonGameContext: 'GAME',
      taskInvariantContext: 'INVARIANT',
      stablePlayerContext: 'STYLE_AND_REASONING',
      taskVariableContext: 'VARIABLE',
      dynamicTaskPrompt: 'DIRECT',
      structuredOutput: { name: 'response', schema: { type: 'object' } },
      cacheIdentity: { promptFamily: 'game-candidate' },
    },
    stageSource: {
      currentMoment: { day: 1, phase: 'discussion', taskType, playerName: 'ずんだもん' },
      publicState: {}, privateState: {}, roleTaskData: { promptGuidance: {} },
      characterReasoning: {}, characterExpression: {}, promptPolicies: {}, histories: {},
      responseContract: {
        mode: 'discussion', allowedTopLevelKeys: ['publicSpeech'], requiredTopLevelKeys: ['publicSpeech'], optionalTopLevelKeys: [],
        fieldDescriptions: { publicSpeech: '発言' }, completeExample: { publicSpeech: '発言例' }, conditionalExamples: {},
      },
    },
  };
}

const builders = {
  resolveStagePromptPolicy: resolveGenerationStagePromptPolicy,
  buildDecidePrompt: buildDecideStagePrompt,
  buildAnalyzePrompt: buildAnalyzeStagePrompt,
  buildCritiquePrompt: buildCritiqueStagePrompt,
  buildFinalizePrompt: buildFinalizeStagePrompt,
  buildRenderPrompt: buildRenderStagePrompt,
};

test('深度1 Directは単一の完成候補生成として実行する', async () => {
  const plan = { depth: 1, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 1, coreCallBudget: 4, maximumCallBudget: 4, stages: [
    { stageId: 'direct', executorProfileId: 'owner' },
  ] };
  let observed = null;
  const result = await runGenerationPipeline({
    plan,
    taskArtifact: artifact('speech'),
    evaluateCandidate: evaluate,
    ...builders,
    requestFullCandidate: async (args) => {
      observed = args;
      return { ok: true, rawResponse: JSON.stringify({ publicSpeech: '直接生成' }), attemptCount: 1 };
    },
    requestFreeText: async () => { throw new Error('Directでは呼ばれない'); },
    requestTextPatch: async () => { throw new Error('Directでは呼ばれない'); },
  });
  assert.equal(observed.prompt, 'DIRECT');
  assert.equal(observed.callBudget, 4);
  assert.equal(observed.candidateObject, null);
  assert.equal(result.evaluation.candidateObject.publicSpeech, '直接生成');
  assert.deepEqual(result.generationRun.stages.map((stage) => [stage.stageId, stage.status]), [['direct', 'accepted']]);
});

test('手動renderも共通textPatch検証で長文から20文字未満への短文化を拒否する', () => {
  const controller = new ManualGenerationController({});
  const sourceText = '今日は占い結果と投票理由を順番に確認し、公開情報だけを使って候補を比較したいのだ。';
  const session = { candidateObject: { publicSpeech: sourceText }, presentTopLevelKeys: ['publicSpeech'] };
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

test('深度2はDecideで候補を確定しRenderだけ文章を書き換える', async () => {
  const sourceText = '今日は占い結果と投票理由を確認し、Aを処刑候補として比較する。';
  const plan = { depth: 2, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 2, maximumCallBudget: 5, stages: [
    { stageId: 'decide', executorProfileId: 'owner' },
    { stageId: 'render', executorProfileId: 'owner' },
  ] };
  let decideBudget = 0;
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact('speech'), evaluateCandidate: evaluate, ...builders,
    requestFullCandidate: async ({ callBudget }) => {
      decideBudget = callBudget;
      return { ok: true, rawResponse: JSON.stringify({ publicSpeech: sourceText, decisionPatch: { intendedVote: 'A' } }), attemptCount: 1 };
    },
    requestFreeText: async () => { throw new Error('呼ばれない'); },
    requestTextPatch: async () => ({ ok: true, rawResponse: JSON.stringify({ textPatch: { publicSpeech: '今日はAを候補に見るのだ。占い結果と投票理由を確認したいのだ。' } }), attemptCount: 1 }),
  });
  assert.equal(decideBudget, 4, 'Renderの最低1回を予約する');
  assert.equal(result.evaluation.candidateObject.decisionPatch.intendedVote, 'A');
  assert.match(result.evaluation.candidateObject.publicSpeech, /のだ/u);
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.stageId), ['decide', 'render']);
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.status), ['accepted', 'applied']);
});

test('深度4はAnalyze・Critiqueを自由記述で各1回実行し、Finalizeだけが完成候補JSONを生成する', async () => {
  const plan = { depth: 4, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 3, maximumCallBudget: 6, stages: [
    { stageId: 'analyze', executorProfileId: 'owner' },
    { stageId: 'critique', executorProfileId: 'reviewer' },
    { stageId: 'finalize', executorProfileId: 'owner' },
  ] };
  const freeTextCalls = [];
  let candidateCalls = 0;
  let finalizePrompt = '';
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact(), evaluateCandidate: evaluate, ...builders,
    requestFreeText: async ({ stage, callBudget }) => {
      freeTextCalls.push([stage.stageId, callBudget]);
      return { ok: true, rawResponse: stage.stageId === 'analyze' ? 'AとBを比較する。' : 'A支持には飛躍がないか確認する。', attemptCount: 1 };
    },
    requestFullCandidate: async ({ prompt, callBudget }) => {
      candidateCalls += 1;
      finalizePrompt = prompt;
      assert.equal(callBudget, 4);
      return { ok: true, rawResponse: JSON.stringify({ publicSpeech: 'ボクはAを候補に見るのだ。', decisionPatch: { intendedVote: 'A' } }), attemptCount: 1 };
    },
    requestTextPatch: async () => { throw new Error('呼ばれない'); },
  });
  assert.deepEqual(freeTextCalls, [['analyze', 1], ['critique', 1]]);
  assert.equal(candidateCalls, 1);
  assert.match(finalizePrompt, /AとBを比較する/u);
  assert.match(finalizePrompt, /A支持には飛躍がないか確認する/u);
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.status), ['accepted', 'accepted', 'accepted']);
  assert.equal(result.generationRun.finalStageId, 'finalize');
});

test('Analyzeが失敗してもFinalizeを実行し、分析失敗を監査へ残す', async () => {
  const plan = { depth: 3, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 2, maximumCallBudget: 5, stages: [
    { stageId: 'analyze', executorProfileId: 'owner' },
    { stageId: 'finalize', executorProfileId: 'owner' },
  ] };
  let finalizePrompt = '';
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact(), evaluateCandidate: evaluate, ...builders,
    requestFreeText: async () => { const error = new Error('分析API失敗'); error.attemptCount = 1; throw error; },
    requestFullCandidate: async ({ prompt }) => { finalizePrompt = prompt; return { ok: true, rawResponse: JSON.stringify({ publicSpeech: '最終回答' }), attemptCount: 1 }; },
    requestTextPatch: async () => { throw new Error('呼ばれない'); },
  });
  assert.deepEqual(result.generationRun.stages.map((stage) => stage.status), ['fallback', 'accepted']);
  assert.doesNotMatch(finalizePrompt, /analysis-reference|分析資料/u);
  assert.match(finalizePrompt, /現在のゲーム情報から、今回の行動と発言を決定してください/u);
  assert.equal(result.evaluation.candidateObject.publicSpeech, '最終回答');
});

test('深度4でAnalyzeが失敗した場合はCritiqueを呼ばずFinalizeへ進む', async () => {
  const plan = { depth: 4, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 3, maximumCallBudget: 6, stages: [
    { stageId: 'analyze', executorProfileId: 'owner' },
    { stageId: 'critique', executorProfileId: 'reviewer' },
    { stageId: 'finalize', executorProfileId: 'owner' },
  ] };
  let freeTextCalls = 0;
  let finalizePrompt = '';
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact(), evaluateCandidate: evaluate, ...builders,
    requestFreeText: async () => { freeTextCalls += 1; const error = new Error('分析API失敗'); error.attemptCount = 1; throw error; },
    requestFullCandidate: async ({ prompt }) => { finalizePrompt = prompt; return { ok: true, rawResponse: JSON.stringify({ publicSpeech: '最終回答' }), attemptCount: 1 }; },
    requestTextPatch: async () => { throw new Error('呼ばれない'); },
  });
  assert.equal(freeTextCalls, 1);
  assert.deepEqual(result.generationRun.stages.map((stage) => [stage.stageId, stage.status]), [
    ['analyze', 'fallback'], ['critique', 'skipped'], ['finalize', 'accepted'],
  ]);
  assert.equal(result.generationRun.stages[1].skipReason, 'ANALYSIS_UNAVAILABLE');
  assert.equal(result.generationRun.stages[1].fallbackUsed, false);
  assert.equal(result.generationRun.stages[1].issues.some((item) => item.code === 'ANALYSIS_UNAVAILABLE'), true);
  assert.doesNotMatch(finalizePrompt, /analysis-reference|分析資料/u);
});

test('Analyze/Critiqueは後続参照と監査保存を別上限で切り詰める', async () => {
  const plan = { depth: 4, ownerProfileId: 'owner', taskCategory: 'speech', normalCallCount: 3, maximumCallBudget: 6, stages: [
    { stageId: 'analyze', executorProfileId: 'owner' },
    { stageId: 'critique', executorProfileId: 'reviewer' },
    { stageId: 'finalize', executorProfileId: 'owner' },
  ] };
  const longAnalyze = 'A'.repeat(70_000);
  const longCritique = 'C'.repeat(68_000);
  let critiqueInput = '';
  let finalizeInputs = null;
  const result = await runGenerationPipeline({
    plan,
    taskArtifact: artifact(),
    evaluateCandidate: evaluate,
    resolveStagePromptPolicy: resolveGenerationStagePromptPolicy,
    buildDecidePrompt: buildDecideStagePrompt,
    buildAnalyzePrompt: buildAnalyzeStagePrompt,
    buildCritiquePrompt: ({ analysisText }) => { critiqueInput = analysisText; return 'CRITIQUE'; },
    buildFinalizePrompt: ({ analysisText, critiqueText }) => { finalizeInputs = { analysisText, critiqueText }; return 'FINALIZE'; },
    buildRenderPrompt: buildRenderStagePrompt,
    requestFreeText: async ({ stage }) => ({ ok: true, rawResponse: stage.stageId === 'analyze' ? longAnalyze : longCritique, attemptCount: 1 }),
    requestFullCandidate: async () => ({ ok: true, rawResponse: JSON.stringify({ publicSpeech: '最終回答' }), attemptCount: 1 }),
    requestTextPatch: async () => { throw new Error('呼ばれない'); },
  });
  assert.equal(critiqueInput.length, 2400);
  assert.equal(finalizeInputs.analysisText.length, 2400);
  assert.equal(finalizeInputs.critiqueText.length, 1600);
  assert.equal(result.generationRun.stages[0].rawResponse.length, 64_000);
  assert.equal(result.generationRun.stages[1].rawResponse.length, 64_000);
  assert.equal(result.generationRun.stages[0].issues.some((item) => item.code === 'INTERMEDIATE_TEXT_TRUNCATED'), true);
  assert.equal(result.generationRun.stages[1].issues.some((item) => item.code === 'INTERMEDIATE_TEXT_TRUNCATED'), true);
  assert.equal(result.generationRun.stages[0].issues.some((item) => item.code === 'INTERMEDIATE_AUDIT_TRUNCATED'), true);
  assert.equal(result.generationRun.stages[1].issues.some((item) => item.code === 'INTERMEDIATE_AUDIT_TRUNCATED'), true);
});


test('深度2〜4は本人の保存済み陣営戦略を管理情報なしで判断材料へ引き継ぐ', () => {
  const context = {
    player: {
      id: 'wolf-a', name: '狼A', roleId: 'werewolf', team: 'wolf', strategyProfile: 'wolf', roleState: null,
      character: { speechLength: '標準' },
      knowledge: { knownWolfIds: ['wolf-b'], knownMadmanIds: [], knownMasonIds: [] },
      decisionState: null,
      factionStrategyState: {
        profile: 'wolf',
        publicWorld: '占い師の対抗COを選択肢として維持する。',
        dayWinPath: '真占い師のCO後は信用勝負への移行を比較する。',
        partnerDisposition: 'save',
        collapsePlan: '信用差が開いたら潜伏役を優先する。',
        failureRisk: '対抗COで二狼位置が狭まること。',
        updatedAt: '2026-08-27T10:00:00.000Z',
        sourceAiTurnId: 'ai-turn-secret-id',
      },
      internalMemory: {},
    },
    game: { day: 1, phase: 'discussion', rules: { ai: {}, vote: {} } },
    board: {
      alive: [{ id: 'wolf-a', name: '狼A' }, { id: 'wolf-b', name: '狼B' }],
      dead: [], claims: [], publicAbilityClaims: [], claimTimingFacts: [], pendingMediumClaimRequirements: [], publicTimeline: {},
    },
    private: { abilityResults: [], personalNotifications: [] },
    ownHistory: {}, task: {}, callNames: { rows: [] },
    wolfCommunication: { current: { messages: [], sharedStrategy: null }, past: [] },
    masonCommunication: { current: { messages: [] } },
    graveyardCommunication: { current: { messages: [] }, past: [] },
    wolfPartnerPublicPositions: [],
  };
  const responseContract = {
    mode: 'discussion', allowedTopLevelKeys: ['publicSpeech'], requiredTopLevelKeys: ['publicSpeech'], optionalTopLevelKeys: [],
    fieldDescriptions: { publicSpeech: '発言' }, completeExample: { publicSpeech: '発言例' }, conditionalExamples: {},
  };
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource = buildGenerationStageSource({
    context, decision: {}, taskType: 'speech', playerId: 'wolf-a', slotId: 'slot-a', validTargetIds: [], responseContract,
  });

  assert.deepEqual(taskArtifact.stageSource.privateState.ownFactionStrategy, {
    profile: 'wolf',
    publicWorld: '占い師の対抗COを選択肢として維持する。',
    dayWinPath: '真占い師のCO後は信用勝負への移行を比較する。',
    partnerDisposition: 'save',
    collapsePlan: '信用差が開いたら潜伏役を優先する。',
    failureRisk: '対抗COで二狼位置が狭まること。',
  });

  const decide = buildDecideStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'decide', taskType: 'speech' }) });
  const analyze = buildAnalyzeStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'analyze', taskType: 'speech' }) });
  const critique = buildCritiqueStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'critique', taskType: 'speech' }), analysisText: '対抗COを比較する。' });
  const finalize = buildFinalizeStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'finalize', taskType: 'speech' }), analysisText: '対抗COを比較する。' });
  for (const prompt of [decide, analyze, critique, finalize]) {
    assert.match(prompt, /ownFactionStrategy/u);
    assert.match(prompt, /占い師の対抗COを選択肢として維持する/u);
    assert.doesNotMatch(prompt, /updatedAt|sourceAiTurnId|ai-turn-secret-id/u);
  }
  assert.match(decide, /本人限定の現在戦術/u);
  assert.match(finalize, /本人限定の現在戦術/u);
});

test('Decideは公開履歴射影だけを使い生イベント管理情報・空値・内部UUIDを渡さない', () => {
  const playerId = 'player-64a90611-8b3f-4c89-afbc-e8748dcd2935';
  const otherId = 'player-b6615b15-88c5-42d5-b63d-33914c3f75f4';
  const eventId = 'event-11111111-2222-4333-8444-555555555555';
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource.currentMoment = { day: 1, phase: 'discussion', taskType: 'speech', playerId, playerName: 'ずんだもん' };
  taskArtifact.stageSource.publicState = { alivePlayers: [{ id: playerId, name: 'ずんだもん' }, { id: otherId, name: 'めたん' }], deadPlayers: [], publicLocks: {}, currentVoteState: null, recentOutcomeSummary: [] };
  taskArtifact.stageSource.privateState = { ownRole: { roleId: 'villager', team: 'village' }, teammates: {}, ownAbilityResults: [], privateLocks: {} };
  taskArtifact.stageSource.roleTaskData = { promptGuidance: {}, validTargetIds: [], emptyArray: [], emptyObject: {}, emptyText: '', sourceQuestionEventId: eventId };
  taskArtifact.stageSource.histories = {
    publicHistoryMode: 'full',
    publicHistoryProjection: { rows: [{ sequence: 7, actor: 'めたん', text: '占い師ではないよ。' }] },
    recentPublicTimeline: [{ id: eventId, sequence: 7, type: 'public-speech', actorId: otherId, payload: { text: '占い師ではないよ。' }, opportunityContext: { queuePosition: 2 } }],
    existingInternalMemo: {}, privateTeamStrategy: null,
  };
  const prompt = buildDecideStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'decide', taskType: 'speech' }) });
  assert.match(prompt, /publicHistoryProjection/u);
  assert.match(prompt, /占い師ではないよ。/u);
  assert.doesNotMatch(prompt, /recentPublicTimeline|opportunityContext/u);
  assert.doesNotMatch(prompt, /player-[0-9a-f-]{36}|event-[0-9a-f-]{36}/iu);
  assert.doesNotMatch(prompt, /emptyArray|emptyObject|emptyText/u);
});

test('Renderは内部UUIDを漏らさず公開名とイベント番号だけを境界へ出す', () => {
  const playerId = 'player-64a90611-8b3f-4c89-afbc-e8748dcd2935';
  const otherId = 'player-b6615b15-88c5-42d5-b63d-33914c3f75f4';
  const eventId = 'event-11111111-2222-4333-8444-555555555555';
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource.currentMoment = { day: 1, phase: 'discussion', taskType: 'speech', playerId, playerName: 'ずんだもん' };
  taskArtifact.stageSource.publicState = { alivePlayers: [{ id: playerId, name: 'ずんだもん' }, { id: otherId, name: 'めたん' }], deadPlayers: [], activeClaims: [], publicAbilityClaims: [] };
  taskArtifact.stageSource.histories = { recentPublicTimeline: [{ id: eventId, sequence: 12, type: 'public-speech', actorId: otherId, payload: { text: '質問するね。' } }], publicHistoryProjection: { rows: [{ sequence: 12, actor: 'めたん', text: '質問するね。' }] } };
  taskArtifact.stageSource.characterExpression = { callNames: [] };
  taskArtifact.stageSource.promptPolicies = { publicSpeechLengthPolicy: { targetChars: 120 }, outputLimits: { maxPublicSpeechLength: 450, maxHeartVoiceLength: 120 } };
  const candidateObject = { publicSpeech: 'めたんの質問には答える。', speechInteraction: { questionTargets: [otherId], answerToRefs: [12] }, decisionPatch: { suspects: [otherId], evidenceRefs: [12] } };
  const policy = resolveGenerationStagePromptPolicy({ stageId: 'render', taskType: 'speech', candidateObject, presentTopLevelKeys: Object.keys(candidateObject) });
  const prompt = buildRenderStagePrompt({ taskArtifact, candidateObject, policy });
  assert.doesNotMatch(prompt, /player-[0-9a-f-]{36}|event-[0-9a-f-]{36}/iu);
  assert.match(prompt, /めたん/u);
  assert.match(prompt, /12/u);
  assert.match(prompt, /文の分割・統合/u);
});

test('墓場のDecideは生前decision・推理人物設定・memoAddを再提示せず秘密共有と感想へ寄せる', () => {
  const taskArtifact = artifact('graveyard-conversation');
  taskArtifact.stageSource.currentMoment = { day: 2, phase: 'night', taskType: 'graveyard-conversation', playerId: 'dead-a', playerName: 'ずんだもん' };
  taskArtifact.stageSource.publicState = { alivePlayers: [{ id: 'alive-a', name: 'めたん' }], deadPlayers: [{ id: 'dead-a', name: 'ずんだもん' }] };
  taskArtifact.stageSource.privateState = { ownRole: { roleId: 'seer', team: 'village' }, ownAbilityResults: [{ day: 1, targetName: 'めたん', result: 'human' }] };
  taskArtifact.stageSource.roleTaskData = { decision: { suspects: ['めたん'] }, promptGuidance: { graveyardConversationGuidance: { participantStatus: 'new', focus: '秘密共有' } } };
  taskArtifact.stageSource.characterReasoning = { reasoningProfile: { evidenceFocus: 'timeline' }, discussionBehavior: 'aggressive' };
  taskArtifact.stageSource.histories = { recentGraveyardConversation: [], pastGraveyardConversations: [], existingInternalMemo: { summary: '生前メモ' } };
  taskArtifact.stageSource.responseContract = { mode: 'graveyard', allowedTopLevelKeys: ['graveyardMessage', 'memoAdd'], requiredTopLevelKeys: ['graveyardMessage'], optionalTopLevelKeys: ['memoAdd'], fieldDescriptions: { graveyardMessage: '墓場会話', memoAdd: '内部メモ' }, completeExample: { graveyardMessage: '墓場会話', memoAdd: '追記' }, conditionalExamples: {} };
  const prompt = buildDecideStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'decide', taskType: 'graveyard-conversation' }) });
  assert.match(prompt, /生前の秘密、答え合わせ、感想/u);
  assert.match(prompt, /graveyardConversationGuidance/u);
  assert.doesNotMatch(prompt, /"decision"/u);
  assert.doesNotMatch(prompt, /reasoning-character|memoAdd/u);
});

test('Decideは人物の判断傾向を使うが表現設定を使わず、Analyzeは人物設定を使わず、Finalizeは両方を戻す', () => {
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource.characterReasoning = { profile: '慎重に比較する人物', reasoningProfile: { evidenceFocus: 'timeline' }, discussionBehavior: '質問を重ねる' };
  taskArtifact.stageSource.characterExpression = { profile: '明るい人物', firstPerson: 'ボク', speakingStyle: '元気な口調', defaultEndings: '〜なのだ', speechExamples: 'そう思うのだ！', callNames: [] };
  const decide = buildDecideStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'decide', taskType: 'speech' }) });
  const analyze = buildAnalyzeStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'analyze', taskType: 'speech' }) });
  const finalize = buildFinalizeStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'finalize', taskType: 'speech' }), analysisText: 'Aを比較する。' });
  assert.match(decide, /慎重に比較する人物|evidenceFocus|質問を重ねる/u);
  assert.doesNotMatch(decide, /ボク|元気な口調|なのだ|そう思うのだ/u);
  assert.doesNotMatch(analyze, /慎重に比較する人物|evidenceFocus|質問を重ねる|ボク|元気な口調|なのだ/u);
  assert.match(finalize, /慎重に比較する人物|evidenceFocus|質問を重ねる/u);
  assert.match(finalize, /ボク|元気な口調|なのだ|そう思うのだ/u);
  assert.match(finalize, /Aを比較する/u);
  assert.match(analyze, /最大10項目、全体1600文字以内/u);
  const critique = buildCritiqueStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'critique', taskType: 'speech' }), analysisText: 'Aを比較する。' });
  assert.match(critique, /最大6項目、全体1000文字以内/u);
  assert.match(critique, /矛盾、虚偽、説明不足が誰の発言・行動に存在する問題か/u);
  assert.match(critique, /別の人物の疑い材料へ転嫁していないか/u);
  const finalizeWithoutReferences = buildFinalizeStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'finalize', taskType: 'speech' }), analysisText: '', critiqueText: '' });
  assert.doesNotMatch(finalizeWithoutReferences, /analysis-reference|分析資料/u);
  assert.match(finalizeWithoutReferences, /現在のゲーム情報から、今回の行動と発言を決定してください/u);
});

test('工程別EnvelopeはDirectとAnalyze/Critiqueで必要な区画だけを投影する', () => {
  const baseEnvelope = artifact().promptEnvelope;
  const direct = projectGenerationStagePromptEnvelope({ baseEnvelope, stageId: 'direct', prompt: 'DIRECT' });
  assert.equal(direct.commonSystemInstruction, 'SYSTEM');
  assert.equal(direct.commonGameContext, 'GAME');
  assert.equal(direct.taskInvariantContext, 'INVARIANT');
  assert.equal(direct.taskVariableContext, 'VARIABLE');
  assert.equal(direct.stablePlayerContext, 'STYLE_AND_REASONING');
  assert.deepEqual(direct.structuredOutput, baseEnvelope.structuredOutput);

  const decide = projectGenerationStagePromptEnvelope({ baseEnvelope, stageId: 'decide', prompt: 'DECIDE' });
  assert.equal(decide.stablePlayerContext, '');
  assert.equal(decide.taskInvariantContext, 'INVARIANT');
  assert.ok(decide.structuredOutput);

  for (const stageId of ['analyze', 'critique']) {
    const projected = projectGenerationStagePromptEnvelope({ baseEnvelope, stageId, prompt: stageId });
    assert.equal(projected.commonSystemInstruction, '');
    assert.equal(projected.commonGameContext, 'GAME');
    assert.equal(projected.taskInvariantContext, '');
    assert.equal(projected.taskVariableContext, '');
    assert.equal(projected.stablePlayerContext, '');
    assert.equal(projected.structuredOutput, null);
  }

  const finalize = projectGenerationStagePromptEnvelope({ baseEnvelope, stageId: 'finalize', prompt: 'FINALIZE' });
  assert.equal(finalize.stablePlayerContext, '');
  assert.equal(finalize.taskInvariantContext, 'INVARIANT');
  assert.ok(finalize.structuredOutput);

  const render = projectGenerationStagePromptEnvelope({ baseEnvelope, stageId: 'render', prompt: 'RENDER' });
  assert.equal(render.commonGameContext, '');
  assert.equal(render.structuredOutput, null);
});

test('公開発言のプロンプト上限は目安の1.5倍をDirect用ルールとDecideで共通利用する', () => {
  const speechPolicy = { targetChars: 80 };
  const directReminder = renderFinalResponseReminder({ taskType: 'speech', roleId: 'villager', publicSpeechPolicy: speechPolicy, maxPublicSpeechLength: 450, maxHeartVoiceLength: 120 });
  assert.match(directReminder, /公開発言: 目安は約80文字、上限は約120文字/u);
  const taskArtifact = artifact('speech');
  taskArtifact.stageSource.promptPolicies = { publicSpeechLengthPolicy: speechPolicy, outputLimits: { maxPublicSpeechLength: 450, maxHeartVoiceLength: 120 } };
  const prompt = buildDecideStagePrompt({ taskArtifact, policy: resolveGenerationStagePromptPolicy({ stageId: 'decide', taskType: 'speech' }) });
  assert.match(prompt, /公開発言: 目安は約80文字、上限は約120文字/u);
});
test('対象文章がないRenderはAPIを呼ばずskippedで記録する', async () => {
  const plan = { depth: 2, ownerProfileId: 'owner', taskCategory: 'vote', normalCallCount: 2, maximumCallBudget: 5, stages: [
    { stageId: 'decide', executorProfileId: 'owner' }, { stageId: 'render', executorProfileId: 'owner' },
  ] };
  let patchCalls = 0;
  const result = await runGenerationPipeline({
    plan, taskArtifact: artifact('vote'), evaluateCandidate: evaluate, ...builders,
    requestFullCandidate: async () => ({ ok: true, rawResponse: '{"actionAnswer":"p2"}', attemptCount: 1 }),
    requestFreeText: async () => { throw new Error('呼ばれない'); },
    requestTextPatch: async () => { patchCalls += 1; return { ok: false }; },
  });
  assert.equal(patchCalls, 0);
  assert.equal(result.generationRun.totalCallCount, 1);
  assert.equal(result.generationRun.stages[1].status, 'skipped');
  assert.equal(result.generationRun.finalStageId, 'decide');
});
