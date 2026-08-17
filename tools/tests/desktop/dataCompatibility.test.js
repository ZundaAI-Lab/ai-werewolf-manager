/**
 * 責務: 製品版ユーザーデータのschema基準点、一方向migration連鎖、未来/無版schema拒否、migration前バックアップという長期互換契約を検証する。
 * 変更ルール: 過去の具体的不具合や旧開発版schema番号は固定しない。現在以降の全データ形式に共通する互換ルールだけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATA_SCHEMA_KIND, CURRENT_DATA_SCHEMA_VERSIONS } = require('../../../app/shared/dataCompatibility/schemaVersions.js');
const { migrateData, migrateWithRegistry } = require('../../../app/shared/dataCompatibility/migrateData.js');
const { backupBeforeMigrationSync, backupPathForMigration } = require('../../../app/main/dataCompatibilityPersistence.js');

const PRODUCT_SCHEMA_KINDS = Object.values(DATA_SCHEMA_KIND);

test('製品版1.0.0のユーザーデータschema基準点は全種別1', () => {
  assert.deepEqual(Object.keys(CURRENT_DATA_SCHEMA_VERSIONS).sort(), [...PRODUCT_SCHEMA_KINDS].sort());
  PRODUCT_SCHEMA_KINDS.forEach((kind) => assert.equal(CURRENT_DATA_SCHEMA_VERSIONS[kind], 1, kind));
});

test('migrationはN→N+1を順番に適用し入力を破壊しない', () => {
  const input = { schemaVersion: 1, value: 'base' };
  const registry = {
    test: {
      1: (raw) => ({ ...raw, schemaVersion: 2, second: true }),
      2: (raw) => ({ ...raw, schemaVersion: 3, third: true }),
    },
  };
  const result = migrateWithRegistry(input, { kind: 'test', currentVersion: 3, registry, label: 'テストデータ' });
  assert.deepEqual(result.value, { schemaVersion: 3, value: 'base', second: true, third: true });
  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, 3);
  assert.deepEqual(input, { schemaVersion: 1, value: 'base' });
});

test('未来schemaとschemaVersionなしは推測して読み込まない', () => {
  assert.throws(
    () => migrateData(DATA_SCHEMA_KIND.APPEARANCE, { schemaVersion: 2 }, { label: '外観設定' }),
    /現在のアプリより新しいschemaVersion/u,
  );
  assert.throws(
    () => migrateData(DATA_SCHEMA_KIND.APPEARANCE, { theme: 'dark' }, { label: '外観設定' }),
    /有効なschemaVersionがありません/u,
  );
});

test('migration前バックアップは元JSONを保持し同じschemaでは上書きしない', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwm-data-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.json');
  fs.writeFileSync(file, '{"schemaVersion":1,"value":"before"}\n', 'utf8');
  const backup = backupBeforeMigrationSync(file, 1);
  assert.equal(backup, backupPathForMigration(file, 1));
  assert.equal(fs.readFileSync(backup, 'utf8'), '{"schemaVersion":1,"value":"before"}\n');
  fs.writeFileSync(file, '{"schemaVersion":2,"value":"after"}\n', 'utf8');
  backupBeforeMigrationSync(file, 1);
  assert.equal(fs.readFileSync(backup, 'utf8'), '{"schemaVersion":1,"value":"before"}\n');
});
