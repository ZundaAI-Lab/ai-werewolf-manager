/**
 * 責務: 全自動実行がプロファイル利用上限へ到達したとき、汎用エラー停止ではなく設定変更後に再開できる一時停止へ移ることを確認する。
 * 変更ルール: Provider通信や予算計算は専用テストへ委譲し、ここではCoordinatorの停止種別とゲーム未進行状態だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function loadFactory() {
  const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/automaticRunCoordinator.js'), 'utf8'));
  const window = { setTimeout, clearTimeout };
  window.window = window;
  const context = vm.createContext({ window, globalThis: window, console, setTimeout, clearTimeout, Promise, Error });
  vm.runInContext(source, context, { filename: 'automaticRunCoordinator.js' });
  return vm.runInContext('createAutomaticRunCoordinator', context);
}

function budgetError() {
  const error = new Error('利用上限に達しました。');
  error.apiError = {
    code: 'PROFILE_BUDGET_EXCEEDED',
    message: '利用上限に達しました。',
    retryable: false,
    deliveryUnknown: false,
    retryAfterMs: null,
  };
  return error;
}

test('利用上限到達はpausedへ移り、同じ未処理タスクを残して再開可能にする', async () => {
  const createCoordinator = loadFactory();
  const state = { revision: 7, game: { id: 'g1', phase: 'discussion' } };
  const controller = {
    settings: { executionMode: 'automatic', autoRun: { autoPublish: true, maxConsecutiveSteps: 20, intervalMs: 0 } },
    running: false,
    stepping: false,
    automationMode: 'idle',
    runSession: null,
  };
  const modes = [];
  const statuses = [];
  const toasts = [];
  const runtimeApi = {
    resolveAutomaticAction: () => ({ kind: 'ai-task', taskRequest: { playerId: 'p1', taskType: 'speech', slotId: '' } }),
    executeAutomaticAction: () => { throw new Error('未使用'); },
    beginAutomaticNotifications() {},
    endAutomaticNotifications() {},
    toast(message, type, options) { toasts.push({ message, type, options }); },
  };
  const sessions = new Set();
  const automationRunControl = {
    createRunSession() { const session = { stopped: false }; sessions.add(session); return session; },
    assertRunning(session) { if (session.stopped) throw new Error('stopped'); },
    isStopped: (session) => Boolean(session.stopped),
    delayWithAbort: async () => {},
    isAutomationStoppedError: () => false,
    completeSession(session) { sessions.delete(session); },
    requestStop(session) { if (session) session.stopped = true; },
    waitForCompletion: async () => {},
  };
  const coordinator = createCoordinator({
    apiRetryPolicy: { apiErrorMessage: (error) => error.message ?? '' },
    automationRunControl,
    bridge: { cancelRequest: async () => {} },
    controller,
    currentGameState: () => state,
    dialogError: () => '',
    enableLiveView() {},
    executeAiStep: async () => { throw budgetError(); },
    openManualAiTask: async () => {},
    playerName: () => 'ずんだもん',
    refreshLiveView() {},
    runtime: () => runtimeApi,
    setAutomationMode(mode, detail = null) { controller.automationMode = mode; controller.automationDetail = detail; modes.push(mode); },
    setStatus(message, type) { statuses.push({ message, type }); },
    updateButtons() {},
    usesManualAiGeneration: () => false,
  });

  await coordinator.runLoop();

  assert.equal(state.revision, 7, '利用上限エラーではゲーム状態を進めない');
  assert.equal(controller.automationMode, 'paused');
  assert.equal(modes.includes('error'), false);
  assert.match(statuses.at(-1).message, /利用上限.*変更してから再開/u);
  assert.equal(toasts.at(-1).type, 'warning');
  assert.equal(controller.running, false);
  assert.equal(controller.runSession, null);
});

test('全自動ループだけが並列バッチを使用し登録件数をステップ数へ加算する', async () => {
  const createCoordinator = loadFactory();
  const state = { revision: 0, game: { id: 'g1', phase: 'vote' } };
  let batchDone = false;
  let batchCalls = 0;
  let singleCalls = 0;
  const controller = {
    settings: {
      executionMode: 'automatic',
      autoRun: { autoPublish: true, maxConsecutiveSteps: 20, intervalMs: 0 },
      aiOptions: { parallelExecutionMode: 'auto' },
    },
    running: false,
    stepping: false,
    automationMode: 'idle',
    runSession: null,
  };
  const runtimeApi = {
    resolveAutomaticAiBatch: () => batchDone ? { kind: 'none' } : {
      kind: 'ai-task-batch',
      taskRequests: [
        { playerId: 'p1', taskType: 'vote', slotId: '' },
        { playerId: 'p2', taskType: 'vote', slotId: '' },
      ],
    },
    resolveAutomaticAction: () => batchDone
      ? { kind: 'ended', reason: 'done' }
      : { kind: 'ai-task', taskRequest: { playerId: 'p1', taskType: 'vote', slotId: '' } },
    executeAutomaticAction: () => ({ ok: true }),
    beginAutomaticNotifications() {},
    endAutomaticNotifications() {},
    toast() {},
  };
  const automationRunControl = {
    createRunSession() { return { stopped: false }; },
    assertRunning(session) { if (session.stopped) throw new Error('stopped'); },
    isStopped: (session) => Boolean(session.stopped),
    delayWithAbort: async () => {},
    isAutomationStoppedError: () => false,
    completeSession() {},
    requestStop(session) { if (session) session.stopped = true; },
    waitForCompletion: async () => {},
    activeRequestIds: () => [],
  };
  const coordinator = createCoordinator({
    apiRetryPolicy: { apiErrorMessage: (error) => error.message ?? '' },
    automationRunControl,
    bridge: { cancelRequest: async () => {} },
    controller,
    currentGameState: () => state,
    dialogError: () => '',
    enableLiveView() {},
    executeAiStep: async () => { singleCalls += 1; state.revision += 1; },
    executeAiBatch: async () => {
      batchCalls += 1;
      state.revision += 2;
      batchDone = true;
      return { status: 'advanced', advancedCount: 2 };
    },
    openManualAiTask: async () => {},
    playerName: (id) => id,
    refreshLiveView() {},
    runtime: () => runtimeApi,
    setAutomationMode(mode) { controller.automationMode = mode; },
    setStatus() {},
    updateButtons() {},
    usesManualAiGeneration: () => false,
  });

  await coordinator.runLoop();
  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
  assert.equal(controller.completedSteps, 2);
});

test('停止時は並列実行中の全requestIdをキャンセルする', async () => {
  const createCoordinator = loadFactory();
  const session = { stopped: false, activeRequestIds: new Set(['req-a', 'req-b']) };
  const cancelled = [];
  const controller = {
    settings: { executionMode: 'automatic', autoRun: { autoPublish: true, maxConsecutiveSteps: 20, intervalMs: 0 }, aiOptions: { parallelExecutionMode: 'auto' } },
    running: true,
    stepping: false,
    runSession: session,
  };
  const automationRunControl = {
    requestStop(target) { target.stopped = true; },
    activeRequestIds(target) { return [...target.activeRequestIds]; },
    waitForCompletion: async () => {},
  };
  const coordinator = createCoordinator({
    apiRetryPolicy: { apiErrorMessage: (error) => error.message ?? '' },
    automationRunControl,
    bridge: { async cancelRequest(id) { cancelled.push(id); return { ok: true }; } },
    controller,
    currentGameState: () => ({ revision: 0, game: {} }),
    dialogError: () => '',
    enableLiveView() {},
    executeAiStep: async () => {},
    executeAiBatch: async () => ({ status: 'advanced', advancedCount: 2 }),
    openManualAiTask: async () => {},
    playerName: (id) => id,
    refreshLiveView() {},
    runtime: () => ({}),
    setAutomationMode() {},
    setStatus() {},
    updateButtons() {},
    usesManualAiGeneration: () => false,
  });

  await coordinator.stopLoop();
  assert.deepEqual(cancelled.sort(), ['req-a', 'req-b']);
});

test('AI役職通知command batchは待機間隔を挟まず連続処理する', async () => {
  const createCoordinator = loadFactory();
  const state = { revision: 0, game: { id: 'g1', phase: 'briefing' } };
  let commandIndex = 0;
  const controller = {
    settings: {
      executionMode: 'automatic',
      autoRun: { autoPublish: true, maxConsecutiveSteps: 20, intervalMs: 0 },
      aiOptions: { parallelExecutionMode: 'auto' },
    },
    running: false,
    stepping: false,
    automationMode: 'idle',
    runSession: null,
  };
  const commands = [
    { kind: 'command', command: 'complete-ai-briefing', label: 'AI役職通知', playerId: 'p1' },
    { kind: 'command', command: 'complete-ai-briefing', label: 'AI役職通知', playerId: 'p2' },
  ];
  const runtimeApi = {
    resolveAutomaticAiBatch: () => commandIndex < 2 ? {
      kind: 'command-batch',
      source: 'briefing',
      commandRequests: commands.map(({ command, label, playerId }) => ({ command, label, playerId })),
    } : { kind: 'none' },
    resolveAutomaticAction: () => commandIndex < commands.length ? commands[commandIndex] : { kind: 'ended', reason: 'done' },
    executeAutomaticAction() { state.revision += 1; commandIndex += 1; return { ok: true }; },
    beginAutomaticNotifications() {},
    endAutomaticNotifications() {},
    toast() {},
  };
  const automationRunControl = {
    createRunSession() { return { stopped: false }; },
    assertRunning(session) { if (session.stopped) throw new Error('stopped'); },
    isStopped: (session) => Boolean(session.stopped),
    delayWithAbort: async () => {},
    isAutomationStoppedError: () => false,
    completeSession() {},
    requestStop(session) { if (session) session.stopped = true; },
    waitForCompletion: async () => {},
    activeRequestIds: () => [],
  };
  const memoScheduler = {
    assertHealthy() {}, pendingPlayerIds: () => [], waitForPlayer: async () => {}, waitForPlayers: async () => {}, waitForAll: async () => {}, settleAll: async () => {},
  };
  const coordinator = createCoordinator({
    apiRetryPolicy: { apiErrorMessage: (error) => error.message ?? '' },
    automationRunControl,
    automaticMemoConsolidationScheduler: memoScheduler,
    bridge: { cancelRequest: async () => {} },
    controller,
    currentGameState: () => state,
    dialogError: () => '',
    enableLiveView() {},
    executeAiStep: async () => { throw new Error('未使用'); },
    executeAiBatch: async () => { throw new Error('未使用'); },
    openManualAiTask: async () => {},
    playerName: (id) => id,
    refreshLiveView() {},
    runtime: () => runtimeApi,
    setAutomationMode(mode) { controller.automationMode = mode; },
    setStatus() {},
    updateButtons() {},
    usesManualAiGeneration: () => false,
  });

  await coordinator.runLoop();
  assert.equal(commandIndex, 2);
  assert.equal(controller.completedSteps, 2);
});

test('本人の内部メモ整理が通信中なら次AI生成前にbarrier完了を待つ', async () => {
  const createCoordinator = loadFactory();
  const state = { revision: 1, game: { id: 'g1', phase: 'discussion' } };
  const session = { stopped: false };
  let memoryReady = false;
  let waitCalls = 0;
  let generationCalls = 0;
  const controller = {
    settings: { executionMode: 'automatic', autoRun: { autoPublish: true, maxConsecutiveSteps: 20, intervalMs: 0 } },
    running: true,
    stepping: false,
    runSession: session,
  };
  const runtimeApi = {
    resolveAutomaticAction: () => ({ kind: 'ai-task', taskRequest: { playerId: 'p1', taskType: 'speech', slotId: '' } }),
    executeAutomaticAction: () => ({ ok: true }),
  };
  const coordinator = createCoordinator({
    apiRetryPolicy: { apiErrorMessage: (error) => error.message ?? '' },
    automationRunControl: {
      assertRunning(target) { if (target.stopped) throw new Error('stopped'); },
      isStopped: (target) => Boolean(target.stopped),
    },
    automaticMemoConsolidationScheduler: {
      assertHealthy() {},
      pendingPlayerIds: () => memoryReady ? [] : ['p1'],
      async waitForPlayer(playerId) { assert.equal(playerId, 'p1'); waitCalls += 1; memoryReady = true; },
    },
    bridge: { cancelRequest: async () => {} },
    controller,
    currentGameState: () => state,
    dialogError: () => '',
    enableLiveView() {},
    executeAiStep: async () => { assert.equal(memoryReady, true); generationCalls += 1; },
    executeAiBatch: async () => ({ status: 'advanced', advancedCount: 2 }),
    openManualAiTask: async () => {},
    playerName: (id) => id,
    refreshLiveView() {},
    runtime: () => runtimeApi,
    setAutomationMode() {},
    setStatus() {},
    updateButtons() {},
    usesManualAiGeneration: () => false,
  });

  const result = await coordinator.performOneStep(session);
  assert.equal(result.status, 'advanced');
  assert.equal(waitCalls, 1);
  assert.equal(generationCalls, 1);
});
