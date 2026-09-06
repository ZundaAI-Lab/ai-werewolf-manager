/**
 * 責務: 各製品データ種別の現行schemaVersion、現行データの受理、未来schema・無版schema拒否、migration選択規則を検証する。
 * 変更ルール: 過去リリース固有のfixtureを恒久回帰へ残さず、現在のデータ境界とmigration基盤の一般契約だけを確認する。
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


test('migrationはアプリversionではなくschemaVersionだけで選択する', () => {
  const source = {
    schemaVersion: 1,
    appVersion: 'arbitrary-old-version',
    aiTurns: [],
    undoStack: [],
    redoStack: [],
    restorePoints: [],
  };
  const changedLabel = { ...source, appVersion: 'arbitrary-other-version' };
  const first = migrateData(DATA_SCHEMA_KIND.GAME_STATE, source, { label: 'ゲーム保存データ' }).value;
  const second = migrateData(DATA_SCHEMA_KIND.GAME_STATE, changedLabel, { label: 'ゲーム保存データ' }).value;

  assert.equal(first.schemaVersion, 2);
  assert.equal(second.schemaVersion, 2);
  assert.equal(first.appVersion, 'arbitrary-old-version');
  assert.equal(second.appVersion, 'arbitrary-other-version');
  assert.deepEqual(
    { ...first, appVersion: '<ignored>' },
    { ...second, appVersion: '<ignored>' },
    'appVersionの値でmigration内容を分岐しない',
  );
});

