/**
 * 責務: デスクトップ版のAIプロファイル、料金・プロファイル利用上限設定、実行オプション、参加者割り当て、暗号化APIキー、API使用量・実績料金・詳細ログをローカルファイルへ保存する。
 * 変更ルール:
 * - LLM通信・ゲーム規則・画面描画・ゲーム自動保存を行わない。
 * - APIキーはsafeStorageで暗号化し、Rendererへ復号値を返さない。
 * - 公式送信先・ローカル認証要否・コンテキスト既定値はproviderClients.jsを正本とし、既知のローカル接続先は正式なローカルプロバイダーへ正規化してプリセットを保持する。
 * - プロンプトはゲームstateの現在状態から毎回導出し、過去のAPI要求・生応答・継続カプセルを保存設定へ持ち込まない。
 * - キャッシュ設定はautoまたはoff、Anthropic TTLはauto・5m・1hだけを保存する。
 * - OllamaのThinking段階は共有定義のnone・low・medium・high・maxだけをAIプロファイル単位で保存し、noneはThinking無効、未設定または不正値はlowへ正規化する。
 * - 応答検証エラー時は停止・部分修復・部分修復後に元の応答形式で再生成のいずれかだけを保存し、API通信再試行と共通の呼び出し予算は実行層で固定する。
 * - 永続設定は現行schema、または明示的なmigrationが登録された旧schemaだけを共有settingsSchema.jsの現行保存形として検証する。migrationのない旧schema・未来schemaは推測して読まない。
 * - migration前ファイルはpre-schemaバックアップを残す。
 * - 保存済みendpoint文字列の復元と現在の通信ポリシー適合判定を分離する。読込時は現行schemaのendpointを切り詰めず保持し、新規追加・provider変更・endpoint変更の保存境界では文字数上限を含めて拒否し、実通信直前はendpointPolicyで再検証する。
 * - Rendererからの現行入力は保存読込検証と分離してsanitizeする。
 * - 設定更新はtmp本体をfsyncしてrenameし、対応環境では親ディレクトリもfsyncする原子的保存の成功後だけメモリへ反映する。読込不能な既存設定は一意名へ退避してから既定値へ切り替え、退避自体に失敗した場合は元ファイル保護のため以後の設定保存を禁止する。起動時の退避・保存禁止・現行通信規則に適合しないendpointは永続schemaへ混ぜず一時通知としてRendererへ渡す。
 * - 使用量集計は詳細ログ保存設定から独立させ、AIプロファイルIDを永続集計の正本として全用途のAPI要求を同じ累計へ加算し、API要求ごとのメモリ更新を短時間集約して最大待機時間または終了時flushで原子的保存する。
 * - ゲームIDやチャットセッションIDは詳細ログ用メタデータに留め、料金集計の階層キーにしない。
 * - プロファイル単位リセットは該当プロファイル累計だけを全体累計から差し引き、他プロファイル・詳細ログを変更しない。
 * - 詳細ログは保存直前に認証ヘッダー・APIキー形式をマスクし、POSIXでは現行ログとローテーション世代を0600へ制限する。
 * - ゲームID・AIプロファイルID・割り当てプレイヤーIDはMain境界で再検証し、AIプロファイルIDの重複・件数上限超過は切り捨てやランダム修復をせず拒否する。APIキーは配列位置ではなくIDで追跡し、カスタム接続先ではproviderと正規化済みendpointの両方が一致する場合だけ引き継ぐ。ただし現行通信規則で無効な保存済みendpointは、providerとendpoint文字列を変更していない場合に限って暗号化キーを保持する。
 * - プロファイル別集計と参加者割り当ての動的キーはnull prototypeオブジェクトで保持する。
 */

'use strict';

