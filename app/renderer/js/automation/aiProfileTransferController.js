/**
 * 責務: AIプロファイルJSONパッケージの出力・読込、製品schema migration後の厳格な現行形式検証、依存プロファイル収集、読込時ID再採番と生成工程参照の付け替えを所有する。
 * 変更ルール: APIキー・暗号化キー・使用量・参加者割り当ては転送対象に含めない。schemaVersionは共有dataCompatibilityを正本とし、旧schema分岐を本モジュールへ追加しない。設定の最終sanitize・永続化はMainのsettingsStoreへ委譲する。
 */

import { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion, migrateData } from '../config/dataCompatibilityAdapter.js';
import { downloadJson, readFileText, sanitizeFilenamePart } from '../shared/utils.js';

const FORMAT = 'ai-werewolf-ai-profile-package';
const SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.AI_PROFILE_PACKAGE);
const MAX_PROFILE_COUNT = 64;
const TOP_KEYS = Object.freeze(['format', 'schemaVersion', 'exportedAt', 'rootProfileId', 'profiles']);
const PROFILE_KEYS = Object.freeze([
  'id', 'label', 'provider', 'model', 'endpoint', 'enabled', 'timeoutMs', 'maxOutputTokens',
  'chatTokenLimitField', 'contextWindowTokens', 'promptCacheMode', 'anthropicCacheTtl',
  'jsonRequestMode', 'jsonResponseMode', 'thinkingLevel', 'localServerPreset', 'billing', 'generation',
]);
const BILLING_KEYS = Object.freeze(['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'cacheWriteUsdPerMillion', 'outputUsdPerMillion', 'profileBudgetUsd']);
const GENERATION_KEYS = Object.freeze(['depth', 'reasoningProfileId', 'outputProfileId', 'critiqueProfileId', 'taskOverrides']);
const TASK_OVERRIDE_KEYS = Object.freeze(['speech', 'vote', 'nightAction', 'privateConversation', 'resultImpression', 'memoConsolidate']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!plainObject(value)) throw new TypeError(`${label}はオブジェクトで指定してください。`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RangeError(`${label}の項目構成が現行JSON形式と一致しません。`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label}は文字列で指定してください。`);
}

function assertNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label}は有限の数値で指定してください。`);
}

function assertNullableProfileId(value, label, ids) {
  if (value === null) return;
  assertString(value, label);
  if (!ids.has(value)) throw new RangeError(`${label}がJSON内に存在しないAIプロファイルを参照しています。`);
}

function validatePackage(raw) {
  const current = migrateData(DATA_SCHEMA_KIND.AI_PROFILE_PACKAGE, raw, { label: 'AIプロファイルJSON' }).value;
  assertExactKeys(current, TOP_KEYS, 'AIプロファイルJSON');
  if (current.format !== FORMAT || current.schemaVersion !== SCHEMA_VERSION) throw new RangeError('AIプロファイルJSONの形式またはschemaVersionが現行形式ではありません。');
  raw = current;
  assertString(raw.exportedAt, 'AIプロファイルJSON.exportedAt');
  assertString(raw.rootProfileId, 'AIプロファイルJSON.rootProfileId');
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > MAX_PROFILE_COUNT) {
    throw new RangeError(`AIプロファイルJSON.profilesは1～${MAX_PROFILE_COUNT}件で指定してください。`);
  }
  const ids = new Set();
  raw.profiles.forEach((profile, index) => {
    assertExactKeys(profile, PROFILE_KEYS, `AIプロファイルJSON.profiles[${index}]`);
    assertString(profile.id, `AIプロファイルJSON.profiles[${index}].id`);
    if (!profile.id || ids.has(profile.id)) throw new RangeError('AIプロファイルJSON内のAIプロファイルIDが空または重複しています。');
    ids.add(profile.id);
    for (const key of ['label', 'provider', 'model', 'endpoint', 'chatTokenLimitField', 'promptCacheMode', 'anthropicCacheTtl', 'jsonRequestMode', 'jsonResponseMode', 'thinkingLevel', 'localServerPreset']) {
      assertString(profile[key], `AIプロファイルJSON.profiles[${index}].${key}`);
    }
    if (typeof profile.enabled !== 'boolean') throw new TypeError(`AIプロファイルJSON.profiles[${index}].enabledは真偽値で指定してください。`);
    for (const key of ['timeoutMs', 'maxOutputTokens', 'contextWindowTokens']) assertNumber(profile[key], `AIプロファイルJSON.profiles[${index}].${key}`);
    assertExactKeys(profile.billing, BILLING_KEYS, `AIプロファイルJSON.profiles[${index}].billing`);
    BILLING_KEYS.forEach((key) => assertNumber(profile.billing[key], `AIプロファイルJSON.profiles[${index}].billing.${key}`));
    assertExactKeys(profile.generation, GENERATION_KEYS, `AIプロファイルJSON.profiles[${index}].generation`);
    assertNumber(profile.generation.depth, `AIプロファイルJSON.profiles[${index}].generation.depth`);
    assertExactKeys(profile.generation.taskOverrides, TASK_OVERRIDE_KEYS, `AIプロファイルJSON.profiles[${index}].generation.taskOverrides`);
    for (const key of TASK_OVERRIDE_KEYS) {
      const value = profile.generation.taskOverrides[key];
      if (value !== null) assertNumber(value, `AIプロファイルJSON.profiles[${index}].generation.taskOverrides.${key}`);
    }
  });
  if (!ids.has(raw.rootProfileId)) throw new RangeError('AIプロファイルJSON.rootProfileIdがprofiles内に存在しません。');
  raw.profiles.forEach((profile, index) => {
    for (const key of ['reasoningProfileId', 'outputProfileId', 'critiqueProfileId']) {
      assertNullableProfileId(profile.generation[key], `AIプロファイルJSON.profiles[${index}].generation.${key}`, ids);
    }
  });
  return raw;
}

