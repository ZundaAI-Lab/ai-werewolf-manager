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
