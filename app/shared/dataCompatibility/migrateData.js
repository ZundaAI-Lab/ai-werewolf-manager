/**
 * 責務: 製品版ユーザーデータJSONのschemaVersionを検査し、登録済みの一方向migrationを順番に適用して現行schemaへ変換する。
 * 変更ルール: schemaVersionなし・0以下・未来schemaは推測して読まない。旧schemaは必ずN→N+1を順に通し、変換前入力を破壊しない。各データの意味検証・sanitize・永続化は呼出元の責務とする。
 */

(function initializeDataMigration(root, factory) {
  'use strict';
  const commonJs = typeof module === 'object' && module.exports;
  const versions = commonJs
    ? require('./schemaVersions.js')
    : root?.AiWerewolfDataSchemaVersions;
  const registryApi = commonJs
    ? require('./migrationRegistry.js')
    : root?.AiWerewolfMigrationRegistry;
  const api = factory(versions, registryApi);
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfDataMigration = api;
    if (root.window && root.window !== root) root.window.AiWerewolfDataMigration = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, (versions, registryApi) => {
  'use strict';

  if (!versions || !registryApi) throw new Error('データ互換モジュールの依存関係を読み込めません。');

  function isDocument(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function requireSchemaVersion(raw, label = 'データ') {
    if (!isDocument(raw)) throw new TypeError(`${label}はJSONオブジェクトで指定してください。`);
    if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
      throw new RangeError(`${label}に有効なschemaVersionがありません。製品版1.0.0以降のデータを使用してください。`);
    }
    return raw.schemaVersion;
  }

  function migrateWithRegistry(raw, { kind, currentVersion, registry = registryApi.DATA_MIGRATIONS, label = 'データ' } = {}) {
    const sourceVersion = requireSchemaVersion(raw, label);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) throw new RangeError(`${label}の現行schemaVersionが不正です。`);
    if (sourceVersion > currentVersion) {
      throw new RangeError(`${label}は現在のアプリより新しいschemaVersion ${sourceVersion} です。アプリを最新版へ更新してください。`);
    }

    let value = cloneJson(raw);
    let version = sourceVersion;
    while (version < currentVersion) {
      const migration = registryApi.migrationFor(kind, version, registry);
      if (typeof migration !== 'function') {
        throw new RangeError(`${label} schemaVersion ${version} → ${version + 1} のmigrationがありません。`);
      }
      const migrated = migration(cloneJson(value));
      if (!isDocument(migrated) || migrated.schemaVersion !== version + 1) {
        throw new Error(`${label} schemaVersion ${version} → ${version + 1} migrationの出力が不正です。`);
      }
      value = migrated;
      version += 1;
    }

    return Object.freeze({
      value,
      migrated: sourceVersion !== currentVersion,
      fromVersion: sourceVersion,
      toVersion: currentVersion,
    });
  }

  function migrateData(kind, raw, { label = 'データ' } = {}) {
    return migrateWithRegistry(raw, {
      kind,
      currentVersion: versions.getCurrentDataSchemaVersion(kind),
      registry: registryApi.DATA_MIGRATIONS,
      label,
    });
  }

  return Object.freeze({ migrateData, migrateWithRegistry, requireSchemaVersion });
});
