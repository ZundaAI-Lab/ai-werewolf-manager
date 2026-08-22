/**
 * 責務: Renderer未捕捉エラー通知、出力ファイル名正規化、配布物のbundle済みソース重複排除という実行境界の安全策を挙動と設定値から検証する。
 * 変更ルール: 製品ソースの実装文字列をgrepしない。利用者通知へ詳細を漏らさないこと、ユーザー由来の出力ファイル名を共通正規化すること、配布設定が生成bundleを正本とすることだけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

const projectRoot = join(__dirname, '..', '..', '..');
const reporterSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'app', 'globalErrorReporter.js'), 'utf8');
const builder = JSON.parse(readFileSync(join(projectRoot, 'tools', 'build', 'electron-builder.json'), 'utf8'));
const utilsSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'shared', 'utils.js'), 'utf8');

function loadGlobalErrorReporter() {
  const context = vm.createContext({ console, Error, Date, TypeError });
  vm.runInContext(esmSourceAsVmScript(reporterSource), context, { filename: 'globalErrorReporter.js' });
  return vm.runInContext('installGlobalErrorReporter', context);
}

function createEventTargetStub() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

test('未捕捉Rendererエラーは詳細をconsoleだけへ残し安全な要約toastを重複抑制して表示する', () => {
  const installGlobalErrorReporter = loadGlobalErrorReporter();
  const target = createEventTargetStub();
  const logs = [];
  const toasts = [];
  let currentTime = 1000;
  let preventDefaultCount = 0;
  const cleanup = installGlobalErrorReporter({
    target,
    logger: { error: (...args) => logs.push(args) },
    toast: (...args) => toasts.push(args),
    now: () => currentTime,
    dedupeWindowMs: 5000,
  });

  const secretError = new Error('secret-api-response');
  target.listeners.get('error')({ error: secretError, preventDefault: () => { preventDefaultCount += 1; } });
  target.listeners.get('error')({ error: secretError, preventDefault: () => { preventDefaultCount += 1; } });
  assert.equal(logs.length, 2, 'ブラウザ既定ログとは別に毎回詳細をconsoleへ残す');
  assert.equal(toasts.length, 1, '同一原因の短時間連続toastは抑制する');
  assert.doesNotMatch(String(toasts[0][0]), /secret-api-response/u);
  assert.match(String(toasts[0][0]), /開発者コンソール/u);
  assert.equal(preventDefaultCount, 0, '既定の例外伝播を握り潰さない');
  currentTime += 6000;
  target.listeners.get('unhandledrejection')({ reason: new Error('private-rejection') });
  assert.equal(toasts.length, 2);
  assert.doesNotMatch(String(toasts[1][0]), /private-rejection/u);
  assert.match(String(toasts[1][0]), /非同期処理エラー/u);

  cleanup();
  assert.equal(target.listeners.size, 0);
});


test('出力ファイル名部品はWindows禁止文字・制御文字・末尾ドット空白を共通規則で除去する', () => {
  const context = vm.createContext({ console, Intl, Date, Math, JSON, Object, Array, Set, String, Number, globalThis: {} });
  vm.runInContext(esmSourceAsVmScript(utilsSource), context, { filename: 'utils.js' });
  const sanitizeFilenamePart = vm.runInContext('sanitizeFilenamePart', context);
  const sanitized = sanitizeFilenamePart('  test\\bad/name?\u0001.  ', { fallback: 'fallback' });
  assert.equal(sanitized, 'test_bad_name__');
  assert.doesNotMatch(sanitized, /[\\/:*?"<>|\u0000-\u001f]/u);
  assert.doesNotMatch(sanitized, /[. ]$/u);
  assert.equal(sanitizeFilenamePart('   ', { fallback: 'fallback' }), 'fallback');
  assert.equal(sanitizeFilenamePart('profile name', { whitespaceReplacement: '-', maxLength: 60 }), 'profile-name');
});

test('配布物はgenerated bundleを正本としbundle済みAI・automationソースを二重同梱しない', () => {
  const files = builder.files ?? [];
  assert.ok(files.includes('renderer/generated/bundle.js'));
  assert.ok(!files.includes('renderer/js/ai/**/*'));
  assert.ok(!files.includes('renderer/js/automation/**/*'));
});
