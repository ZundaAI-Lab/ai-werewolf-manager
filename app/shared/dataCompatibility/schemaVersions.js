/**
 * 責務: 製品版で永続化・入出力するユーザーデータJSONの現行schemaVersionを一元管理する。
 * 変更ルール: アプリの製品versionとは独立して増分する。保存項目の追加・削除・意味変更・必須条件変更時だけ対象schemaを+1し、正式リリース済みユーザーデータに対する旧schema→次schemaの一方向migrationをmigrationRegistry.jsへ同時追加する。内部実装の旧仕様は残さず、互換責務はdataCompatibility配下へ閉じ込める。初期schemaはすべて1とする。
 */

(function initializeDataSchemaVersions(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) {
    root.AiWerewolfDataSchemaVersions = api;
    if (root.window && root.window !== root) root.window.AiWerewolfDataSchemaVersions = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const DATA_SCHEMA_KIND = Object.freeze({
    GAME_STATE: 'game-state',
    DESKTOP_SETTINGS: 'desktop-settings',
    APPEARANCE: 'appearance',
    CHAT_ROOM: 'chat-room',
    SPECTATOR_ROOM: 'spectator-room',
    USER_CHARACTER_LIBRARY: 'user-character-library',
    AI_PROFILE_PACKAGE: 'ai-profile-package',
    USAGE_SUMMARY: 'usage-summary',
    PRIVACY_NOTICE: 'privacy-notice',
  });

  const CURRENT_DATA_SCHEMA_VERSIONS = Object.freeze({
    [DATA_SCHEMA_KIND.GAME_STATE]: 2,
    [DATA_SCHEMA_KIND.DESKTOP_SETTINGS]: 2,
    [DATA_SCHEMA_KIND.APPEARANCE]: 1,
    [DATA_SCHEMA_KIND.CHAT_ROOM]: 1,
    [DATA_SCHEMA_KIND.SPECTATOR_ROOM]: 1,
    [DATA_SCHEMA_KIND.USER_CHARACTER_LIBRARY]: 1,
    [DATA_SCHEMA_KIND.AI_PROFILE_PACKAGE]: 2,
    [DATA_SCHEMA_KIND.USAGE_SUMMARY]: 1,
    [DATA_SCHEMA_KIND.PRIVACY_NOTICE]: 1,
  });

  function getCurrentDataSchemaVersion(kind) {
    const version = CURRENT_DATA_SCHEMA_VERSIONS[kind];
    if (!Number.isInteger(version)) throw new RangeError(`未知のデータschema種別です: ${String(kind ?? '')}`);
    return version;
  }

  return Object.freeze({ DATA_SCHEMA_KIND, CURRENT_DATA_SCHEMA_VERSIONS, getCurrentDataSchemaVersion });
});
