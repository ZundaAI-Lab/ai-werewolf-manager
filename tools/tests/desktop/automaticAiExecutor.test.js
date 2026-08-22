/**
 * 責務: AIタスク実行層の停止境界、state由来Envelope送信、公開履歴全文再試行、投票時Ollama限定Thinking降格、登録境界を実動作で検証する。
 * 変更ルール: DOMや画面文字列を固定せず、偽Bridge・Runtime・実行セッションを注入する。Mainへ渡す要求は現在のpromptEnvelope中心の要求構造を直接検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function loadAutomationModules() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto });
  for (const filename of ['automationRunControl.js', 'automaticAiExecutor.js']) {
    const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation', filename), 'utf8'));
    vm.runInContext(source, context, { filename });
  }
  return {
    runControl: vm.runInContext('({ createRunSession, isStopped, assertRunning, requestStop, beginRequest, endRequest, delayWithAbort, completeSession, waitForCompletion, isAutomationStoppedError })', context),
    executorApi: vm.runInContext('({ createAutomaticAiExecutor, replaceTaskArtifact, buildFullCandidateStagePrompt })', context),
  };
}

function createHarness({
  bridgeGenerate,
  apiDecision = () => ({ type: 'stop', delayMs: 0 }),
  responseDecision = () => ({ action: 'stop', signature: 'stop', issues: [] }),
  initialStage = 'direct',
  evaluate = (rawResponse) => rawResponse === 'VALID'
    ? { ok: true, effectiveRawResponse: rawResponse, candidateObject: {}, presentTopLevelKeys: [], issues: [], autoRepair: { operations: [] } }
    : { ok: false, effectiveRawResponse: rawResponse, issues: [{ code: 'INVALID', message: 'invalid' }], validation: { errors: ['invalid'] }, autoRepair: { operations: [] } },
  generationFailureRequiresStop = () => false,
  taskType = 'speech',
  ownerProfileOverrides = {},
} = {}) {
  const modules = loadAutomationModules();
  const state = { revision: 0, game: { id: 'game::A' }, players: [{ id: 'player-B', name: 'AIプレイヤー' }] };
  const ownerProfile = { id: 'profile-C', enabled: true, ...ownerProfileOverrides };
  const controller = {
    settings: {
      profiles: [ownerProfile],
      aiOptions: { publicHistoryMode: 'delta', responseRecoveryMode: 'repair-regenerate', apiErrorAction: 'retry' },
      autoRun: { autoConfirmWarnings: true },
    },
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, calls: 0, failedCalls: 0, retries: 0 },
  };
  const counters = { prepare: 0, candidateCommits: 0, fallbackCommits: 0, scheduleFull: 0, bridgeRequests: [] };

  function taskArtifact(forceFullPublicHistory = false) {
    counters.prepare += 1;
    const base = counters.prepare === 1 ? 'BASE-OLD' : 'BASE-NEW';
    return {
      text: base,
      systemInstruction: 'SYSTEM',
      taskType,
      publicHistoryMode: forceFullPublicHistory ? 'full' : 'delta',
      forceFullPublicHistory,
      promptEnvelope: {
        schemaVersion: 5,
        commonSystemInstruction: 'SYSTEM',
        commonGameContext: 'COMMON',
        taskInvariantContext: 'TASK-INVARIANT',
        taskVariableContext: 'TASK-VARIABLE',
        stablePlayerContext: 'PLAYER-STABLE',
        dynamicTaskPrompt: base,
        structuredOutput: null,
        cacheIdentity: {
          promptSpecVersion: 1,
          promptFamily: 'game-candidate',
          gameId: 'game::A',
          commonGameFingerprint: 'common-game-A',
        },
      },
    };
  }

  const runtimeApi = {
    prepareAiTask(options = {}) { return taskArtifact(Boolean(options.forceFullPublicHistory)); },
    resolveGenerationPlan() {
      return {
        depth: initialStage === 'draft' ? 3 : 1,
        ownerProfileId: ownerProfile.id,
        taskCategory: taskType, normalCallCount: 1, maximumCallBudget: 4, coreCallBudget: 4,
        stages: [{ stageId: initialStage, executorProfileId: ownerProfile.id }],
      };
    },
    resolveGenerationStagePromptPolicy() { return { applicable: true }; },
    buildDraftStagePrompt({ taskArtifact: artifact }) { return `DRAFT:${artifact.text}`; },
    buildRenderStagePrompt() { return 'RENDER'; },
    buildProofreadStagePrompt() { return 'PROOFREAD'; },
    evaluateAiTaskCandidate({ rawResponse }) { return evaluate(rawResponse); },
    async runGenerationPipeline(args) {
      const stage = { stageId: initialStage, executorProfileId: ownerProfile.id };
      const prompt = initialStage === 'draft'
        ? args.buildDraftPrompt({ taskArtifact: args.taskArtifact, policy: {} })
        : args.taskArtifact.promptEnvelope.dynamicTaskPrompt;
      const result = await args.requestFullCandidate({ stage, prompt, taskArtifact: args.taskArtifact, callBudget: 4 });
      const evaluation = result.evaluation ?? evaluate(result.rawResponse);
      if (!result.ok || !evaluation.ok) {
        const error = new Error('candidate failed');
        error.rawResponse = result.rawResponse;
        error.evaluation = evaluation;
        error.issues = result.issues;
        error.generationRun = { stages: [] };
        throw error;
      }
      return { rawResponse: result.rawResponse, evaluation, generationRun: { stages: [] } };
    },
    commitAiTaskCandidate() { counters.candidateCommits += 1; state.revision += 1; return { ok: true }; },
    commitAiTaskFallback() { counters.fallbackCommits += 1; state.revision += 1; return { ok: true, fallbackScope: 'field' }; },
    scheduleFullPublicHistory() { counters.scheduleFull += 1; },
    dismissToast() {}, toast() {},
  };

  const responseRetryPolicy = {
    normalizeRecoveryMode(value) { return value; }, decideNext: responseDecision,
    buildRepairPrompt({ originalPrompt }) { return `REPAIR:${originalPrompt}`; },
    buildRegenerationPrompt({ originalPrompt }) { return `REGENERATE:${originalPrompt}`; },
    phaseLabel(value) { return value; },
  };
  const bridge = {
    async generate(request) { counters.bridgeRequests.push(structuredClone(request)); return bridgeGenerate(request); },
  };
  const addUsage = (target, usage, { failed = false, retry = false } = {}) => {
    target.calls += failed ? 0 : 1;
    target.failedCalls += failed ? 1 : 0;
    target.retries += retry ? 1 : 0;
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) target[key] += Number(usage?.[key] ?? 0);
  };
  const executor = modules.executorApi.createAutomaticAiExecutor({
    apiRetryPolicy: { apiErrorMessage: (error) => error?.message ?? 'api error', decideApiRetry: apiDecision },
    responseRetryPolicy, runControl: modules.runControl, controller, bridge, runtime: () => runtimeApi,
    currentGameState: () => state, profileForPlayer: () => ownerProfile, profileById: () => ownerProfile,
    playerName: () => 'AIプレイヤー', addUsage, refreshUsageSummary: async () => {}, setStatus() {},
    waitFor: async (predicate, { message }) => { const result = predicate(); if (!result) throw new Error(message); return result; },
    structuredApiError: (error) => error?.apiError ?? { code: 'IPC_ERROR', message: error?.message ?? String(error), retryable: false, deliveryUnknown: false, retryAfterMs: null },
    apiErrorAsException: (apiError) => { const error = new Error(apiError?.message ?? 'api error'); error.apiError = apiError; return error; },
    generationFailureRequiresStop,
  });
  return { ...modules, state, controller, counters, executor, taskRequest: { playerId: 'player-B', taskType, slotId: '' } };
}

test('API通信中に停止した場合は後から応答しても登録しない', async () => {
  let resolveProvider;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const providerResponse = new Promise((resolve) => { resolveProvider = resolve; });
  const harness = createHarness({ bridgeGenerate: async () => { requestStarted(); return providerResponse; } });
  const session = harness.runControl.createRunSession();
  const execution = harness.executor(harness.taskRequest, session);
  await started;
  harness.runControl.requestStop(session);
  resolveProvider({ ok: true, text: 'VALID', usage: {} });
  await assert.rejects(execution, (error) => error?.code === 'AUTOMATION_STOPPED');
  assert.equal(harness.counters.candidateCommits, 0);
  assert.equal(harness.counters.fallbackCommits, 0);
});

test('delta要求はstate由来Envelopeを現在の要求構造で送る', async () => {
  const harness = createHarness({ bridgeGenerate: async () => ({ ok: true, text: 'VALID', usage: {} }) });
  await harness.executor(harness.taskRequest, harness.runControl.createRunSession());
  assert.equal(harness.counters.candidateCommits, 1);
  assert.equal(harness.counters.bridgeRequests.length, 1);
  const request = harness.counters.bridgeRequests[0];
  assert.equal(request.publicHistoryMode, 'delta');
  assert.equal(request.promptEnvelope.commonGameContext, 'COMMON');
  assert.equal(request.promptEnvelope.taskInvariantContext, 'TASK-INVARIANT');
  assert.equal(request.promptEnvelope.taskVariableContext, 'TASK-VARIABLE');
  assert.equal(request.promptEnvelope.stablePlayerContext, 'PLAYER-STABLE');
  assert.equal(request.promptEnvelope.dynamicTaskPrompt, 'BASE-OLD');
  assert.deepEqual(Object.keys(request).sort(), ['gameId', 'generationStage', 'isTaskCall', 'playerName', 'profileId', 'promptEnvelope', 'publicHistoryMode', 'regeneratedTask', 'requestId', 'requestPurpose', 'retryIndex', 'taskStart', 'taskType', 'thinkingLevelOverride'].sort());
  assert.doesNotMatch(JSON.stringify(request.promptEnvelope), /VALID|rawResponse|promptText/u);
});

test('公開発言コピー境界違反は項目代替へ流さず停止する', async () => {
  const harness = createHarness({
    bridgeGenerate: async () => ({ ok: true, text: 'INVALID', usage: {} }),
    responseDecision: () => ({ action: 'stop', signature: 'copy-boundary', issues: [] }),
    generationFailureRequiresStop: (error) => (error?.issues ?? []).some((issue) => issue.code === 'PUBLIC_SPEECH_COPIES_OTHER_PLAYER'),
    evaluate: (rawResponse) => ({
      ok: false, effectiveRawResponse: rawResponse,
      issues: [{ code: 'PUBLIC_SPEECH_COPIES_OTHER_PLAYER', message: 'copy boundary' }],
      validation: { errors: ['copy boundary'] }, autoRepair: { operations: [] },
    }),
  });
  await assert.rejects(
    harness.executor(harness.taskRequest, harness.runControl.createRunSession()),
    (error) => (error?.issues ?? []).some((issue) => issue.code === 'PUBLIC_SPEECH_COPIES_OTHER_PLAYER'),
  );
  assert.equal(harness.counters.candidateCommits, 0);
  assert.equal(harness.counters.fallbackCommits, 0);
});

test('Ollama投票でThinking最終応答欠落時だけ同一タスクをThinkingなしで再試行する', async () => {
  let calls = 0;
  const harness = createHarness({
    taskType: 'vote',
    ownerProfileOverrides: { provider: 'local', localServerPreset: 'ollama', thinkingLevel: 'low' },
    bridgeGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error: {
            code: 'OLLAMA_THINKING_FINAL_RESPONSE_MISSING',
            message: 'Thinkingだけが返されました。',
            retryable: false,
            deliveryUnknown: false,
          },
        };
      }
      return { ok: true, text: 'VALID', usage: {} };
    },
  });

  await harness.executor(harness.taskRequest, harness.runControl.createRunSession());

  assert.equal(harness.counters.candidateCommits, 1);
  assert.equal(harness.counters.bridgeRequests.length, 2);
  assert.equal(harness.counters.bridgeRequests[0].thinkingLevelOverride, null);
  assert.equal(harness.counters.bridgeRequests[1].thinkingLevelOverride, 'none');
  assert.equal(harness.controller.settings.profiles[0].thinkingLevel, 'low');
});

