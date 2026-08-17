/**
 * 責務: Main側userData JSONのschema migration前バックアップと、migration成功後の原子的な現行schema書戻しを提供する。
 * 変更ルール: データ内容の意味検証・既定値補完・各Store固有の保存規則を持たない。旧schemaを書き換える前だけ同一ディレクトリへpre-schemaバックアップを1世代残し、migration本体はapp/shared/dataCompatibilityを正本とする。
 */

'use strict';

const {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { dirname } = require('node:path');
const { migrateData } = require('../shared/dataCompatibility/migrateData.js');

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

function writeMigratedJsonSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.migration.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'w', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

module.exports = Object.freeze({
  backupBeforeMigrationSync,
  backupPathForMigration,
  migratePersistedDocument,
  writeMigratedJsonSync,
});
