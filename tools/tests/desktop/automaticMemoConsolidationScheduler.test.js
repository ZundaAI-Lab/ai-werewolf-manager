/**
 * 責務: 内部メモ整理Schedulerが異なるAIを並列生成し、完了した本人から即commitし、本人の次AI処理前barrierがその整理完了だけを待つことを確認する。
 * 変更ルール: ゲーム規則・Provider通信・プロンプト内容は検証せず、Automation上の排他・即commit・待ち合わせ契約だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function loadFactory() {
  const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/automaticMemoConsolidationScheduler.js'), 'utf8'));
  const context = vm.createContext({ console, Promise, Error, Map, Set });
  vm.runInContext(source, context, { filename: 'automaticMemoConsolidationScheduler.js' });
  return vm.runInContext('createAutomaticMemoConsolidationScheduler', context);
}

function request(playerId) {
  return { playerId, taskType: 'memo-consolidate', slotId: '' };
}

test('異なるAIは同時生成し、完了した本人から他AIを待たず即commitする', async () => {
  const createScheduler = loadFactory();
  const session = { stopped: false };
  const resolvers = new Map();
  const started = [];
  const committed = [];
  const executeAiStep = async () => {};
  executeAiStep.generateAiStep = (taskRequest) => {
    started.push(taskRequest.playerId);
    return new Promise((resolve) => resolvers.set(taskRequest.playerId, () => resolve({ playerId: taskRequest.playerId, taskRequest })));
  };
  executeAiStep.commitAiStep = async (generated) => { committed.push(generated.playerId); };
  const scheduler = createScheduler({
    automationRunControl: {
      assertRunning(target) { if (target.stopped) throw new Error('stopped'); },
      isStopped: (target) => Boolean(target.stopped),
    },
    executeAiStep,
    setStatus() {},
  });

  const result = scheduler.startBatch({
    source: 'memo-consolidation',
    taskRequests: [request('a'), request('b')],
  }, session);
  assert.equal(result.advancedCount, 2);
  assert.deepEqual(started, ['a', 'b']);

  resolvers.get('b')();
  await scheduler.waitForPlayer('b', session);
  assert.deepEqual(committed, ['b']);
  assert.deepEqual(Array.from(scheduler.pendingPlayerIds(session)), ['a']);

  resolvers.get('a')();
  await scheduler.waitForAll(session);
  assert.deepEqual(committed, ['b', 'a']);
});

test('本人barrierはその本人の整理だけを待ち、別AIの整理完了を要求しない', async () => {
  const createScheduler = loadFactory();
  const session = { stopped: false };
  const resolvers = new Map();
  const executeAiStep = async () => {};
  executeAiStep.generateAiStep = (taskRequest) => new Promise((resolve) => {
    resolvers.set(taskRequest.playerId, () => resolve({ playerId: taskRequest.playerId, taskRequest }));
  });
  executeAiStep.commitAiStep = async () => {};
  const scheduler = createScheduler({
    automationRunControl: {
      assertRunning(target) { if (target.stopped) throw new Error('stopped'); },
      isStopped: (target) => Boolean(target.stopped),
    },
    executeAiStep,
    setStatus() {},
  });

  scheduler.startBatch({ source: 'memo-consolidation', taskRequests: [request('a'), request('b')] }, session);
  let aReady = false;
  const aBarrier = scheduler.waitForPlayer('a', session).then(() => { aReady = true; });
  resolvers.get('a')();
  await aBarrier;
  assert.equal(aReady, true);
  assert.deepEqual(Array.from(scheduler.pendingPlayerIds(session)), ['b']);

  resolvers.get('b')();
  await scheduler.waitForAll(session);
});

test('同一プレイヤーの整理要求は同一セッション中に二重起動しない', async () => {
  const createScheduler = loadFactory();
  const session = { stopped: false };
  let starts = 0;
  let resolveRequest;
  const executeAiStep = async () => {};
  executeAiStep.generateAiStep = (taskRequest) => {
    starts += 1;
    return new Promise((resolve) => { resolveRequest = () => resolve({ playerId: taskRequest.playerId, taskRequest }); });
  };
  executeAiStep.commitAiStep = async () => {};
  const scheduler = createScheduler({
    automationRunControl: {
      assertRunning(target) { if (target.stopped) throw new Error('stopped'); },
      isStopped: (target) => Boolean(target.stopped),
    },
    executeAiStep,
    setStatus() {},
  });

  const first = scheduler.startBatch({ source: 'memo-consolidation', taskRequests: [request('a'), request('a')] }, session);
  assert.equal(first.advancedCount, 1);
  assert.equal(starts, 1);
  resolveRequest();
  await scheduler.waitForAll(session);
});
