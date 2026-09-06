/**
 * 責務: AIバッチ実行が生成完了順ではなくworkflow順でcommitし、先行commit後に別タスクが割り込んだ場合は残りを登録しないことを確認する。
 * 変更ルール: ゲーム規則の並列可否やAPI通信は専用テストへ委譲し、generate/commit分離の順序契約だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function loadFactory() {
  const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/automaticAiBatchExecutor.js'), 'utf8'));
  const context = vm.createContext({ console, Promise, Error });
  vm.runInContext(source, context, { filename: 'automaticAiBatchExecutor.js' });
  return vm.runInContext('createAutomaticAiBatchExecutor', context);
}

function request(id) {
  return { playerId: id, taskType: 'vote', slotId: '' };
}

function sameRequestAction(taskRequest) {
  return { kind: 'ai-task', taskRequest };
}

test('API生成完了順が逆転してもcommitはtaskRequests順で行う', async () => {
  const createBatchExecutor = loadFactory();
  const taskRequests = [request('a'), request('b'), request('c')];
  const generatedOrder = [];
  const committedOrder = [];
  const resolvers = new Map();
  let commitIndex = 0;
  const executeAiStep = async () => {};
  executeAiStep.generateAiStep = (taskRequest) => new Promise((resolve) => {
    resolvers.set(taskRequest.playerId, () => {
      generatedOrder.push(taskRequest.playerId);
      resolve({ playerId: taskRequest.playerId, taskRequest });
    });
  });
  executeAiStep.commitAiStep = async (generated) => {
    committedOrder.push(generated.playerId);
    commitIndex += 1;
  };
  const runtimeApi = {
    resolveAutomaticAction() {
      return sameRequestAction(taskRequests[commitIndex] ?? {});
    },
  };
  const executor = createBatchExecutor({
    automationRunControl: { assertRunning() {} },
    controller: { settings: { autoRun: { autoPublish: true } } },
    executeAiStep,
    runtime: () => runtimeApi,
    setStatus() {},
  });
  const execution = executor({ kind: 'ai-task-batch', taskRequests }, {});
  await Promise.resolve();
  resolvers.get('c')();
  resolvers.get('b')();
  resolvers.get('a')();
  const result = await execution;
  assert.deepEqual(generatedOrder, ['c', 'b', 'a']);
  assert.deepEqual(committedOrder, ['a', 'b', 'c']);
  assert.equal(result.advancedCount, 3);
});

test('先行commit後にworkflowへ別タスクが割り込んだら残り生成結果を破棄する', async () => {
  const createBatchExecutor = loadFactory();
  const taskRequests = [request('a'), request('b'), request('c')];
  const committedOrder = [];
  let commitIndex = 0;
  const executeAiStep = async () => {};
  executeAiStep.generateAiStep = async (taskRequest) => ({ playerId: taskRequest.playerId, taskRequest });
  executeAiStep.commitAiStep = async (generated) => {
    committedOrder.push(generated.playerId);
    commitIndex += 1;
  };
  const runtimeApi = {
    resolveAutomaticAction() {
      if (commitIndex === 0) return sameRequestAction(taskRequests[0]);
      return { kind: 'ai-task', taskRequest: { playerId: 'a', taskType: 'memo-consolidate', slotId: '' } };
    },
  };
  const executor = createBatchExecutor({
    automationRunControl: { assertRunning() {} },
    controller: { settings: { autoRun: { autoPublish: true } } },
    executeAiStep,
    runtime: () => runtimeApi,
    setStatus() {},
  });
  const result = await executor({ kind: 'ai-task-batch', taskRequests }, {});
  assert.deepEqual(committedOrder, ['a']);
  assert.equal(result.status, 'advanced');
  assert.equal(result.advancedCount, 1);
});
