/**
 * 責務: 自動実行セッションの停止、API要求ID管理、中断可能待機を、壁時計へ依存せず実動作で検証する。
 * 変更ルール: 実時間の経過やCI速度を合否条件にしない。待機の登録・取消・停止通知・終了通知という状態変化だけを決定的に確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function createFakeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      scheduled.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    pendingCount() {
      return scheduled.size;
    },
    delays() {
      return [...scheduled.values()].map((item) => item.milliseconds);
    },
  };
}

function loadRunControl({ timers = createFakeTimers() } = {}) {
  const context = vm.createContext({
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    AbortController,
    crypto: globalThis.crypto,
  });
  const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/automationRunControl.js'), 'utf8'));
  vm.runInContext(source, context, { filename: 'automationRunControl.js' });
  return {
    control: vm.runInContext('({ createRunSession, isStopped, assertRunning, requestStop, beginRequest, endRequest, delayWithAbort, completeSession, waitForCompletion, isAutomationStoppedError })', context),
    timers,
  };
}

test('再試行待機は停止要求で登録済みタイマーを取り消して中断する', async () => {
  const { control, timers } = loadRunControl();
  const session = control.createRunSession();
  const waiting = control.delayWithAbort(10000, session);

  assert.deepEqual(timers.delays(), [10000]);
  control.requestStop(session);

  await assert.rejects(waiting, (error) => error?.code === 'AUTOMATION_STOPPED');
  assert.equal(timers.pendingCount(), 0, '停止時に待機タイマーを残さない');
});

test('古いセッションの停止は新しいセッションへ影響しない', () => {
  const { control } = loadRunControl();
  const oldSession = control.createRunSession();
  const newSession = control.createRunSession();
  control.requestStop(oldSession);
  assert.equal(control.isStopped(oldSession), true);
  assert.equal(control.isStopped(newSession), false);
  assert.doesNotThrow(() => control.assertRunning(newSession));
});

test('停止要求だけでは終了完了にせずcompleteSessionで一度だけ完了する', async () => {
  const { control } = loadRunControl();
  const session = control.createRunSession();
  let completed = false;
  const waiting = control.waitForCompletion(session).then(() => { completed = true; });

  control.requestStop(session);
  await Promise.resolve();
  assert.equal(completed, false, '停止要求だけで終了完了扱いにしてはいけない');

  assert.equal(control.completeSession(session), true);
  await waiting;
  assert.equal(completed, true);
  assert.equal(control.completeSession(session), false, '終了完了通知は一度だけ行う');
  await control.waitForCompletion(session);
});