function exportableProfile(profile, normalizeGenerationSettings) {
  const generation = normalizeGenerationSettings(profile.generation);
  return {
    id: String(profile.id),
    label: String(profile.label ?? ''),
    provider: String(profile.provider ?? ''),
    model: String(profile.model ?? ''),
    endpoint: String(profile.endpoint ?? ''),
    enabled: profile.enabled !== false,
    timeoutMs: Number(profile.timeoutMs),
    maxOutputTokens: Number(profile.maxOutputTokens),
    chatTokenLimitField: String(profile.chatTokenLimitField ?? ''),
    contextWindowTokens: Number(profile.contextWindowTokens),
    promptCacheMode: String(profile.promptCacheMode ?? ''),
    anthropicCacheTtl: String(profile.anthropicCacheTtl ?? ''),
    jsonRequestMode: String(profile.jsonRequestMode ?? ''),
    jsonResponseMode: String(profile.jsonResponseMode ?? ''),
    thinkingLevel: String(profile.thinkingLevel ?? ''),
    localServerPreset: String(profile.localServerPreset ?? ''),
    billing: {
      inputUsdPerMillion: Number(profile.billing?.inputUsdPerMillion ?? 0),
      cachedInputUsdPerMillion: Number(profile.billing?.cachedInputUsdPerMillion ?? 0),
      cacheWriteUsdPerMillion: Number(profile.billing?.cacheWriteUsdPerMillion ?? 0),
      outputUsdPerMillion: Number(profile.billing?.outputUsdPerMillion ?? 0),
      profileBudgetUsd: Number(profile.billing?.profileBudgetUsd ?? 0),
    },
    generation: structuredClone(generation),
  };
}

