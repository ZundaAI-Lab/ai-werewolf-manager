/**
 * 責務: 自動保存が非同期・原子的・最新状態優先で永続化されることを検証する。
 * 変更ルール: ゲーム状態の内容を削減せず、一時ディレクトリだけを使用する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutosaveStore } = require('../../../app/main/autosaveStore.js');

test('連続保存では最後の完全状態を保存する', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-autosave-'));
  const store = new AutosaveStore(directory);
  const saves = [];
  for (let revision = 1; revision <= 100; revision += 1) {
    saves.push(store.save({ revision, undo: Array.from({ length: 5 }, (_, index) => ({ index })) }));
  }
  await Promise.all(saves);
  const raw = fs.readFileSync(path.join(directory, 'game-autosave.json'), 'utf8');
  assert.equal(raw.includes('\n  \"'), false, '自動保存JSONを整形出力しない');
  const saved = JSON.parse(raw);
  assert.equal(saved.revision, 100);
  assert.equal(saved.undo.length, 5);
  assert.deepEqual(store.loadSync(), saved);
});

test('破損した既存保存は読み込み時にnullとして扱う', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-autosave-broken-'));
  fs.writeFileSync(path.join(directory, 'game-autosave.json'), '{broken', 'utf8');
  const store = new AutosaveStore(directory);
  assert.equal(store.loadSync(), null);
});

test('書き込み失敗中に受け取った最新状態をflushで再保存する', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-autosave-retry-'));
  const autosavePath = path.join(directory, 'game-autosave.json');
  fs.mkdirSync(autosavePath);
  const store = new AutosaveStore(directory);

  const firstSave = store.save({ revision: 1 });
  const latestSave = store.save({ revision: 2 });
  await assert.rejects(Promise.all([firstSave, latestSave]));

  fs.rmdirSync(autosavePath);
  await store.flush();

  assert.deepEqual(JSON.parse(fs.readFileSync(autosavePath, 'utf8')), { revision: 2 });
});

test('終了前flush失敗の警告を保存し次の正常保存で解除する', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-autosave-warning-'));
  const store = new AutosaveStore(directory);
  const error = Object.assign(new Error('flush timeout'), { code: 'AUTOSAVE_FLUSH_TIMEOUT' });
  await store.recordShutdownFlushFailure(error);
  assert.equal(store.loadShutdownFlushFailureSync().code, 'AUTOSAVE_FLUSH_TIMEOUT');
  await store.save({ revision: 1 });
  assert.equal(store.loadShutdownFlushFailureSync(), null);
});


test('保存境界でオブジェクト以外とJSON直列化不能な状態を拒否する', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-autosave-boundary-'));
  const store = new AutosaveStore(directory);
  assert.throws(() => store.save(null), /オブジェクト/u);
  assert.throws(() => store.save([]), /オブジェクト/u);
  const circular = { revision: 1 };
  circular.self = circular;
  assert.throws(() => store.save(circular), /JSONへ直列化/u);
  assert.equal(fs.existsSync(path.join(directory, 'game-autosave.json')), false);
});
