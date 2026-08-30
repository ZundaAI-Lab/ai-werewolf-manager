/**
 * 責務: 製品版ユーザーデータの「schema N → N+1」migrationをデータ種別ごとに登録・解決する。
 * 変更ルール: migrationは後方互換を明示的に提供する場合だけ一方向で登録し、提供を継続するmigrationの意味を変更しない。旧実装を本体へ残さず、互換対応は本レジストリ配下だけに閉じ込める。互換不要の破壊変更ではmigrationを追加せず旧schemaを拒否し、migrationを追加する場合は専用関数とfixtureを用意して飛び級migrationを作らない。
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

  // 現在のschema更新は後方互換を提供しない破壊変更のためmigrationは空。
  // 将来、互換を明示的に提供する場合だけ { 1: migrateV1ToV2 } の形で対象kindへ追加する。
  const DATA_MIGRATIONS = Object.freeze({});

  function migrationFor(kind, fromVersion, registry = DATA_MIGRATIONS) {
    return registry?.[kind]?.[fromVersion] ?? null;
  }

  return Object.freeze({ DATA_MIGRATIONS, migrationFor });
});