function dependencyProfiles(rootProfileId, profiles, normalizeGenerationSettings) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const selected = [];
  const visited = new Set();
  const queue = [rootProfileId];
  while (queue.length) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    const profile = byId.get(id);
    if (!profile) throw new RangeError(`生成工程が存在しないAIプロファイルを参照しています: ${id}`);
    visited.add(id);
    selected.push(profile);
    const generation = normalizeGenerationSettings(profile.generation);
    for (const key of ['reasoningProfileId', 'outputProfileId', 'critiqueProfileId']) {
      if (generation[key] && !visited.has(generation[key])) queue.push(generation[key]);
    }
  }
  return selected;
}

export function createAiProfileTransferController(context) {
  const {
    collectManagementForm,
    controller,
    createProfileId,
    normalizeGenerationSettings,
    persistSettings,
    runtime,
    setManagementDirty,
  } = context;

  async function exportSelectedProfileJson() {
    const saved = await persistSettings(collectManagementForm(), { refresh: false });
    setManagementDirty(false);
    const rootId = controller.selectedProfileId && saved.profiles.some((profile) => profile.id === controller.selectedProfileId)
      ? controller.selectedProfileId
      : saved.profiles[0]?.id;
    const root = saved.profiles.find((profile) => profile.id === rootId);
    if (!root) throw new Error('出力するAIプロファイルがありません。');
    const dependencies = dependencyProfiles(root.id, saved.profiles, normalizeGenerationSettings);
    const documentValue = {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      rootProfileId: root.id,
      profiles: dependencies.map((profile) => exportableProfile(profile, normalizeGenerationSettings)),
    };
    downloadJson(`ai-profile-${sanitizeFilenamePart(root.label, { fallback: 'profile', whitespaceReplacement: '-', maxLength: 60 })}.json`, documentValue);
    runtime().toast(`「${root.label}」のプロファイルデータを出力しました。APIキーは含めていません${dependencies.length > 1 ? `（生成工程の依存プロファイル${dependencies.length - 1}件を同梱）` : ''}。`, 'success');
  }

  async function importProfileJsonFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new RangeError('AIプロファイルJSONは2MB以下にしてください。');
    let raw;
    try {
      raw = JSON.parse(await readFileText(file));
    } catch (error) {
      if (error instanceof SyntaxError) throw new SyntaxError('AIプロファイルJSONを解析できません。');
      throw error;
    }
    const packageValue = validatePackage(raw);
    const current = await persistSettings(collectManagementForm(), { refresh: false });
    setManagementDirty(false);
    if (current.profiles.length + packageValue.profiles.length > MAX_PROFILE_COUNT) {
      throw new RangeError(`AIプロファイルは最大${MAX_PROFILE_COUNT}件です。現在${current.profiles.length}件のため、このJSON ${packageValue.profiles.length}件を追加できません。`);
    }
    const idMap = new Map(packageValue.profiles.map((profile) => [profile.id, createProfileId()]));
    const imported = packageValue.profiles.map((profile) => {
      const generation = structuredClone(profile.generation);
      for (const key of ['reasoningProfileId', 'outputProfileId', 'critiqueProfileId']) {
        generation[key] = generation[key] === null ? null : idMap.get(generation[key]) ?? null;
      }
      return {
        ...structuredClone(profile),
        id: idMap.get(profile.id),
        hasApiKey: false,
        apiKey: '',
        clearApiKey: false,
        generation,
      };
    });
    const rootId = idMap.get(packageValue.rootProfileId);
    controller.selectedProfileId = rootId;
    const root = imported.find((profile) => profile.id === rootId);
    await persistSettings({ ...current, profiles: [...current.profiles, ...imported] }, {
      refresh: true,
      statusMessage: `AIプロファイル「${root?.label ?? '読込プロファイル'}」をJSONから追加しました。`,
    });
    setManagementDirty(false);
    runtime().toast(`AIプロファイル${imported.length}件を読み込みました。APIキーは安全のため未設定です。`, 'success');
  }

  return Object.freeze({ exportSelectedProfileJson, importProfileJsonFile });
}