const {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { dirname, join } = require('node:path');
const { atomicWriteJsonSync } = require('./atomicJsonFile.js');
const { safeStorage } = require('electron');
const {
  CHAT_TOKEN_LIMIT_FIELDS,
  CUSTOM_ENDPOINT_PROVIDERS,
  JSON_REQUEST_MODES,
  JSON_RESPONSE_MODES,
  LOCAL_OPENAI_PROVIDER,
  OFFICIAL_PROVIDERS,
  PROVIDER_CAPABILITIES,
  PROVIDER_DEFAULTS,
  boundedInteger,
  defaultContextWindowTokens,
  isLocalProvider,
} = require('./providerClients.js');
const { isValidEntityId, requireEntityId } = require('../shared/entityIdPolicy.js');
const { validateEndpoint } = require('../shared/endpointPolicy.js');
const { sanitizeRequestLogEntry } = require('./requestLogSanitizer.js');
const { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { migratePersistedDocument, quarantineUnreadableJsonSync } = require('./dataCompatibilityPersistence.js');
const {
  DEFAULT_OLLAMA_THINKING_LEVEL,
  LOCAL_SERVER_PRESETS,
  OLLAMA_THINKING_LEVELS,
} = require('../shared/localLlmConfig.js');
const {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEYS,
  AUTO_RUN_KEYS,
  AI_OPTION_KEYS,
  PROFILE_STORAGE_KEYS,
  PROFILE_BILLING_KEYS,
  GENERATION_KEYS,
  TASK_OVERRIDE_KEYS,
} = require('../shared/settingsSchema.js');
const MAX_PROFILE_COUNT = 64;
const MAX_ENDPOINT_LENGTH = 500;
const REQUEST_LOG_MAX_BYTES = 10 * 1024 * 1024;
const REQUEST_LOG_GENERATIONS = 5;
const USAGE_FLUSH_DELAY_MS = 1500;
const USAGE_FLUSH_MAX_WAIT_MS = 5000;
const USAGE_SUMMARY_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.USAGE_SUMMARY);
const MONEY_SCALE = 1_000_000_000;
const RESPONSE_RECOVERY_MODES = Object.freeze(['stop', 'repair', 'repair-regenerate']);
const GENERATION_DEPTHS = Object.freeze([1, 2, 3, 4]);
const GENERATION_REFERENCE_KEYS = Object.freeze(['reasoningProfileId', 'outputProfileId', 'critiqueProfileId']);

function defaultGenerationSettings() {
  return {
    depth: 1,
    reasoningProfileId: null,
    outputProfileId: null,
    critiqueProfileId: null,
    taskOverrides: Object.fromEntries(TASK_OVERRIDE_KEYS.map((key) => [key, null])),
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactObjectKeys(value, allowedKeys, label) {
  if (!plainObject(value)) throw new TypeError(`${label}はオブジェクトで指定してください。`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new RangeError(`${label}に未知の項目があります: ${unknown.join(', ')}`);
}

function normalizeGenerationSettings(raw) {
  if (raw === undefined) return defaultGenerationSettings();
  exactObjectKeys(raw, GENERATION_KEYS, 'generation');
  const depth = Number(raw.depth);
  if (!GENERATION_DEPTHS.includes(depth)) throw new RangeError('generation.depthは1～4で指定してください。');
  exactObjectKeys(raw.taskOverrides, TASK_OVERRIDE_KEYS, 'generation.taskOverrides');
  const taskOverrides = {};
  for (const key of TASK_OVERRIDE_KEYS) {
    const value = raw.taskOverrides[key];
    if (value !== null && !GENERATION_DEPTHS.includes(Number(value))) {
      throw new RangeError(`generation.taskOverrides.${key}はnullまたは1～4で指定してください。`);
    }
    taskOverrides[key] = value === null ? null : Number(value);
  }
  const generation = { depth, taskOverrides };
  for (const key of GENERATION_REFERENCE_KEYS) {
    const value = raw[key];
    generation[key] = value === null ? null : String(value ?? '');
    if (generation[key] === '') throw new RangeError(`generation.${key}はnullまたはプロファイルIDで指定してください。`);
    if (generation[key] !== null) requireEntityId(generation[key], `generation.${key}`);
  }
  return generation;
}


const LOCAL_SERVER_PRESET_IDS = new Set(Object.keys(LOCAL_SERVER_PRESETS));
const LOCAL_SERVER_PRESET_BY_ENDPOINT = new Map(
  Object.entries(LOCAL_SERVER_PRESETS)
    .filter(([presetId, preset]) => presetId !== 'custom' && preset.endpoint)
    .map(([presetId, preset]) => [preset.endpoint, presetId]),
);

function localServerPresetFromEndpoint(value) {
  const endpoint = String(value ?? '').trim().replace(/\/+$/u, '');
  if (!endpoint) return '';
  return LOCAL_SERVER_PRESET_BY_ENDPOINT.get(endpoint) ?? '';
}

function normalizeProfileProvider(raw) {
  const provider = Object.hasOwn(PROVIDER_DEFAULTS, raw?.provider) ? raw.provider : 'demo';
  if (provider !== 'openai-compatible') return provider;
  const explicitPreset = String(raw?.localServerPreset ?? '');
  const knownPresetSelected = LOCAL_SERVER_PRESET_IDS.has(explicitPreset) && explicitPreset !== 'custom';
  return knownPresetSelected || localServerPresetFromEndpoint(raw?.endpoint)
    ? LOCAL_OPENAI_PROVIDER
    : provider;
}

function normalizeLocalServerPreset(provider, value, endpoint = '', sourceProvider = provider) {
  if (!isLocalProvider(provider)) return 'custom';
  const endpointPreset = localServerPresetFromEndpoint(endpoint);
  if (sourceProvider === 'openai-compatible' && endpointPreset) return endpointPreset;
  const explicitPreset = value === undefined || value === null ? '' : String(value);
  if (LOCAL_SERVER_PRESET_IDS.has(explicitPreset)) return explicitPreset;
  return endpointPreset || 'lm-studio';
}

function endpointForProfileInput(raw, provider, defaults) {
  const preset = normalizeLocalServerPreset(provider, raw?.localServerPreset, raw?.endpoint, raw?.provider);
  if (isLocalProvider(provider) && preset !== 'custom') return LOCAL_SERVER_PRESETS[preset].endpoint;
  return String(raw?.endpoint ?? defaults.endpoint);
}

function normalizeThinkingLevel(value) {
  const normalized = String(value ?? '');
  return OLLAMA_THINKING_LEVELS.includes(normalized) ? normalized : DEFAULT_OLLAMA_THINKING_LEVEL;
}


function promptCacheMode(value) {
  return value === 'off' ? 'off' : 'auto';
}

function anthropicCacheTtl(value) {
  return ['auto', '5m', '1h'].includes(String(value ?? '')) ? String(value) : 'auto';
}

function boundedMoney(value, fallback = 0) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.round(Math.min(1_000_000, Math.max(0, normalized)) * MONEY_SCALE) / MONEY_SCALE;
}

function normalizeBilling(raw) {
  return {
    inputUsdPerMillion: boundedMoney(raw?.inputUsdPerMillion, 0),
    cachedInputUsdPerMillion: boundedMoney(raw?.cachedInputUsdPerMillion, 0),
    cacheWriteUsdPerMillion: boundedMoney(raw?.cacheWriteUsdPerMillion, 0),
    outputUsdPerMillion: boundedMoney(raw?.outputUsdPerMillion, 0),
    profileBudgetUsd: boundedMoney(raw?.profileBudgetUsd, 0),
  };
}

function createProfileId() {
  return `profile-${randomUUID()}`;
}

function defaultProfile(overrides = {}) {
  const provider = normalizeProfileProvider(overrides);
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS['openai-compatible'];
  const localServerPreset = normalizeLocalServerPreset(provider, overrides.localServerPreset, overrides.endpoint, overrides.provider);
  return {
    id: requireEntityId(String(overrides.id ?? 'profile-demo'), 'AIプロファイルID'),
    label: String(overrides.label ?? 'デモAI'),
    provider,
    model: String(overrides.model ?? defaults.model),
    endpoint: endpointForProfileInput(overrides, provider, defaults),
    enabled: overrides.enabled !== false,
    hasApiKey: false,
    apiKeyEncrypted: String(overrides.apiKeyEncrypted ?? ''),
    timeoutMs: boundedInteger(overrides.timeoutMs, 180000, 10000, 600000),
    maxOutputTokens: boundedInteger(overrides.maxOutputTokens, 8192, 256, 65536),
    chatTokenLimitField: CHAT_TOKEN_LIMIT_FIELDS.includes(overrides.chatTokenLimitField)
      ? overrides.chatTokenLimitField
      : PROVIDER_CAPABILITIES[provider]?.outputTokenField ?? 'max_completion_tokens',
    contextWindowTokens: boundedInteger(overrides.contextWindowTokens, defaultContextWindowTokens(provider), 2048, 1048576),
    promptCacheMode: promptCacheMode(overrides.promptCacheMode),
    anthropicCacheTtl: anthropicCacheTtl(overrides.anthropicCacheTtl),
    jsonRequestMode: JSON_REQUEST_MODES.includes(overrides.jsonRequestMode)
      ? overrides.jsonRequestMode
      : isLocalProvider(provider) ? 'json-object' : 'prompt-only',
    jsonResponseMode: JSON_RESPONSE_MODES.includes(overrides.jsonResponseMode)
      ? overrides.jsonResponseMode
      : isLocalProvider(provider) ? 'extract-object' : 'strict',
    thinkingLevel: normalizeThinkingLevel(overrides.thinkingLevel),
    localServerPreset,
    billing: normalizeBilling(overrides.billing),
    generation: normalizeGenerationSettings(overrides.generation),
  };
}

function createDefaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    executionMode: 'automatic',
    autoRun: {
      intervalMs: 450,
      maxConsecutiveSteps: 500,
      autoConfirmWarnings: true,
      autoPublish: true,
    },
    aiOptions: {
      publicHistoryMode: 'delta',
      apiErrorAction: 'retry',
      responseRecoveryMode: 'repair-regenerate',
      apiLogScope: 'errors',
    },
    profiles: [defaultProfile()],
    assignments: {},
  };
}

function readJsonFileIfExists(path) {
  try {
    return { exists: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: null };
    throw error;
  }
}

function validateConfiguredEndpoint(endpoint, provider) {
  const candidate = String(endpoint ?? '').trim();
  if (candidate.length > MAX_ENDPOINT_LENGTH) {
    return {
      ok: false,
      normalizedEndpoint: '',
      message: `APIエンドポイントが長すぎます（上限${MAX_ENDPOINT_LENGTH}文字 / 指定${candidate.length}文字）。`,
    };
  }
  return validateEndpoint(candidate, { requireLoopback: isLocalProvider(provider) });
}

function normalizedEndpoint(raw, provider, defaults, { requireValidEndpoint = true } = {}) {
  if (provider === 'demo') return '';
  if (OFFICIAL_PROVIDERS.has(provider)) return defaults.endpoint;
  const candidate = endpointForProfileInput(raw, provider, defaults).trim();
  const validation = validateConfiguredEndpoint(candidate, provider);
  if (!validation.ok && requireValidEndpoint) {
    throw new RangeError(`APIエンドポイントが不正です: ${validation.message}`);
  }
  // 読込時は既存文字列を切り詰めて別URLへ変換しない。送信先同一性の比較だけvalidationの正規化値を使う。
  return candidate;
}

function endpointIdentity(profile) {
  const validation = validateConfiguredEndpoint(profile?.endpoint, profile?.provider);
  return validation.ok ? validation.normalizedEndpoint : null;
}

function sanitizeProfile(raw, index = 0, { requireValidEndpoint = true } = {}) {
  const provider = normalizeProfileProvider(raw);
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.demo;
  const fallbackId = index === 0 ? 'profile-demo' : createProfileId();
  const localServerPreset = normalizeLocalServerPreset(provider, raw?.localServerPreset, raw?.endpoint, raw?.provider);
  return {
    id: requireEntityId(String(raw?.id || fallbackId), `AIプロファイル[${index}].id`),
    label: String(raw?.label ?? `AIプロファイル ${index + 1}`).trim().slice(0, 80) || `AIプロファイル ${index + 1}`,
    provider,
    model: String(raw?.model ?? defaults.model ?? '').trim().slice(0, 160),
    endpoint: normalizedEndpoint(raw, provider, defaults, { requireValidEndpoint }),
    enabled: raw?.enabled !== false,
    hasApiKey: Boolean(raw?.apiKeyEncrypted),
    apiKeyEncrypted: typeof raw?.apiKeyEncrypted === 'string' ? raw.apiKeyEncrypted : '',
    timeoutMs: boundedInteger(raw?.timeoutMs, 180000, 10000, 600000),
    maxOutputTokens: boundedInteger(raw?.maxOutputTokens, 8192, 256, 65536),
    chatTokenLimitField: CUSTOM_ENDPOINT_PROVIDERS.has(provider) && CHAT_TOKEN_LIMIT_FIELDS.includes(raw?.chatTokenLimitField)
      ? raw.chatTokenLimitField
      : PROVIDER_CAPABILITIES[provider]?.outputTokenField ?? 'max_completion_tokens',
    contextWindowTokens: boundedInteger(raw?.contextWindowTokens, defaultContextWindowTokens(provider), 2048, 1048576),
    promptCacheMode: promptCacheMode(raw?.promptCacheMode),
    anthropicCacheTtl: anthropicCacheTtl(raw?.anthropicCacheTtl),
    jsonRequestMode: JSON_REQUEST_MODES.includes(raw?.jsonRequestMode)
      ? raw.jsonRequestMode
      : isLocalProvider(provider) ? 'json-object' : 'prompt-only',
    jsonResponseMode: JSON_RESPONSE_MODES.includes(raw?.jsonResponseMode)
      ? raw.jsonResponseMode
      : isLocalProvider(provider) ? 'extract-object' : 'strict',
    thinkingLevel: normalizeThinkingLevel(raw?.thinkingLevel),
    localServerPreset,
    billing: normalizeBilling(raw?.billing),
    generation: normalizeGenerationSettings(raw?.generation),
  };
}

function canReuseEncryptedApiKey(previous, profile) {
  if (!previous || previous.provider !== profile.provider) return false;
  if (!CUSTOM_ENDPOINT_PROVIDERS.has(profile.provider)) return true;
  const previousIdentity = endpointIdentity(previous);
  const nextIdentity = endpointIdentity(profile);
  if (previousIdentity && nextIdentity) return previousIdentity === nextIdentity;
  // 現行通信規則では使用不能でも、保存済みendpointを変更していない限り暗号化キーを失わせない。
  return String(previous.endpoint ?? '') === String(profile.endpoint ?? '');
}

function uniqueProfiles(rawProfiles, { requireValidEndpoint = true } = {}) {
  const source = Array.isArray(rawProfiles) ? rawProfiles : [];
  if (source.length > MAX_PROFILE_COUNT) {
    throw new RangeError(`AIプロファイルは最大${MAX_PROFILE_COUNT}件までです（指定: ${source.length}件）。不要なプロファイルを削除してから保存してください。`);
  }
  const seen = new Set();
  return source.map((raw, index) => {
    const profile = sanitizeProfile(raw, index, { requireValidEndpoint });
    if (seen.has(profile.id)) throw new RangeError(`AIプロファイルIDが重複しています: ${profile.id}`);
    seen.add(profile.id);
    return profile;
  });
}

function normalizeAssignments(rawAssignments, profileIds) {
  const assignments = Object.create(null);
  if (!rawAssignments || typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) return assignments;
  for (const [rawPlayerId, rawProfileId] of Object.entries(rawAssignments)) {
    const playerId = requireEntityId(String(rawPlayerId), 'AI割り当てのプレイヤーID');
    if (rawProfileId === null || rawProfileId === '') {
      assignments[playerId] = null;
      continue;
    }
    const profileId = requireEntityId(String(rawProfileId), `プレイヤー${playerId}のAIプロファイルID`);
    if (profileIds.has(profileId)) assignments[playerId] = profileId;
  }
  return assignments;
}

function normalizeAiOptions(raw, defaults) {
  const publicHistoryMode = ['full', 'compact', 'delta'].includes(raw?.publicHistoryMode)
    ? raw.publicHistoryMode
    : (['full', 'compact', 'delta'].includes(defaults?.publicHistoryMode) ? defaults.publicHistoryMode : 'delta');
  const apiErrorAction = ['retry', 'full-history-retry', 'stop'].includes(raw?.apiErrorAction)
    ? raw.apiErrorAction
    : defaults.apiErrorAction;
  const apiLogScope = ['none', 'errors', 'all'].includes(raw?.apiLogScope)
    ? raw.apiLogScope
    : defaults.apiLogScope;
  return {
    publicHistoryMode,
    apiErrorAction,
    responseRecoveryMode: RESPONSE_RECOVERY_MODES.includes(raw?.responseRecoveryMode)
      ? raw.responseRecoveryMode
      : defaults.responseRecoveryMode,
    apiLogScope,
  };
}

function emptyUsageTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
    failedCalls: 0,
    retries: 0,
    taskTotalTokens: 0,
    tasks: 0,
    regeneratedTasks: 0,
  };
}

function finiteNonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function normalizeUsageTotals(raw) {
  const totals = emptyUsageTotals();
  for (const key of Object.keys(totals)) totals[key] = finiteNonNegative(raw?.[key]);
  totals.costUsd = boundedMoney(raw?.costUsd, 0);
  return totals;
}

function publicUsageTotals(raw) {
  const { costUsd: _costUsd, ...totals } = normalizeUsageTotals(raw);
  return totals;
}

function addUsageTotals(target, entry) {
  const usage = entry?.usage ?? {};
  const totalTokens = finiteNonNegative(usage.totalTokens);
  target.inputTokens += finiteNonNegative(usage.inputTokens);
  target.outputTokens += finiteNonNegative(usage.outputTokens);
  target.cachedInputTokens += finiteNonNegative(usage.cachedInputTokens);
  target.cacheWriteTokens += finiteNonNegative(usage.cacheWriteTokens);
  target.reasoningTokens += finiteNonNegative(usage.reasoningTokens);
  target.totalTokens += totalTokens;
  target.costUsd = boundedMoney(target.costUsd + finiteNonNegative(usage.costUsd), 0);
  target.calls += 1;
  if (entry?.status === 'failed') target.failedCalls += 1;
  if (finiteNonNegative(entry?.retryIndex) > 0) target.retries += 1;
  if (entry?.isTaskCall === true) target.taskTotalTokens += totalTokens;
  if (entry?.taskStart === true) target.tasks += 1;
  if (entry?.regeneratedTask === true) target.regeneratedTasks += 1;
  return target;
}

