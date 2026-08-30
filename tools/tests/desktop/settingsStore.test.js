/**
 * 責務: 現行AI設定、正式リリース済み設定の一方向移行、退避済み設定の救済、割り当て、使用量、詳細ログ権限、入力値正規化、秘密情報分離の保存契約を確認する。
 * 変更ルール: v1.0.3以降の正式保存データをfixtureとして保持し、AIプロファイル・暗号化APIキー・工程担当参照を失う変更を禁止する。AIプロファイル削除前バックアップは3世代保持し、読込不能退避・schema移行前バックアップとは別管理する。内部実装の旧仕様は本体へ戻さない。
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


function writeV103SettingsFixture(directory) {
  const { SettingsStore, SETTINGS_SCHEMA_VERSION } = loadSettingsStore();
  const store = new SettingsStore(directory);
  store.savePublicSettings({
    ...store.publicSettings(),
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    profiles: [
      {
        id: 'profile-main', label: '旧OpenAI', provider: 'openai', model: 'gpt-test', enabled: true,
        apiKey: 'old-secret', generation: {
          depth: 4,
          reasoningProfileId: 'profile-helper', outputProfileId: 'profile-helper', critiqueProfileId: 'profile-helper',
          taskOverrides: { speech: null, vote: 2, nightAction: null, privateConversation: null, resultImpression: null, memoConsolidate: null },
        },
      },
      {
        id: 'profile-helper', label: '旧補助AI', provider: 'demo', model: 'demo-balanced', enabled: true,
      },
    ],
    assignments: { 'player-a': 'profile-main' },
  });
  const settingsPath = path.join(directory, 'desktop-settings.json');
  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  raw.schemaVersion = 1;
  raw.profiles = raw.profiles.map((profile) => {
    const generation = profile.generation;
    return {
      ...profile,
      generation: {
        depth: generation.depth,
        draftProfileId: generation.reasoningProfileId,
        renderProfileId: generation.outputProfileId,
        proofreadProfileId: generation.critiqueProfileId,
        taskOverrides: generation.taskOverrides,
      },
    };
  });
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf8');
  return { settingsPath, raw };
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
  assert.equal(store.publicSettings().aiOptions.publicHistoryMode, 'delta');
  assert.deepEqual(store.publicSettings().profiles.map((profile) => profile.id), ['profile-demo']);
});

test('Mainは共有AI設定schemaVersionを正本にする', () => {
  const shared = require('../../../app/shared/settingsSchema.js');
  const main = loadSettingsStore();
  assert.equal(main.SETTINGS_SCHEMA_VERSION, shared.SETTINGS_SCHEMA_VERSION);
});


test('v1.0.3のAI設定を起動時にschema 2へ移行しプロファイル・暗号化APIキー・担当参照を保持する', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-v103-migration-'));
  const { settingsPath } = writeV103SettingsFixture(directory);
  const { SettingsStore, SETTINGS_SCHEMA_VERSION } = loadSettingsStore();
  const store = new SettingsStore(directory);
  const loaded = store.publicSettings();

  assert.equal(loaded.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(loaded.profiles.map((profile) => profile.id), ['profile-main', 'profile-helper']);
  assert.equal(loaded.assignments['player-a'], 'profile-main');
  assert.equal(loaded.profiles[0].generation.reasoningProfileId, 'profile-helper');
  assert.equal(loaded.profiles[0].generation.outputProfileId, 'profile-helper');
  assert.equal(loaded.profiles[0].generation.critiqueProfileId, 'profile-helper');
  assert.equal(store.decryptApiKey('profile-main'), 'old-secret');
  const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(persisted.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(persisted.profiles[0].generation, 'draftProfileId'), false);
  assert.equal(fs.existsSync(`${settingsPath}.pre-schema-1.json`), true);
});

test('v1.0.4で退避済みになったv1.0.3 AI設定をdesktop-settings不在時に自動復元する', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-v103-quarantine-recovery-'));
  const { settingsPath, raw } = writeV103SettingsFixture(directory);
  fs.unlinkSync(settingsPath);
  const backupPath = `${settingsPath}.unreadable-1700000000000-test.bak`;
  fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2), 'utf8');

  const { SettingsStore, SETTINGS_SCHEMA_VERSION } = loadSettingsStore();
  const store = new SettingsStore(directory);
  const loaded = store.publicSettings();
  assert.equal(loaded.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(loaded.profiles.map((profile) => profile.id), ['profile-main', 'profile-helper']);
  assert.equal(store.decryptApiKey('profile-main'), 'old-secret');
  assert.equal(fs.existsSync(backupPath), true, '退避元を削除しない');
  assert.equal(fs.existsSync(settingsPath), true, '現行設定を復元保存する');
  assert.equal(store.consumeStartupNotices().some((notice) => notice.code === 'SETTINGS_RECOVERED_QUARANTINE'), true);
});

test('現行設定が既定値だけならv1.0.4で退避済みのv1.0.3 AI設定を優先復元する', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-v103-default-recovery-'));
  const { settingsPath, raw } = writeV103SettingsFixture(directory);
  const backupPath = `${settingsPath}.unreadable-1700000000001-test.bak`;
  fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2), 'utf8');

  fs.unlinkSync(settingsPath);
  const { SettingsStore } = loadSettingsStore();
  const defaultStore = new SettingsStore(directory);
  defaultStore.savePublicSettings(defaultStore.publicSettings());
  const recoveredStore = new SettingsStore(directory);
  assert.deepEqual(recoveredStore.publicSettings().profiles.map((profile) => profile.id), ['profile-main', 'profile-helper']);
  assert.equal(recoveredStore.decryptApiKey('profile-main'), 'old-secret');
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

test('API要求詳細ログはPOSIXで現行ファイルとローテーション世代を0600へ制限する', { skip: process.platform === 'win32' }, () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-request-log-mode-'));
  const logPath = path.join(directory, 'llm-request-log.jsonl');
  const rotatedPath = `${logPath}.1`;
  fs.writeFileSync(logPath, 'existing\n', { encoding: 'utf8', mode: 0o644 });
  fs.writeFileSync(rotatedPath, 'rotated\n', { encoding: 'utf8', mode: 0o644 });
  fs.chmodSync(logPath, 0o644);
  fs.chmodSync(rotatedPath, 0o644);

  const store = new SettingsStore(directory);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(rotatedPath).mode & 0o777, 0o600);

  store.savePublicSettings({
    ...store.publicSettings(),
    aiOptions: { ...store.publicSettings().aiOptions, apiLogScope: 'all' },
  });
  store.recordRequest({ profileId: 'profile-demo', label: 'デモAI', provider: 'demo', model: 'demo-balanced', status: 'completed', usage: {} });
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
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
    profiles: [{ ...base.profiles[0], id: 'owner', generation: { ...generation, critiqueProfileId: 'missing' } }],
  }), /存在しないAIプロファイル/u);

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles: [
      { ...base.profiles[0], id: 'owner', enabled: true, generation: { ...generation, critiqueProfileId: 'disabled' } },
      { ...base.profiles[0], id: 'disabled', enabled: false, generation: { ...generation } },
    ],
  }), /無効なAIプロファイル/u);

  store.savePublicSettings({
    ...base,
    profiles: [
      { ...base.profiles[0], id: 'owner', generation: { ...generation, critiqueProfileId: 'proofreader' } },
      { ...base.profiles[0], id: 'proofreader', generation: { ...generation } },
    ],
  });
  assert.throws(() => store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [store.publicSettings().profiles.find((profile) => profile.id === 'owner')],
  }), /参照しているAIプロファイルは削除できません/u);

  assert.throws(() => store.savePublicSettings({ ...store.publicSettings(), profiles: [] }), /0件として保存することはできません/u);
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


test('カスタム接続先のendpoint変更時は保存済みAPIキーを引き継がない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-custom-endpoint-secret-scope-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  store.savePublicSettings({
    ...base,
    profiles: [{
      ...base.profiles[0],
      id: 'custom-main',
      label: 'Custom',
      provider: 'openai-compatible',
      model: 'custom-model',
      endpoint: 'https://gateway.example/service-a/v1/chat/completions',
      apiKey: 'secret-a',
    }],
  });
  assert.equal(store.decryptApiKey('custom-main'), 'secret-a');

  const sameEndpoint = store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [{ ...store.publicSettings().profiles[0] }],
  });
  assert.equal(sameEndpoint.profiles[0].hasApiKey, true);
  assert.equal(store.decryptApiKey('custom-main'), 'secret-a');

  const changedEndpoint = store.savePublicSettings({
    ...sameEndpoint,
    profiles: [{
      ...sameEndpoint.profiles[0],
      endpoint: 'https://gateway.example/service-b/v1/chat/completions',
    }],
  });
  assert.equal(changedEndpoint.profiles[0].hasApiKey, false);
  assert.equal(store.decryptApiKey('custom-main'), '');
});

test('破損したAI設定は退避してから既定値へ切り替え、以後の保存で退避元を上書きしない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-settings-corrupt-quarantine-'));
  const settingsPath = path.join(directory, 'desktop-settings.json');
  const corruptText = '{"schemaVersion":';
  fs.writeFileSync(settingsPath, corruptText, 'utf8');

  const store = new SettingsStore(directory);
  assert.equal(store.publicSettings().executionMode, 'automatic');
  const backups = fs.readdirSync(directory).filter((name) => name.startsWith('desktop-settings.json.unreadable-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), corruptText);
  assert.equal(fs.existsSync(settingsPath), false);

  assert.throws(
    () => store.savePublicSettings({ ...store.publicSettings(), executionMode: 'manual' }),
    (error) => error?.code === 'SETTINGS_READ_ONLY',
  );
  assert.equal(fs.existsSync(settingsPath), false);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), corruptText);
});

test('通常保存ではAIプロファイル削除を拒否し、明示削除だけバックアップ付きで許可する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-profile-delete-guard-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  store.savePublicSettings({
    ...base,
    profiles: [
      { ...base.profiles[0], id: 'keep-profile', label: '保持' },
      { ...base.profiles[0], id: 'delete-profile', label: '削除対象' },
    ],
  });
  const beforeDelete = store.publicSettings();
  const candidate = { ...beforeDelete, profiles: beforeDelete.profiles.filter((profile) => profile.id !== 'delete-profile') };
  assert.throws(
    () => store.savePublicSettings(candidate),
    (error) => error?.code === 'SETTINGS_PROFILE_DELETION_REQUIRES_EXPLICIT_ACTION',
  );
  assert.equal(store.publicSettings().profiles.length, 2);

  const saved = store.savePublicSettings(candidate, { allowedProfileDeletionIds: ['delete-profile'] });
  assert.deepEqual(saved.profiles.map((profile) => profile.id), ['keep-profile']);
  const backups = fs.readdirSync(directory).filter((name) => name.startsWith('desktop-settings.json.before-profile-delete-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(directory, backups[0]), 'utf8'));
  assert.deepEqual(backup.profiles.map((profile) => profile.id), ['keep-profile', 'delete-profile']);
});


test('AIプロファイル削除前バックアップは最新3世代だけ保持し他種バックアップを削除しない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-profile-delete-backup-retention-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  store.savePublicSettings({
    ...base,
    profiles: [
      { ...base.profiles[0], id: 'keep-profile', label: '保持' },
      { ...base.profiles[0], id: 'delete-profile', label: '削除対象' },
    ],
  });

  const oldBackupNames = [1, 2, 3].map((index) => `desktop-settings.json.before-profile-delete-${1000 + index}-old-${index}.bak`);
  oldBackupNames.forEach((name, index) => {
    const backupPath = path.join(directory, name);
    fs.writeFileSync(backupPath, `old-${index + 1}`, 'utf8');
    fs.utimesSync(backupPath, new Date(1000 + index), new Date(1000 + index));
  });
  const unreadableBackup = path.join(directory, 'desktop-settings.json.unreadable-test.bak');
  const preSchemaBackup = path.join(directory, 'desktop-settings.json.pre-schema-1.json');
  fs.writeFileSync(unreadableBackup, 'unreadable', 'utf8');
  fs.writeFileSync(preSchemaBackup, 'pre-schema', 'utf8');

  const beforeDelete = store.publicSettings();
  store.savePublicSettings(
    { ...beforeDelete, profiles: beforeDelete.profiles.filter((profile) => profile.id !== 'delete-profile') },
    { allowedProfileDeletionIds: ['delete-profile'] },
  );

  const backups = fs.readdirSync(directory)
    .filter((name) => name.startsWith('desktop-settings.json.before-profile-delete-') && name.endsWith('.bak'));
  assert.equal(backups.length, 3);
  const jsonBackups = backups
    .map((name) => path.join(directory, name))
    .filter((backupPath) => fs.readFileSync(backupPath, 'utf8').trimStart().startsWith('{'));
  assert.equal(jsonBackups.length, 1);
  const newestBackup = JSON.parse(fs.readFileSync(jsonBackups[0], 'utf8'));
  assert.deepEqual(newestBackup.profiles.map((profile) => profile.id), ['keep-profile', 'delete-profile']);
  assert.equal(fs.existsSync(unreadableBackup), true);
  assert.equal(fs.existsSync(preSchemaBackup), true);
});

test('割り当て専用保存はAIプロファイル本体と暗号化APIキーを変更しない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-assignment-only-save-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  store.savePublicSettings({
    ...base,
    profiles: [{ ...base.profiles[0], id: 'profile-main', label: 'Main', provider: 'openai', model: 'gpt-test', apiKey: 'secret-key' }],
  });
  const before = store.publicSettings();
  const saved = store.saveAssignments({ player01: 'profile-main' });
  assert.deepEqual(saved.profiles, before.profiles);
  assert.equal(store.decryptApiKey('profile-main'), 'secret-key');
  assert.equal(saved.assignments.player01, 'profile-main');
});

test('カスタム接続先の表記差だけでは保存済みAPIキーを破棄しない', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-custom-endpoint-identity-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  store.savePublicSettings({
    ...base,
    profiles: [{
      ...base.profiles[0],
      id: 'custom-identity',
      label: 'Custom identity',
      provider: 'openai-compatible',
      model: 'custom-model',
      endpoint: 'https://api.Example.com/v1',
      apiKey: 'secret-identity',
    }],
  });

  const saved = store.savePublicSettings({
    ...store.publicSettings(),
    profiles: [{ ...store.publicSettings().profiles[0], endpoint: 'https://api.example.com/v1/' }],
  });
  assert.equal(saved.profiles[0].hasApiKey, true);
  assert.equal(store.decryptApiKey('custom-identity'), 'secret-identity');
});

test('保存境界で不正なカスタム接続先と非ループバックのローカルLLM接続先を拒否する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-endpoint-save-validation-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles: [{
      ...base.profiles[0],
      id: 'invalid-custom',
      provider: 'openai-compatible',
      model: 'custom-model',
      endpoint: 'ftp://api.example.com/v1',
    }],
  }), /APIエンドポイントが不正/u);

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles: [{
      ...base.profiles[0],
      id: 'invalid-local',
      provider: 'local-openai-compatible',
      localServerPreset: 'custom',
      model: 'local-model',
      endpoint: 'http://192.168.1.5:1234/v1/chat/completions',
    }],
  }), /localhost|127\.0\.0\.1|::1/u);
});


test('AIプロファイルが上限を超える場合は切り捨てず保存を拒否する', () => {
  const { SettingsStore, MAX_PROFILE_COUNT } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-profile-count-limit-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  const profiles = Array.from({ length: MAX_PROFILE_COUNT + 1 }, (_, index) => ({
    ...base.profiles[0],
    id: `profile-${index + 1}`,
    label: `Profile ${index + 1}`,
  }));

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles,
  }), new RegExp(`最大${MAX_PROFILE_COUNT}件`, 'u'));
  assert.equal(store.publicSettings().profiles.length, 1);
});

test('500文字を超える新規カスタムendpointは切り詰めず保存を拒否する', () => {
  const { SettingsStore, MAX_ENDPOINT_LENGTH } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-endpoint-length-limit-'));
  const store = new SettingsStore(directory);
  const base = store.publicSettings();
  const prefix = 'https://gateway.example/';
  const endpoint = `${prefix}${'a'.repeat(MAX_ENDPOINT_LENGTH + 1 - prefix.length)}`;
  assert.equal(endpoint.length, MAX_ENDPOINT_LENGTH + 1);

  assert.throws(() => store.savePublicSettings({
    ...base,
    profiles: [{
      ...base.profiles[0],
      id: 'too-long-endpoint',
      provider: 'openai-compatible',
      model: 'custom-model',
      endpoint,
    }],
  }), new RegExp(`上限${MAX_ENDPOINT_LENGTH}文字`, 'u'));
  assert.equal(store.publicSettings().profiles[0].id, 'profile-demo');
});

test('保存済みの現行ルール不適合endpointは文字列を保持し、未変更なら他設定を保存できる', () => {
  const { SettingsStore, MAX_ENDPOINT_LENGTH } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-existing-invalid-endpoint-'));
  const seedStore = new SettingsStore(directory);
  const base = seedStore.publicSettings();
  const valid = seedStore.savePublicSettings({
    ...base,
    profiles: [{
      ...base.profiles[0],
      id: 'existing-custom',
      label: 'Existing custom',
      provider: 'openai-compatible',
      model: 'custom-model',
      endpoint: 'https://gateway.example/v1',
      apiKey: 'existing-secret',
    }],
  });

  const settingsPath = path.join(directory, 'desktop-settings.json');
  const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const prefix = 'https://gateway.example/';
  const tooLongEndpoint = `${prefix}${'b'.repeat(MAX_ENDPOINT_LENGTH + 1 - prefix.length)}`;
  stored.profiles[0].endpoint = tooLongEndpoint;
  fs.writeFileSync(settingsPath, JSON.stringify(stored, null, 2), 'utf8');

  const store = new SettingsStore(directory);
  assert.equal(store.publicSettings().profiles[0].endpoint, tooLongEndpoint);
  const notices = store.consumeStartupNotices();
  assert.equal(notices.some((notice) => notice.code === 'SETTINGS_PROFILE_ENDPOINT_UNAVAILABLE'), true);

  const saved = store.savePublicSettings({
    ...store.publicSettings(),
    executionMode: valid.executionMode === 'manual' ? 'automatic' : 'manual',
  });
  assert.equal(saved.profiles[0].endpoint, tooLongEndpoint);
  assert.equal(store.decryptApiKey('existing-custom'), 'existing-secret');
});

test('破損したAPI使用量集計は退避し、新しい集計だけを別ファイルへ保存する', () => {
  const { SettingsStore } = loadSettingsStore();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-usage-corrupt-quarantine-'));
  const summaryPath = path.join(directory, 'llm-usage-summary.json');
  const corruptText = '{broken';
  fs.writeFileSync(summaryPath, corruptText, 'utf8');

  const store = new SettingsStore(directory);
  const backups = fs.readdirSync(directory).filter((name) => name.startsWith('llm-usage-summary.json.unreadable-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), corruptText);
  store.recordRequest({ profileId: 'profile-demo', label: 'デモAI', provider: 'demo', model: 'demo-balanced', status: 'completed', usage: { totalTokens: 1 } });
  assert.equal(store.flushUsageSummary(), true);
  assert.equal(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).totals.totalTokens, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), corruptText);
});
