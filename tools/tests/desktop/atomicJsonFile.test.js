/**
 * 責務: Main側JSON永続化の正本が同期・非同期で同じ原子的保存契約と整形指定を提供することを検証する。
 * 変更ルール: 個別Storeの意味検証を持ち込まず、低レベルI/Oの保存結果・権限・一時ファイル残骸だけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteJson, atomicWriteJsonSync } = require('../../../app/main/atomicJsonFile.js');

function assertNoTemporaryFiles(directory) {
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')), []);
}

test('同期JSON保存は整形指定を維持し一時ファイルを残さない', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-atomic-json-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'nested', 'settings.json');
  atomicWriteJsonSync(target, { alpha: 1, beta: { enabled: true } }, { indent: 2 });

  assert.equal(fs.readFileSync(target, 'utf8'), '{\n  "alpha": 1,\n  "beta": {\n    "enabled": true\n  }\n}\n');
  assertNoTemporaryFiles(path.dirname(target));
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('非同期JSON保存はcompact形式を維持し一時ファイルを残さない', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-atomic-json-async-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'state.json');
  await atomicWriteJson(target, { alpha: 1, enabled: true });

  assert.equal(fs.readFileSync(target, 'utf8'), '{"alpha":1,"enabled":true}\n');
  assertNoTemporaryFiles(root);
});

test('同期保存の後始末close失敗は元の書込例外を上書きしない', () => {
  const Module = require('node:module');
  const actualFs = require('node:fs');
  const target = require.resolve('../../../app/main/atomicJsonFile.js');
  const originalLoad = Module._load;
  const writeError = new Error('original-write-error');
  let closeCalls = 0;
  let removeCalls = 0;
  delete require.cache[target];
  Module._load = function mockFs(request, parent, isMain) {
    if (request === 'node:fs') {
      return {
        ...actualFs,
        mkdirSync: () => {},
        openSync: () => 101,
        writeFileSync: () => { throw writeError; },
        closeSync: () => { closeCalls += 1; throw new Error('cleanup-close-error'); },
        rmSync: () => { removeCalls += 1; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { atomicWriteSerializedJsonSync } = require(target);
    assert.throws(() => atomicWriteSerializedJsonSync('/virtual/settings.json', '{}'), (error) => error === writeError);
    assert.equal(closeCalls, 1);
    assert.equal(removeCalls, 1);
  } finally {
    Module._load = originalLoad;
    delete require.cache[target];
  }
});
