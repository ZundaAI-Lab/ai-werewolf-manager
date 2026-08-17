/**
 * 責務: 自動実行セッションの停止、API要求ID管理、中断可能待機を実動作で検証する。
 * 変更ルール: 実装文字列ではなく、停止後に待機と新規要求が継続しないことを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRunControl() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto });
  const source = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/automationRunControl.js'), 'utf8').replace(/\nexport \{\};\s*$/u, '\n');
  vm.runInContext(source, context, { filename: 'automationRunControl.js' });
  return context.AiWerewolfAutomationRunControl;
}

test('再試行待機は停止要求でタイマー満了前に中断する', async () => {
  const control = loadRunControl();
  const session = control.createRunSession();
  const startedAt = Date.now();
  const waiting = control.delayWithAbort(10000, session);
  control.requestStop(session);
  await assert.rejects(waiting, (error) => error?.code === 'AUTOMATION_STOPPED');
  assert.ok(Date.now() - startedAt < 1000);
});


test('古いセッションの停止は新しいセッションへ影響しない', () => {
  const control = loadRunControl();
  const oldSession = control.createRunSession();
  const newSession = control.createRunSession();
  control.requestStop(oldSession);
  assert.equal(control.isStopped(oldSession), true);
  assert.equal(control.isStopped(newSession), false);
  assert.doesNotThrow(() => control.assertRunning(newSession));
});


test('停止後の画面遷移は実行セッションの終了完了まで待機できる', async () => {
  const control = loadRunControl();
  const session = control.createRunSession();
  let completed = false;
  const waiting = control.waitForCompletion(session).then(() => { completed = true; });

  control.requestStop(session);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, false, '停止要求だけで終了完了扱いにしてはいけない');

  assert.equal(control.completeSession(session), true);
  await waiting;
  assert.equal(completed, true);
  assert.equal(control.completeSession(session), false, '終了完了通知は一度だけ行う');
  await control.waitForCompletion(session);
});
