/**
 * 責務: Renderer runtimeファサードが必須メソッドを欠落なく公開し、未定義依存を起動前に拒否する契約を検証する。
 * 変更ルール: 過去のcontract version番号や削除済みメソッド名を固定せず、現在の必須メソッド集合と公開境界だけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

const projectRoot = join(__dirname, '..', '..', '..');
const source = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'app', 'runtimeFacade.js'), 'utf8');

function loadRuntimeContract() {
  const context = vm.createContext({ Object, Array, TypeError, globalThis: {} });
  vm.runInContext(esmSourceAsVmScript(source), context, { filename: 'runtimeFacade.js' });
  return {
    createRuntimeFacade: vm.runInContext('createRuntimeFacade', context),
    requiredMethods: vm.runInContext('RUNTIME_REQUIRED_METHODS', context),
  };
}

test('runtimeファサードは現在の必須メソッドだけを公開し欠落を拒否する', () => {
  const { createRuntimeFacade, requiredMethods } = loadRuntimeContract();
  const implementation = Object.fromEntries(requiredMethods.map((name) => [name, () => name]));
  implementation.internalOnly = () => 'private';

  const facade = createRuntimeFacade(implementation);
  assert.deepEqual(Object.keys(facade), Array.from(requiredMethods));
  assert.equal(Object.hasOwn(facade, 'internalOnly'), false);

  const missing = { ...implementation };
  delete missing[requiredMethods[0]];
  assert.throws(() => createRuntimeFacade(missing), /必須メソッド/u);
});
