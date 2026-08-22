/**
 * 責務: 各製品データ種別が現在のschemaVersionを一意に持ち、現行schemaだけをそのまま受理し、未来schema・無版schemaを推測しない境界を検証する。
 * 変更ルール: 旧schema migration、過去版fixture、migration前バックアップなど後方互換そのものをテスト契約として固定しない。現在の保存形式と拒否境界だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DATA_SCHEMA_KIND, CURRENT_DATA_SCHEMA_VERSIONS } = require('../../../app/shared/dataCompatibility/schemaVersions.js');
const { migrateData } = require('../../../app/shared/dataCompatibility/migrateData.js');

const PRODUCT_SCHEMA_KINDS = Object.values(DATA_SCHEMA_KIND);

test('全製品データ種別は正の整数の現行schemaVersionを一つだけ持つ', () => {
  assert.deepEqual(Object.keys(CURRENT_DATA_SCHEMA_VERSIONS).sort(), [...PRODUCT_SCHEMA_KINDS].sort());
  PRODUCT_SCHEMA_KINDS.forEach((kind) => {
    assert.equal(Number.isInteger(CURRENT_DATA_SCHEMA_VERSIONS[kind]), true, kind);
    assert.ok(CURRENT_DATA_SCHEMA_VERSIONS[kind] > 0, kind);
  });
});

test('現行schemaは変換せず受理し未来schema・無版schemaは拒否する', () => {
  const kind = DATA_SCHEMA_KIND.APPEARANCE;
  const currentVersion = CURRENT_DATA_SCHEMA_VERSIONS[kind];
  const current = { schemaVersion: currentVersion, theme: 'dark' };
  const accepted = migrateData(kind, current, { label: '外観設定' });

  assert.equal(accepted.migrated, false);
  assert.deepEqual(accepted.value, current);
  assert.throws(
    () => migrateData(kind, { schemaVersion: currentVersion + 1 }, { label: '外観設定' }),
    /現在のアプリより新しいschemaVersion/u,
  );
  assert.throws(
    () => migrateData(kind, { theme: 'dark' }, { label: '外観設定' }),
    /有効なschemaVersionがありません/u,
  );
});