function subtractUsageTotals(target, removed) {
  const result = normalizeUsageTotals(target);
  const delta = normalizeUsageTotals(removed);
  for (const key of Object.keys(result)) {
    result[key] = key === 'costUsd'
      ? boundedMoney(Math.max(0, result[key] - delta[key]), 0)
      : Math.max(0, result[key] - delta[key]);
  }
  return result;
}

function normalizeUsageProfile(raw) {
  const totals = normalizeUsageTotals(raw?.totals);
  return {
    label: String(raw?.label ?? ''),
    provider: String(raw?.provider ?? ''),
    model: String(raw?.model ?? ''),
    totals,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function normalizeUsageProfileMap(raw) {
  const profiles = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return profiles;
  for (const [profileId, value] of Object.entries(raw)) {
    if (!isValidEntityId(profileId)) continue;
    profiles[profileId] = normalizeUsageProfile(value);
  }
  return profiles;
}

function publicUsageProfileMap(raw) {
  const profiles = Object.create(null);
  for (const [profileId, value] of Object.entries(normalizeUsageProfileMap(raw))) {
    profiles[profileId] = {
      label: value.label,
      provider: value.provider,
      model: value.model,
      ...publicUsageTotals(value.totals),
      costUsd: value.totals.costUsd,
      updatedAt: value.updatedAt,
    };
  }
  return profiles;
}

function emptyUsageSummary() {
  return { schemaVersion: USAGE_SUMMARY_SCHEMA_VERSION, totals: emptyUsageTotals(), profiles: Object.create(null) };
}

function normalizeCurrentUsageSummary(raw) {
  if (!plainObject(raw) || raw.schemaVersion !== USAGE_SUMMARY_SCHEMA_VERSION) {
    throw new RangeError('API使用量集計のschemaVersionが現行形式ではありません。');
  }
  return {
    schemaVersion: USAGE_SUMMARY_SCHEMA_VERSION,
    totals: normalizeUsageTotals(raw.totals),
    profiles: normalizeUsageProfileMap(raw.profiles),
  };
}

function loadUsageSummary(path) {
  const fallback = emptyUsageSummary();
  try {
    const loaded = readJsonFileIfExists(path);
    if (!loaded.exists) return { value: fallback, writable: true };
    const migration = migratePersistedDocument(loaded.value, { kind: DATA_SCHEMA_KIND.USAGE_SUMMARY, label: 'API使用量集計', path });
    const normalized = normalizeCurrentUsageSummary(migration.value);
    if (migration.migrated) atomicWriteJsonSync(path, normalized, { indent: 2 });
    return { value: normalized, writable: true };
  } catch (error) {
    try {
      const backupPath = quarantineUnreadableJsonSync(path);
      console.warn(`API使用量集計を読み込めないため${backupPath ? `「${backupPath}」へ退避し、` : ''}空の集計を使用します。`, error);
      return { value: fallback, writable: true };
    } catch (quarantineError) {
      console.error('API使用量集計を読み込めず、元ファイルの退避にも失敗したため保存を禁止します。', quarantineError, error);
      return { value: fallback, writable: false };
    }
  }
}


function restrictRequestLogPermissions(path) {
  if (process.platform === 'win32') return;
  for (let generation = 0; generation <= REQUEST_LOG_GENERATIONS; generation += 1) {
    const target = generation === 0 ? path : `${path}.${generation}`;
    if (existsSync(target)) chmodSync(target, 0o600);
  }
}

function appendPrivateRequestLog(path, line) {
  let descriptor = null;
  try {
    descriptor = openSync(path, 'a', 0o600);
    writeFileSync(descriptor, line, 'utf8');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function rotateRequestLog(path, incomingBytes) {
  const currentBytes = existsSync(path) ? statSync(path).size : 0;
  if (currentBytes + incomingBytes <= REQUEST_LOG_MAX_BYTES) return;
  const oldest = `${path}.${REQUEST_LOG_GENERATIONS}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let generation = REQUEST_LOG_GENERATIONS - 1; generation >= 1; generation -= 1) {
    const source = `${path}.${generation}`;
    if (existsSync(source)) renameSync(source, `${path}.${generation + 1}`);
  }
  if (existsSync(path)) renameSync(path, `${path}.1`);
}


function validateGenerationReferences(profiles) {
  const byId = new Map(profiles.map((profile) => [String(profile.id), profile]));
  for (const profile of profiles) {
    for (const key of GENERATION_REFERENCE_KEYS) {
      const referencedId = profile.generation[key];
      if (referencedId === null) continue;
      const referenced = byId.get(referencedId);
      if (!referenced) throw new RangeError(`${profile.label}の${key}が存在しないAIプロファイルを参照しています: ${referencedId}`);
      if (profile.enabled && !referenced.enabled) {
        throw new Error(`${profile.label}は無効なAIプロファイル「${referenced.label}」を${key}として参照できません。`);
      }
    }
  }
}

function validateProfileDeletionAndAssignments(previousProfiles, nextProfiles, assignments) {
  const nextIds = new Set(nextProfiles.map((profile) => String(profile.id)));
  const deletedIds = new Set(previousProfiles.map((profile) => String(profile.id)).filter((id) => !nextIds.has(id)));
  if (!deletedIds.size) return;
  for (const [playerId, profileId] of Object.entries(assignments ?? {})) {
    if (deletedIds.has(String(profileId ?? ''))) throw new Error(`プレイヤー${playerId}へ割り当て中のAIプロファイルは削除できません。`);
  }
  for (const profile of nextProfiles) {
    for (const key of GENERATION_REFERENCE_KEYS) {
      if (deletedIds.has(String(profile.generation?.[key] ?? ''))) {
        throw new Error(`${profile.label}が${key}として参照しているAIプロファイルは削除できません。`);
      }
    }
  }
}

function validateChangedProfileEndpoints(previousProfiles, nextProfiles) {
  const previousById = new Map((previousProfiles ?? []).map((profile) => [String(profile.id), profile]));
  for (const profile of nextProfiles ?? []) {
    if (profile.provider === 'demo' || OFFICIAL_PROVIDERS.has(profile.provider)) continue;
    const validation = validateConfiguredEndpoint(profile.endpoint, profile.provider);
    if (validation.ok) continue;
    const previous = previousById.get(String(profile.id));
    const unchangedPersistedEndpoint = previous
      && previous.provider === profile.provider
      && String(previous.endpoint ?? '') === String(profile.endpoint ?? '');
    if (unchangedPersistedEndpoint) continue;
    throw new RangeError(`APIエンドポイントが不正です: ${validation.message}`);
  }
}

function profileEndpointStartupNotices(profiles) {
  const notices = [];
  for (const profile of profiles ?? []) {
    if (profile.provider === 'demo' || OFFICIAL_PROVIDERS.has(profile.provider)) continue;
    const validation = validateConfiguredEndpoint(profile.endpoint, profile.provider);
    if (validation.ok) continue;
    notices.push(Object.freeze({
      code: 'SETTINGS_PROFILE_ENDPOINT_UNAVAILABLE',
      profileId: String(profile.id ?? ''),
      profileLabel: String(profile.label ?? ''),
      reason: String(validation.message ?? ''),
    }));
  }
  return notices;
}

function settingsLoadFailureNotice(error, raw, backupPath = '', writable = true) {
  const sourceSchemaVersion = Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : null;
  const schemaMismatch = sourceSchemaVersion !== null && sourceSchemaVersion !== SETTINGS_SCHEMA_VERSION;
  return Object.freeze({
    code: writable
      ? (schemaMismatch ? 'SETTINGS_UNSUPPORTED_SCHEMA' : error instanceof SyntaxError ? 'SETTINGS_INVALID_JSON' : 'SETTINGS_UNREADABLE')
      : 'SETTINGS_LOAD_FAILED_READ_ONLY',
    sourceSchemaVersion,
    currentSchemaVersion: SETTINGS_SCHEMA_VERSION,
    backupPath: String(backupPath ?? ''),
  });
}

function normalizeCurrentSettingsInput(raw, { requireValidEndpoint = true } = {}) {
  const defaults = createDefaultSettings();
  const profiles = uniqueProfiles(raw?.profiles, { requireValidEndpoint });
  const normalizedProfiles = profiles.length ? profiles : defaults.profiles;
  const profileIds = new Set(normalizedProfiles.map((profile) => profile.id));
  validateGenerationReferences(normalizedProfiles);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    executionMode: raw?.executionMode === 'manual' ? 'manual' : 'automatic',
    autoRun: {
      intervalMs: boundedInteger(raw?.autoRun?.intervalMs, defaults.autoRun.intervalMs, 100, 10000),
      maxConsecutiveSteps: boundedInteger(raw?.autoRun?.maxConsecutiveSteps, defaults.autoRun.maxConsecutiveSteps, 1, 5000),
      autoConfirmWarnings: raw?.autoRun?.autoConfirmWarnings !== false,
      autoPublish: raw?.autoRun?.autoPublish !== false,
    },
    aiOptions: normalizeAiOptions(raw?.aiOptions, defaults.aiOptions),
    profiles: normalizedProfiles,
    assignments: normalizeAssignments(raw?.assignments, profileIds),
  };
}

function serializableClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertStoredSettingsDocument(raw) {
  exactObjectKeys(raw, SETTINGS_STORAGE_KEYS, '保存AI設定');
  if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new RangeError(`保存AI設定のschemaVersionが現行形式ではありません: ${raw.schemaVersion}`);
  }
  exactObjectKeys(raw.autoRun, AUTO_RUN_KEYS, '保存AI設定.autoRun');
  exactObjectKeys(raw.aiOptions, AI_OPTION_KEYS, '保存AI設定.aiOptions');
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > MAX_PROFILE_COUNT) {
    throw new RangeError(`保存AI設定.profilesは1～${MAX_PROFILE_COUNT}件で指定してください。`);
  }
  raw.profiles.forEach((profile, index) => {
    exactObjectKeys(profile, PROFILE_STORAGE_KEYS, `保存AI設定.profiles[${index}]`);
    exactObjectKeys(profile.billing, PROFILE_BILLING_KEYS, `保存AI設定.profiles[${index}].billing`);
    exactObjectKeys(profile.generation, GENERATION_KEYS, `保存AI設定.profiles[${index}].generation`);
    exactObjectKeys(profile.generation.taskOverrides, TASK_OVERRIDE_KEYS, `保存AI設定.profiles[${index}].generation.taskOverrides`);
  });
  if (!plainObject(raw.assignments)) throw new TypeError('保存AI設定.assignmentsはオブジェクトで指定してください。');

  const normalized = normalizeCurrentSettingsInput(raw, { requireValidEndpoint: false });
  if (!isDeepStrictEqual(serializableClone(normalized), serializableClone(raw))) {
    throw new RangeError('保存AI設定が現行schemaの正規形と一致しません。');
  }
  return normalized;
}

function loadStoredSettings(path) {
  const defaults = createDefaultSettings();
  let loadedValue = null;
  try {
    const loaded = readJsonFileIfExists(path);
    if (!loaded.exists) return { value: defaults, writable: true, startupNotices: [] };
    loadedValue = loaded.value;
    const migration = migratePersistedDocument(loaded.value, {
      kind: DATA_SCHEMA_KIND.DESKTOP_SETTINGS,
      label: '保存AI設定',
      path,
    });
    const normalized = assertStoredSettingsDocument(migration.value);
    if (migration.migrated) atomicWriteJsonSync(path, normalized, { indent: 2 });
    return { value: normalized, writable: true, startupNotices: profileEndpointStartupNotices(normalized.profiles) };
  } catch (error) {
    try {
      const backupPath = quarantineUnreadableJsonSync(path);
      console.warn(`保存AI設定を読み込めないため${backupPath ? `「${backupPath}」へ退避し、` : ''}既定値を使用します。`, error);
      return {
        value: defaults,
        writable: true,
        startupNotices: [settingsLoadFailureNotice(error, loadedValue, backupPath, true)],
      };
    } catch (quarantineError) {
      console.error('保存AI設定を読み込めず、元ファイルの退避にも失敗したため設定保存を禁止します。', quarantineError, error);
      return {
        value: defaults,
        writable: false,
        startupNotices: [settingsLoadFailureNotice(error, loadedValue, '', false)],
      };
    }
  }
}

class SettingsStore {
  constructor(userDataPath) {
    this.settingsPath = join(userDataPath, 'desktop-settings.json');
    this.requestLogPath = join(userDataPath, 'llm-request-log.jsonl');
    this.usageSummaryPath = join(userDataPath, 'llm-usage-summary.json');
    restrictRequestLogPermissions(this.requestLogPath);
    const loadedSettings = loadStoredSettings(this.settingsPath);
    this.settings = loadedSettings.value;
    this.settingsWritable = loadedSettings.writable;
    this.startupNotices = Array.isArray(loadedSettings.startupNotices) ? loadedSettings.startupNotices.map((notice) => ({ ...notice })) : [];
    const loadedUsageSummary = loadUsageSummary(this.usageSummaryPath);
    this.usageSummary = loadedUsageSummary.value;
    this.usageSummaryWritable = loadedUsageSummary.writable;
    this.usageSummaryDirty = false;
    this.usageFlushTimer = null;
    this.usageMaxFlushTimer = null;
  }

  publicSettings() {
    return {
      schemaVersion: this.settings.schemaVersion,
      executionMode: this.settings.executionMode,
      autoRun: { ...this.settings.autoRun },
      aiOptions: { ...this.settings.aiOptions },
      profiles: this.settings.profiles.map(({ apiKeyEncrypted, ...profile }) => ({
        ...profile,
        hasApiKey: Boolean(apiKeyEncrypted),
      })),
      assignments: { ...this.settings.assignments },
    };
  }

  consumeStartupNotices() {
    const notices = this.startupNotices.map((notice) => ({ ...notice }));
    this.startupNotices = [];
    return notices;
  }

  savePublicSettings(input) {
    if (!this.settingsWritable) {
      const error = new Error('保存AI設定を保護しているため変更を保存できません。アプリを終了し、desktop-settings.jsonの読込状態を確認してください。');
      error.code = 'SETTINGS_READ_ONLY';
      throw error;
    }
    if (input?.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      throw new RangeError(`AI設定のschemaVersionが現行形式ではありません: ${input?.schemaVersion ?? '未指定'}`);
    }
    const previousById = new Map(this.settings.profiles.map((profile) => [profile.id, profile]));
    const rawProfiles = Array.isArray(input?.profiles) ? input.profiles : this.settings.profiles;
    const candidateProfiles = uniqueProfiles(rawProfiles, { requireValidEndpoint: false });
    validateChangedProfileEndpoints(this.settings.profiles, candidateProfiles);
    const incomingById = new Map(candidateProfiles.map((profile, index) => [profile.id, rawProfiles[index] ?? {}]));
    validateProfileDeletionAndAssignments(this.settings.profiles, candidateProfiles, input?.assignments ?? this.settings.assignments);
    validateGenerationReferences(candidateProfiles);
    const normalizedBase = normalizeCurrentSettingsInput({
      ...this.settings,
      ...input,
      profiles: candidateProfiles,
      assignments: input?.assignments ?? this.settings.assignments,
    }, { requireValidEndpoint: false });

    normalizedBase.profiles = normalizedBase.profiles.map((profile) => {
      const incoming = incomingById.get(profile.id) ?? {};
      const previous = previousById.get(profile.id);
      // カスタム接続先はendpoint全体まで秘密鍵のスコープとし、別送信先へ暗黙に再利用しない。
      let apiKeyEncrypted = canReuseEncryptedApiKey(previous, profile) ? previous.apiKeyEncrypted : '';
      if (incoming.clearApiKey === true) apiKeyEncrypted = '';
      const plain = String(incoming.apiKey ?? '');
      if (plain) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('この環境ではAPIキーを安全に暗号化できません。');
        apiKeyEncrypted = safeStorage.encryptString(plain).toString('base64');
      }
      return { ...profile, apiKeyEncrypted, hasApiKey: Boolean(apiKeyEncrypted) };
    });

    const profileIds = new Set(normalizedBase.profiles.map((profile) => profile.id));
    normalizedBase.assignments = normalizeAssignments(input?.assignments ?? this.settings.assignments, profileIds);
    atomicWriteJsonSync(this.settingsPath, normalizedBase, { indent: 2 });
    this.settings = normalizedBase;
    return this.publicSettings();
  }

  profileById(profileId) {
    const id = String(profileId ?? '');
    const profile = this.settings.profiles.find((item) => item.id === id);
    if (!profile) throw new RangeError(`AIプロファイルが存在しません: ${id || '未設定'}`);
    if (!profile.enabled) throw new RangeError(`${profile.label}は無効です。`);
    return { ...profile };
  }

  decryptApiKey(profileId) {
    const profile = this.profileById(profileId);
    if (!profile.apiKeyEncrypted) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('この環境では保存済みAPIキーを復号できません。');
    return safeStorage.decryptString(Buffer.from(profile.apiKeyEncrypted, 'base64'));
  }

  scheduleUsageSummaryFlush() {
    this.usageSummaryDirty = true;
    if (!this.usageSummaryWritable) return;
    if (this.usageFlushTimer) clearTimeout(this.usageFlushTimer);
    this.usageFlushTimer = setTimeout(() => this.flushUsageSummarySafely(), USAGE_FLUSH_DELAY_MS);
    this.usageFlushTimer.unref?.();
    if (!this.usageMaxFlushTimer) {
      this.usageMaxFlushTimer = setTimeout(() => this.flushUsageSummarySafely(), USAGE_FLUSH_MAX_WAIT_MS);
      this.usageMaxFlushTimer.unref?.();
    }
  }

  flushUsageSummarySafely() {
    try {
      return this.flushUsageSummary();
    } catch (error) {
      console.error('API使用量サマリーの遅延保存に失敗しました。次回flushで再試行します。', error);
      this.usageSummaryDirty = true;
      return false;
    }
  }

  flushUsageSummary({ force = false } = {}) {
    if (!this.usageSummaryWritable) {
      if (!this.usageSummaryDirty && !force) return false;
      const error = new Error('API使用量集計ファイルを保護しているため保存できません。');
      error.code = 'USAGE_SUMMARY_READ_ONLY';
      throw error;
    }
    if (this.usageFlushTimer) clearTimeout(this.usageFlushTimer);
    if (this.usageMaxFlushTimer) clearTimeout(this.usageMaxFlushTimer);
    this.usageFlushTimer = null;
    this.usageMaxFlushTimer = null;
    if (!this.usageSummaryDirty && !force) return false;
    atomicWriteJsonSync(this.usageSummaryPath, this.usageSummary, { indent: 2 });
    this.usageSummaryDirty = false;
    return true;
  }

  recordRequest(entry) {
    const timestamp = typeof entry?.timestamp === 'string' ? entry.timestamp : new Date().toISOString();
    const rawProfileId = String(entry?.profileId ?? '').trim();
    const profileId = rawProfileId ? requireEntityId(rawProfileId, 'AIプロファイルID') : '';
    addUsageTotals(this.usageSummary.totals, entry);
    if (profileId) {
      if (!Object.hasOwn(this.usageSummary.profiles, profileId)) {
        this.usageSummary.profiles[profileId] = normalizeUsageProfile({
          label: entry?.label,
          provider: entry?.provider,
          model: entry?.model,
          updatedAt: timestamp,
        });
      }
      const profile = this.usageSummary.profiles[profileId];
      profile.label = String(entry?.label ?? profile.label);
      profile.provider = String(entry?.provider ?? profile.provider);
      profile.model = String(entry?.model ?? profile.model);
      addUsageTotals(profile.totals, entry);
      profile.updatedAt = timestamp;
    }
    this.scheduleUsageSummaryFlush();

    const scope = this.settings.aiOptions.apiLogScope;
    const shouldLog = scope === 'all' || (scope === 'errors' && entry?.status === 'failed');
    if (!shouldLog) return;
    mkdirSync(dirname(this.requestLogPath), { recursive: true });
    const line = `${JSON.stringify(sanitizeRequestLogEntry({ ...entry, timestamp }))}\n`;
    rotateRequestLog(this.requestLogPath, Buffer.byteLength(line, 'utf8'));
    appendPrivateRequestLog(this.requestLogPath, line);
  }

  getUsageSummary() {
    const totals = normalizeUsageTotals(this.usageSummary.totals);
    return {
      totals: publicUsageTotals(totals),
      totalCostUsd: totals.costUsd,
      profiles: publicUsageProfileMap(this.usageSummary.profiles),
    };
  }

  getProfileUsage(profileId) {
    const normalizedProfileId = requireEntityId(String(profileId ?? '').trim(), 'AIプロファイルID');
    return normalizeUsageTotals(this.usageSummary.profiles[normalizedProfileId]?.totals);
  }

  resetUsageSummary(scope, profileId = '') {
    const normalizedScope = String(scope ?? '');
    if (!['profile', 'all'].includes(normalizedScope)) throw new RangeError('API使用量のリセット範囲が不正です。');
    if (normalizedScope === 'profile') {
      const normalizedProfileId = requireEntityId(String(profileId ?? '').trim(), 'AIプロファイルID');
      const removed = this.usageSummary.profiles[normalizedProfileId];
      if (removed) {
        this.usageSummary.totals = subtractUsageTotals(this.usageSummary.totals, removed.totals);
        delete this.usageSummary.profiles[normalizedProfileId];
      }
    } else {
      this.usageSummary = emptyUsageSummary();
    }
    this.usageSummaryDirty = true;
    this.flushUsageSummary({ force: true });
    return this.getUsageSummary();
  }

}

module.exports = {
  MAX_ENDPOINT_LENGTH,
  MAX_PROFILE_COUNT,
  REQUEST_LOG_GENERATIONS,
  REQUEST_LOG_MAX_BYTES,
  USAGE_FLUSH_DELAY_MS,
  USAGE_FLUSH_MAX_WAIT_MS,
  USAGE_SUMMARY_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  SettingsStore,
  createDefaultSettings,
  defaultGenerationSettings,
  assertStoredSettingsDocument,
  normalizeCurrentSettingsInput,
  normalizeUsageTotals,
  rotateRequestLog,
};
