/**
 * 責務: Electron Main・Rendererで共有するデスクトップAI設定の現行schemaVersionと保存項目構造を定義する。
 * 変更ルール: schemaVersionはdataCompatibility/schemaVersions.jsを正本とし、保存形式変更時はschemaVersion更新とmigration追加を同時に行う。設定値のsanitize・永続化・DOM操作は行わない。
 */

(function initializeSettingsSchema(root, factory) {
  'use strict';

  const commonJs = typeof module === 'object' && module.exports;
  const versions = commonJs ? require('./dataCompatibility/schemaVersions.js') : root?.AiWerewolfDataSchemaVersions;
  const api = factory(versions);
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfSettingsSchema = api;
    if (root.window && root.window !== root) root.window.AiWerewolfSettingsSchema = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, (versions) => {
  'use strict';

  if (!versions) throw new Error('データschema定義を読み込めません。');
  const SETTINGS_SCHEMA_VERSION = versions.getCurrentDataSchemaVersion(versions.DATA_SCHEMA_KIND.DESKTOP_SETTINGS);
  const SETTINGS_STORAGE_KEYS = Object.freeze(['schemaVersion', 'executionMode', 'autoRun', 'aiOptions', 'profiles', 'assignments']);
  const AUTO_RUN_KEYS = Object.freeze(['intervalMs', 'maxConsecutiveSteps', 'autoConfirmWarnings', 'autoPublish']);
  const AI_OPTION_KEYS = Object.freeze(['publicHistoryMode', 'apiErrorAction', 'responseRecoveryMode', 'apiLogScope']);
  const PROFILE_STORAGE_KEYS = Object.freeze([
    'id', 'label', 'provider', 'model', 'endpoint', 'enabled', 'hasApiKey', 'apiKeyEncrypted',
    'timeoutMs', 'maxOutputTokens', 'chatTokenLimitField', 'contextWindowTokens', 'promptCacheMode',
    'anthropicCacheTtl', 'jsonRequestMode', 'jsonResponseMode', 'thinkingLevel', 'localServerPreset', 'billing', 'generation',
  ]);
  const PROFILE_BILLING_KEYS = Object.freeze(['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'cacheWriteUsdPerMillion', 'outputUsdPerMillion', 'profileBudgetUsd']);
  const GENERATION_KEYS = Object.freeze(['depth', 'reasoningProfileId', 'outputProfileId', 'critiqueProfileId', 'taskOverrides']);
  const TASK_OVERRIDE_KEYS = Object.freeze(['speech', 'vote', 'nightAction', 'privateConversation', 'resultImpression', 'memoConsolidate']);

  return Object.freeze({
    SETTINGS_SCHEMA_VERSION,
    SETTINGS_STORAGE_KEYS,
    AUTO_RUN_KEYS,
    AI_OPTION_KEYS,
    PROFILE_STORAGE_KEYS,
    PROFILE_BILLING_KEYS,
    GENERATION_KEYS,
    TASK_OVERRIDE_KEYS,
  });
});
