/**
 * 責務: 製品版ユーザーデータの「schema N → N+1」migrationをデータ種別ごとに登録・解決する。
 * 変更ルール: migrationは一方向だけを登録し、既存migrationを削除・意味変更しない。旧実装を本体へ残さず、旧schema対応は本レジストリ配下だけに閉じ込める。新schema追加時は専用migration関数とfixtureを追加し、飛び級migrationは作らない。
 */

(function initializeMigrationRegistry(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) {
    root.AiWerewolfMigrationRegistry = api;
    if (root.window && root.window !== root) root.window.AiWerewolfMigrationRegistry = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  // 製品版1.0.0は全ユーザーデータschema=1が基準点のため、現時点のmigrationは空。
  // schemaを2へ上げるときに { 1: migrateV1ToV2 } の形で対象kindへ追加する。
  const DATA_MIGRATIONS = Object.freeze({});

  function migrationFor(kind, fromVersion, registry = DATA_MIGRATIONS) {
    return registry?.[kind]?.[fromVersion] ?? null;
  }

  return Object.freeze({ DATA_MIGRATIONS, migrationFor });
});
