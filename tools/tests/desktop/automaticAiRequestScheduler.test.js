/**
 * 責務: AI要求Schedulerが自動モードで外部APIを最大4並列、同一ローカル接続先を1並列へ制限し、有効モードでは設定値を使用することを確認する。
 * 変更ルール: Provider通信やゲームタスク順序を模倣せず、同時実行ゲートだけを決定的に検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function loadFactory() {
  const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/automaticAiRequestScheduler.js'), 'utf8'));
  const context = vm.createContext({ console, Promise, Error, URL });
  vm.runInContext(source, context, { filename: 'automaticAiRequestScheduler.js' });
  return vm.runInContext('createAutomaticAiRequestScheduler', context);
}

class AutomationStoppedError extends Error {
  constructor() {
    super('stopped');
    this.code = 'AUTOMATION_STOPPED';
  }
}

function runControl() {
  return {
    AutomationStoppedError,
    assertRunning(session) {
      if (session.abortController.signal.aborted) throw new AutomationStoppedError();
    },
  };
}

function session() {
  return { abortController: new AbortController() };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function controlledOperation(started, releases, id) {
  return () => new Promise((resolve) => {
    started.push(id);
    releases.set(id, resolve);
  });
}

test('自動モードの外部APIは全プロファイル合計4要求まで同時開始する', async () => {
  const createScheduler = loadFactory();
  const controller = { settings: { aiOptions: { parallelExecutionMode: 'auto' } } };
  const scheduler = createScheduler({ controller, runControl: runControl(), localProviderId: 'local-openai-compatible' });
  const started = [];
  const releases = new Map();
  const jobs = Array.from({ length: 6 }, (_, index) => scheduler.run(
    { id: `p${index}`, provider: 'openai', endpoint: '' },
    session(),
    controlledOperation(started, releases, index),
  ));
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  [0, 1, 2, 3].forEach((id) => releases.get(id)());
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  [4, 5].forEach((id) => releases.get(id)());
  await Promise.all(jobs);
});

test('自動モードの同一ローカル接続先は1要求ずつ実行する', async () => {
  const createScheduler = loadFactory();
  const controller = { settings: { aiOptions: { parallelExecutionMode: 'auto' } } };
  const scheduler = createScheduler({ controller, runControl: runControl(), localProviderId: 'local-openai-compatible' });
  const started = [];
  const releases = new Map();
  const profile = { provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/chat/completions' };
  const jobs = [0, 1, 2].map((id) => scheduler.run(profile, session(), controlledOperation(started, releases, id)));
  await tick();
  assert.deepEqual(started, [0]);
  releases.get(0)();
  await tick();
  assert.deepEqual(started, [0, 1]);
  releases.get(1)();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  releases.get(2)();
  await Promise.all(jobs);
});

test('有効モードではローカル接続先ごとの設定並列数を使用する', async () => {
  const createScheduler = loadFactory();
  const controller = { settings: { aiOptions: { parallelExecutionMode: 'enabled', externalMaxConcurrency: 3, localMaxConcurrency: 2 } } };
  const scheduler = createScheduler({ controller, runControl: runControl(), localProviderId: 'local-openai-compatible' });
  const started = [];
  const releases = new Map();
  const profile = { provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/chat/completions' };
  const jobs = [0, 1, 2].map((id) => scheduler.run(profile, session(), controlledOperation(started, releases, id)));
  await tick();
  assert.deepEqual(started, [0, 1]);
  releases.get(0)();
  releases.get(1)();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  releases.get(2)();
  await Promise.all(jobs);
});


test('待機要求が停止された場合もゲート枠を失わず後続要求を実行できる', async () => {
  const createScheduler = loadFactory();
  const controller = { settings: { aiOptions: { parallelExecutionMode: 'auto' } } };
  const scheduler = createScheduler({ controller, runControl: runControl(), localProviderId: 'local-openai-compatible' });
  const started = [];
  const releases = new Map();
  const profile = { provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/chat/completions' };
  const firstSession = session();
  const stoppedSession = session();
  const thirdSession = session();

  const first = scheduler.run(profile, firstSession, controlledOperation(started, releases, 'first'));
  const stopped = scheduler.run(profile, stoppedSession, controlledOperation(started, releases, 'stopped'));
  const third = scheduler.run(profile, thirdSession, controlledOperation(started, releases, 'third'));
  await tick();
  assert.deepEqual(started, ['first']);

  stoppedSession.abortController.abort();
  await assert.rejects(stopped, (error) => error?.code === 'AUTOMATION_STOPPED');
  releases.get('first')();
  await tick();
  assert.deepEqual(started, ['first', 'third']);
  releases.get('third')();
  await Promise.all([first, third]);
});
