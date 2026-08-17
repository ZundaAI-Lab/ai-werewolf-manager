/**
 * 責務: 外部LLMデータ送信の分類・初回確認状態が、AI設定や個人入力データと分離された契約を維持することを検証する。
 * 変更ルール: 文言の細部ではなく、外部/ローカル分類、説明版の再確認、最小保存データ、Main側送信ガードの存在を固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PRIVACY_NOTICE_SCHEMA_VERSION, PrivacyNoticeStore } = require('../../../app/main/privacyNoticeStore.js');
const policy = require('../../../app/shared/dataTransmissionPolicy.js');
const { runExternalDataOperation } = require('../../../app/main/externalDataNoticeGate.js');

test('AIプロバイダーのデータ経路はデモ・専用ローカル・外部へ分類する', () => {
  assert.equal(policy.providerDataRoute('demo'), 'demo');
  assert.equal(policy.providerDataRoute('local-openai-compatible'), 'local');
  assert.equal(policy.providerDataRoute('openai'), 'external');
  assert.equal(policy.providerDataRoute('openai-compatible'), 'external');
});

test('外部LLM確認状態は説明版番号だけをAI設定と分離して保存する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-privacy-notice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = new PrivacyNoticeStore(root);
  assert.deepEqual(store.status(), {
    externalDataNoticeVersion: policy.EXTERNAL_DATA_NOTICE_VERSION,
    accepted: false,
  });
  assert.throws(() => store.accept(policy.EXTERNAL_DATA_NOTICE_VERSION + 1), /版が現行ではありません/u);

  const accepted = store.accept(policy.EXTERNAL_DATA_NOTICE_VERSION);
  assert.equal(accepted.accepted, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'privacy-notice.json'), 'utf8'));
  assert.deepEqual(persisted, {
    schemaVersion: PRIVACY_NOTICE_SCHEMA_VERSION,
    externalDataNoticeVersion: policy.EXTERNAL_DATA_NOTICE_VERSION,
  });

  const reloaded = new PrivacyNoticeStore(root);
  assert.equal(reloaded.status().accepted, true);

  fs.writeFileSync(path.join(root, 'privacy-notice.json'), JSON.stringify({
    schemaVersion: PRIVACY_NOTICE_SCHEMA_VERSION,
    externalDataNoticeVersion: policy.EXTERNAL_DATA_NOTICE_VERSION - 1,
  }), 'utf8');
  const outdated = new PrivacyNoticeStore(root);
  assert.equal(outdated.status().accepted, false);
});

test('未確認の外部LLMはMain側Gateで通信処理そのものを開始しない', async () => {
  let calls = 0;
  const operation = async () => { calls += 1; return { ok: true }; };
  const unacceptedStore = { status: () => ({ accepted: false }) };
  await assert.rejects(
    runExternalDataOperation({ profile: { provider: 'openai' }, privacyNoticeStore: unacceptedStore, operation }),
    (error) => error?.code === 'EXTERNAL_DATA_NOTICE_REQUIRED',
  );
  assert.equal(calls, 0);

  const acceptedStore = { status: () => ({ accepted: true }) };
  await runExternalDataOperation({ profile: { provider: 'openai' }, privacyNoticeStore: acceptedStore, operation });
  assert.equal(calls, 1);

  await runExternalDataOperation({ profile: { provider: 'demo' }, privacyNoticeStore: unacceptedStore, operation });
  await runExternalDataOperation({ profile: { provider: 'local-openai-compatible' }, privacyNoticeStore: unacceptedStore, operation });
  assert.equal(calls, 3);
});

test('AI設定保存は外部LLM確認状態から独立して実行できる', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/settingsPersistenceCoordinator.js'), 'utf8')
    .replace(/\nexport \{\};\s*$/u, '\n');
  const window = {};
  window.window = window;
  const context = vm.createContext({
    window,
    document: { querySelector: () => null },
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'settingsPersistenceCoordinator.js' });

  let saveCalls = 0;
  const controller = { settings: {}, persistedUsage: null };
  const runtimeApi = {
    setPublicHistoryTransmissionMode() {},
    setAiExecutionSettings() {},
    refreshTab() {},
  };
  const coordinator = window.AiWerewolfSettingsPersistenceCoordinator.createSettingsPersistenceCoordinator({
    bridge: {
      isDesktop: true,
      async saveSettings(settings) { saveCalls += 1; return settings; },
      async getUsageSummary() { return { totals: {}, totalCostUsd: 0, profiles: {} }; },
    },
    controller,
    currentGameState: () => null,
    emptyUsage: () => ({}),
    firstEnabledProfileId: () => '',
    refreshVisibleUi() {},
    runtime: () => runtimeApi,
    setStatus() {},
  });

  const settings = { profiles: [{ id: 'external', provider: 'openai', enabled: true }], aiOptions: {} };
  await coordinator.persistSettings(settings, { refresh: false });
  assert.equal(saveCalls, 1);
  assert.equal(controller.settings.profiles[0].provider, 'openai');
});

test('確認状態のRenderer IPC契約をpreloadが公開する', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '../../../app/main/preload.js'), 'utf8');
  assert.match(preloadSource, /loadExternalDataNoticeStatusSync/u);
  assert.match(preloadSource, /acceptExternalDataNotice/u);
});
