/**
 * 責務: Main側userData JSONのschema migration前バックアップ、解釈不能ファイルの退避、migration成功後の原子的な現行schema書戻しを提供する。
 * 変更ルール: データ内容の意味検証・既定値補完・各Store固有の保存規則を持たない。旧schemaを書き換える前はpre-schemaバックアップを1世代残し、読込・schema検証に失敗した既存JSONは元データを失わないよう同一ディレクトリへ一意名で退避する。migration本体はapp/shared/dataCompatibility、原子的書込手順はatomicJsonFile.jsを正本とする。
 */

'use strict';

const { copyFileSync, existsSync, renameSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { migrateData } = require('../shared/dataCompatibility/migrateData.js');
const { atomicWriteJsonSync } = require('./atomicJsonFile.js');

function backupPathForMigration(path, fromVersion) {
  return `${path}.pre-schema-${fromVersion}.json`;
}

function backupBeforeMigrationSync(path, fromVersion) {
  if (!existsSync(path)) return null;
  const backupPath = backupPathForMigration(path, fromVersion);
  if (!existsSync(backupPath)) copyFileSync(path, backupPath);
  return backupPath;
}

function migratePersistedDocument(raw, { kind, label, path = '' } = {}) {
  const result = migrateData(kind, raw, { label });
  if (result.migrated && path) backupBeforeMigrationSync(path, result.fromVersion);
  return result;
}


function quarantineUnreadableJsonSync(path) {
  const backupPath = `${path}.unreadable-${Date.now()}-${randomUUID()}.bak`;
  try {
    renameSync(path, backupPath);
    return backupPath;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeMigratedJsonSync(path, value) {
  atomicWriteJsonSync(path, value, { indent: 2 });
}

module.exports = Object.freeze({
  backupBeforeMigrationSync,
  backupPathForMigration,
  migratePersistedDocument,
  quarantineUnreadableJsonSync,
  writeMigratedJsonSync,
});
