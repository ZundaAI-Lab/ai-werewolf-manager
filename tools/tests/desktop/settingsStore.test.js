/**
 * 責務: 現行AI設定、割り当て、使用量、入力値正規化、秘密情報分離の保存契約を確認する。
 * 変更ルール: 旧形式移行や過去データ専用テストを追加せず、現在保存する設定だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadSettingsStore() {
  const target = require.resolve('../../../app/main/settingsStore.js');
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') {
      return {
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
          decryptString: (value) => value.toString('utf8').replace(/^encrypted:/u, ''),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(target);
  } finally {
    Module._load = originalLoad;
  }
}

test('手動モードとプレイヤー単位割り当てを保存する', () => {
  const { SettingsStore, SETTINGS_SCHEMA_VERSION } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-'));
  const store = new SettingsStore(directory);
  const saved = store.savePublicSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    executionMode: 'manual',
    autoRun: { intervalMs: 500, maxConsecutiveSteps: 100, autoConfirmWarnings: true, autoPublish: true },
    aiOptions: { publicHistoryMode: 'delta', apiErrorAction: 'full-history-retry', responseRecoveryMode: 'repair', apiLogScope: 'none' },
    profiles: [{
      id: 'openai-main', label: 'OpenAI', provider: 'openai', model: 'test-model', endpoint: 'https://example.invalid/v1/responses', enabled: true, timeoutMs: 60000, maxOutputTokens: 2048, apiKey: 'sk-test',
    }],
    assignments: { 'player-a': 'openai-main' },
  });
  assert.equal(saved.executionMode, 'manual');
  assert.deepEqual(saved.aiOptions, { publicHistoryMode: 'delta', apiErrorAction: 'full-history-retry', responseRecoveryMode: 'repair', apiLogScope: 'none' });
  assert.equal(saved.assignments['player-a'], 'openai-main');
  assert.equal(saved.profiles[0].hasApiKey, true);
  assert.equal(saved.profiles[0].endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(Object.hasOwn(saved.profiles[0], 'apiKeyEncrypted'), false);
  assert.equal(store.decryptApiKey('openai-main'), 'sk-test');
});


test('現行schemaVersionでも保存形式が正規形でなければ既定値へリセットする', () => {
  const { SettingsStore, SETTINGS_SCHEMA_VERSION } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-shape-reset-'));
  const settingsPath = path.join(directory, 'desktop-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    executionMode: 'manual',
    autoRun: {},
    aiOptions: {},
    profiles: [],
    assignments: {},
  }), 'utf8');

  const store = new SettingsStore(directory);
  assert.equal(store.publicSettings().executionMode, 'automatic');
  assert.deepEqual(store.publicSettings().profiles.map((profile) => profile.id), ['profile-demo']);
});

test('MainとRendererは共有AI設定schemaVersionを正本にする', () => {
  const shared = require('../../../app/shared/settingsSchema.js');
  const main = loadSettingsStore();
  const configSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/desktopAutomationConfig.js'), 'utf8');
  const managementSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/desktopAutomationManagementView.js'), 'utf8');
  assert.equal(main.SETTINGS_SCHEMA_VERSION, shared.SETTINGS_SCHEMA_VERSION);
  assert.match(configSource, /schemaVersion: SETTINGS_SCHEMA_VERSION/u);
  assert.match(managementSource, /schemaVersion: SETTINGS_SCHEMA_VERSION/u);
  assert.doesNotMatch(configSource, /schemaVersion:\s*\d+/u);
  assert.doesNotMatch(managementSource, /schemaVersion:\s*\d+/u);
});

test('公開履歴の過去圧縮モードを保存・再読込する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-compact-history-'));
  const store = new SettingsStore(directory);
  const saved = store.savePublicSettings({
    ...store.publicSettings(),
    aiOptions: { ...store.publicSettings().aiOptions, publicHistoryMode: 'compact' },
  });
  assert.equal(saved.aiOptions.publicHistoryMode, 'compact');
  assert.equal(new SettingsStore(directory).publicSettings().aiOptions.publicHistoryMode, 'compact');
});

test('設定ファイル保存失敗時は実行中設定を変更しない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-write-failure-'));
  const store = new SettingsStore(directory);
  const before = store.publicSettings();
  fs.mkdirSync(path.join(directory, 'desktop-settings.json'));

  assert.throws(() => store.savePublicSettings({ ...before, executionMode: 'manual' }));
  assert.deepEqual(store.publicSettings(), before);
});

test('詳細ログを保存しなくても用途をまたいでAIプロファイル別のAPI使用量を集計する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-usage-'));
  const store = new SettingsStore(directory);
  store.savePublicSettings({ ...store.publicSettings(), aiOptions: { ...store.publicSettings().aiOptions, apiLogScope: 'none' } });
  store.recordRequest({ profileId: 'profile-demo', label: 'デモAI', provider: 'demo', model: 'demo-balanced', gameId: 'game-a', status: 'completed', retryIndex: 0, isTaskCall: true, taskStart: true, usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, totalTokens: 13, costUsd: 0.01 } });
  store.recordRequest({ profileId: 'profile-demo', label: 'デモAI', provider: 'demo', model: 'demo-balanced', gameId: 'chat-a', taskType: 'chat-room', status: 'completed', retryIndex: 0, isTaskCall: true, taskStart: true, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, costUsd: 0.02 } });
  const summary = store.getUsageSummary();
  assert.equal(summary.totals.totalTokens, 38);
  assert.equal(summary.totalCostUsd, 0.03);
  assert.equal(summary.profiles['profile-demo'].totalTokens, 38);
  assert.equal(summary.profiles['profile-demo'].costUsd, 0.03);
  assert.equal(summary.profiles['profile-demo'].calls, 2);
  assert.equal(summary.profiles['profile-demo'].label, 'デモAI');
  assert.equal(fs.existsSync(path.join(directory, 'llm-request-log.jsonl')), false);
});

test('AIプロファイル単位または全体のAPI使用量だけをリセットし詳細ログを保持する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-usage-reset-'));
  const store = new SettingsStore(directory);
  store.savePublicSettings({ ...store.publicSettings(), aiOptions: { ...store.publicSettings().aiOptions, apiLogScope: 'all' } });
  store.recordRequest({ profileId: 'profile-demo', label: 'デモAI', provider: 'demo', model: 'demo-balanced', gameId: 'game-a', status: 'completed', retryIndex: 0, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.01 } });
  store.recordRequest({ profileId: 'profile-other', label: '別AI', provider: 'openai', model: 'gpt-test', gameId: 'chat-a', status: 'completed', retryIndex: 0, usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, costUsd: 0.02 } });
  const logPath = path.join(directory, 'llm-request-log.jsonl');
  const logBeforeReset = fs.readFileSync(logPath, 'utf8');

  const profileReset = store.resetUsageSummary('profile', 'profile-demo');
  assert.equal(profileReset.totals.totalTokens, 24);
  assert.equal(profileReset.totalCostUsd, 0.02);
  assert.equal(Object.hasOwn(profileReset.profiles, 'profile-demo'), false);
  assert.equal(profileReset.profiles['profile-other'].totalTokens, 24);
  assert.equal(fs.readFileSync(logPath, 'utf8'), logBeforeReset);

  const allReset = store.resetUsageSummary('all');
  assert.equal(allReset.totals.totalTokens, 0);
  assert.equal(allReset.totalCostUsd, 0);
  assert.deepEqual(Object.keys(allReset.profiles), []);
  assert.equal(fs.readFileSync(logPath, 'utf8'), logBeforeReset);
  assert.throws(() => store.resetUsageSummary('unknown', 'profile-demo'), /リセット範囲/u);
  assert.throws(() => store.resetUsageSummary('profile', ''), /AIプロファイルID/u);
});

test('AIプロファイルの並び替え後も配列順と各APIキーの対応を保持する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-profile-order-'));
  const store = new SettingsStore(directory);
  store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [
      { id: 'profile-first', label: '先頭', provider: 'openai', model: 'gpt-test', enabled: true, apiKey: 'key-first' },
      { id: 'profile-second', label: '後方', provider: 'anthropic', model: 'claude-test', enabled: true, apiKey: 'key-second' },
    ],
  });
  const current = store.publicSettings();
  const reordered = store.savePublicSettings({ ...current, profiles: [current.profiles[1], current.profiles[0]] });
  assert.deepEqual(reordered.profiles.map((profile) => profile.id), ['profile-second', 'profile-first']);
  assert.equal(store.decryptApiKey('profile-first'), 'key-first');
  assert.equal(store.decryptApiKey('profile-second'), 'key-second');
});

test('ローカルLLM設定はAPIキーなしで保存しコンテキスト・JSON設定を保持する', () => {
  const { SettingsStore, SETTINGS_SCHEMA_VERSION } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-local-llm-'));
  const store = new SettingsStore(directory);
  const saved = store.savePublicSettings({
    ...store.publicSettings(),
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    profiles: [{
      id: 'local-main',
      label: 'ローカルLLM',
      provider: 'local-openai-compatible',
      model: 'qwen-local',
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      enabled: true,
      maxOutputTokens: 4096,
      contextWindowTokens: 32768,
      promptCacheMode: 'auto',
      anthropicCacheTtl: 'auto',
      chatTokenLimitField: 'max_tokens',
      jsonRequestMode: 'json-object',
      jsonResponseMode: 'extract-object',
      thinkingLevel: 'none',
      localServerPreset: 'ollama',
    }],
  });
  assert.equal(saved.profiles[0].hasApiKey, false);
  assert.equal(saved.profiles[0].contextWindowTokens, 32768);
  assert.equal(saved.profiles[0].promptCacheMode, 'auto');
  assert.equal(saved.profiles[0].anthropicCacheTtl, 'auto');
  assert.equal(Object.hasOwn(saved.profiles[0], 'maxConversationMessages'), false);
  assert.equal(saved.profiles[0].jsonRequestMode, 'json-object');
  assert.equal(saved.profiles[0].jsonResponseMode, 'extract-object');
  assert.equal(saved.profiles[0].thinkingLevel, 'none');
  assert.equal(saved.profiles[0].localServerPreset, 'ollama');
  assert.equal(saved.profiles[0].endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(store.decryptApiKey('local-main'), '');

  const normalized = store.savePublicSettings({
    ...saved,
    profiles: [{ ...saved.profiles[0], thinkingLevel: 'invalid' }],
  });
  assert.equal(normalized.profiles[0].thinkingLevel, 'low');
});

test('生成工程の存在しない参照・無効参照・参照中削除をMain側で拒否する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-generation-reference-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  const generation = base.profiles[0].generation;

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles: [{ ...base.profiles[0], id: 'owner', generation: { ...generation, proofreadProfileId: 'missing' } }],
  }), /存在しないAIプロファイル/u);

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles: [
      { ...base.profiles[0], id: 'owner', enabled: true, generation: { ...generation, proofreadProfileId: 'disabled' } },
      { ...base.profiles[0], id: 'disabled', enabled: false, generation: { ...generation } },
    ],
  }), /無効なAIプロファイル/u);

  store.savePublicSettings({
    ...base,
    profiles: [
      { ...base.profiles[0], id: 'owner', generation: { ...generation, proofreadProfileId: 'proofreader' } },
      { ...base.profiles[0], id: 'proofreader', generation: { ...generation } },
    ],
  });
  assert.throws(() => store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [store.publicSettings().profiles.find((profile) => profile.id === 'owner')],
  }), /参照しているAIプロファイルは削除できません/u);

  const deletedTogether = store.savePublicSettings({ ...store.publicSettings(), profiles: [] });
  assert.equal(deletedTogether.profiles.length >= 1, true);
  assert.equal(deletedTogether.profiles.some((profile) => ['owner', 'proofreader'].includes(profile.id)), false);
});

test('重複プロファイルIDを拒否し既存APIキーを変更しない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-profile-duplicate-'));
  const store = new SettingsStore(directory);
  store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [
      { id: 'profile-first', label: '先頭', provider: 'openai', model: 'gpt-test', enabled: true, apiKey: 'key-first' },
      { id: 'profile-second', label: '後方', provider: 'anthropic', model: 'claude-test', enabled: true, apiKey: 'key-second' },
    ],
  });
  const current = store.publicSettings();
  assert.throws(() => store.savePublicSettings({
    ...current,
    profiles: [current.profiles[0], { ...current.profiles[1], id: current.profiles[0].id }],
  }), /AIプロファイルIDが重複/u);
  assert.equal(store.decryptApiKey('profile-first'), 'key-first');
  assert.equal(store.decryptApiKey('profile-second'), 'key-second');
});

test('無効プロファイルは設定エラーとして分類できるRangeErrorを返す', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-profile-disabled-'));
  const store = new SettingsStore(directory);
  const saved = store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [{ ...store.publicSettings().profiles[0], id: 'disabled-profile', label: '停止中', enabled: false }],
  });
  assert.equal(saved.profiles[0].enabled, false);
  assert.throws(
    () => store.profileById('disabled-profile'),
    (error) => error instanceof RangeError && /停止中は無効/u.test(error.message),
  );
});

test('API詳細ログへ保存する認証情報をマスクし元の記録値は変更しない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-log-redaction-'));
  const store = new SettingsStore(directory);
  store.savePublicSettings({ ...store.publicSettings(), aiOptions: { ...store.publicSettings().aiOptions, apiLogScope: 'all' } });
  const entry = {
    gameId: 'game-log',
    status: 'failed',
    retryIndex: 0,
    usage: {},
    error: 'Authorization: Bearer secret-token-value / sk-abcdefghijk / AIza1234567890abcdefghijklmnop',
    diagnostic: { apiKey: 'plain-secret', header: 'x-api-key: another-secret' },
  };
  store.recordRequest(entry);
  const log = fs.readFileSync(path.join(directory, 'llm-request-log.jsonl'), 'utf8');
  assert.doesNotMatch(log, /secret-token-value|sk-abcdefghijk|AIza1234567890abcdefghijklmnop|plain-secret|another-secret/u);
  assert.match(log, /\[REDACTED\]/u);
  assert.match(entry.error, /secret-token-value/u);
  assert.equal(entry.diagnostic.apiKey, 'plain-secret');
});

test('API使用量は要求ごとに同期書き込みせず明示flushで最新集計を保存する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-usage-batched-'));
  const store = new SettingsStore(directory);
  const summaryPath = path.join(directory, 'llm-usage-summary.json');
  store.recordRequest({ gameId: 'game-batched', status: 'completed', retryIndex: 0, isTaskCall: true, taskStart: true, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
  assert.equal(fs.existsSync(summaryPath), false);
  assert.equal(store.flushUsageSummary(), true);
  const saved = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(saved.totals.calls, 1);
  assert.equal(saved.totals.inputTokens, 12);
  assert.equal(store.flushUsageSummary(), false);
});
