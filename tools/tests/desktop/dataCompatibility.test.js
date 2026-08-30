/**
 * 責務: 各製品データ種別の現行schemaVersion、正式リリース済み旧schemaの一方向migration、未来schema・無版schema拒否を検証する。
 * 変更ルール: 正式リリース済みfixtureから現行schemaへの移行を製品契約として固定し、migrationを削除・意味変更した場合は必ず失敗させる。内部実装の旧仕様はテスト対象にしない。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DATA_SCHEMA_KIND, CURRENT_DATA_SCHEMA_VERSIONS } = require('../../../app/shared/dataCompatibility/schemaVersions.js');
const { migrateData } = require('../../../app/shared/dataCompatibility/migrateData.js');

const PRODUCT_SCHEMA_KINDS = Object.values(DATA_SCHEMA_KIND);

test('全製品データ種別は正の整数の現行schemaVersionを一つだけ持つ', () => {
  assert.deepEqual(Object.keys(CURRENT_DATA_SCHEMA_VERSIONS).sort(), [...PRODUCT_SCHEMA_KINDS].sort());
  PRODUCT_SCHEMA_KINDS.forEach((kind) => {
    assert.equal(Number.isInteger(CURRENT_DATA_SCHEMA_VERSIONS[kind]), true, kind);
    assert.ok(CURRENT_DATA_SCHEMA_VERSIONS[kind] > 0, kind);
  });
});

test('現行schemaは変換せず受理し未来schema・無版schemaは拒否する', () => {
  const kind = DATA_SCHEMA_KIND.APPEARANCE;
  const currentVersion = CURRENT_DATA_SCHEMA_VERSIONS[kind];
  const current = { schemaVersion: currentVersion, theme: 'dark' };
  const accepted = migrateData(kind, current, { label: '外観設定' });

  assert.equal(accepted.migrated, false);
  assert.deepEqual(accepted.value, current);
  assert.throws(
    () => migrateData(kind, { schemaVersion: currentVersion + 1 }, { label: '外観設定' }),
    /現在のアプリより新しいschemaVersion/u,
  );
  assert.throws(
    () => migrateData(kind, { theme: 'dark' }, { label: '外観設定' }),
    /有効なschemaVersionがありません/u,
  );
});


test('migrationはアプリversionではなくschemaVersionだけで選択する', () => {
  const source = {
    schemaVersion: 1,
    appVersion: 'arbitrary-old-version',
    aiTurns: [],
    undoStack: [],
    redoStack: [],
    restorePoints: [],
  };
  const changedLabel = { ...source, appVersion: 'arbitrary-other-version' };
  const first = migrateData(DATA_SCHEMA_KIND.GAME_STATE, source, { label: 'ゲーム保存データ' }).value;
  const second = migrateData(DATA_SCHEMA_KIND.GAME_STATE, changedLabel, { label: 'ゲーム保存データ' }).value;

  assert.equal(first.schemaVersion, 2);
  assert.equal(second.schemaVersion, 2);
  assert.equal(first.appVersion, 'arbitrary-old-version');
  assert.equal(second.appVersion, 'arbitrary-other-version');
  assert.deepEqual(
    { ...first, appVersion: '<ignored>' },
    { ...second, appVersion: '<ignored>' },
    'appVersionの値でmigration内容を分岐しない',
  );
});

test('v1.0.3のdesktop-settings schema 1をAIプロファイル参照を保持してschema 2へ移行する', () => {
  const raw = {
    schemaVersion: 1,
    executionMode: 'automatic',
    autoRun: { intervalMs: 450, maxConsecutiveSteps: 500, autoConfirmWarnings: true, autoPublish: true },
    aiOptions: { publicHistoryMode: 'delta', apiErrorAction: 'retry', responseRecoveryMode: 'repair-regenerate', apiLogScope: 'errors' },
    profiles: [{
      id: 'profile-main', generation: {
        depth: 4,
        draftProfileId: 'profile-reasoning',
        renderProfileId: 'profile-output',
        proofreadProfileId: 'profile-review',
        taskOverrides: { speech: null, vote: 2, nightAction: null, privateConversation: null, resultImpression: null, memoConsolidate: null },
      },
    }],
    assignments: { 'player-a': 'profile-main' },
  };
  const before = structuredClone(raw);
  const migrated = migrateData(DATA_SCHEMA_KIND.DESKTOP_SETTINGS, raw, { label: '保存AI設定' });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.value.schemaVersion, 2);
  assert.deepEqual(migrated.value.profiles[0].generation, {
    depth: 4,
    taskOverrides: { speech: null, vote: 2, nightAction: null, privateConversation: null, resultImpression: null, memoConsolidate: null },
    reasoningProfileId: 'profile-reasoning',
    outputProfileId: 'profile-output',
    critiqueProfileId: 'profile-review',
  });
  assert.deepEqual(raw, before, 'migration元を破壊しない');
});

test('v1.0.3のAIプロファイルpackage schema 1を依存参照を保持してschema 2へ移行する', () => {
  const raw = {
    format: 'ai-werewolf-manager-profile',
    schemaVersion: 1,
    exportedAt: '2026-08-01T00:00:00.000Z',
    rootProfileId: 'profile-main',
    profiles: [{
      id: 'profile-main',
      generation: {
        depth: 3,
        draftProfileId: 'profile-reasoning', renderProfileId: null, proofreadProfileId: null,
        taskOverrides: { speech: null, vote: null, nightAction: null, privateConversation: null, resultImpression: null, memoConsolidate: null },
      },
    }],
  };
  const migrated = migrateData(DATA_SCHEMA_KIND.AI_PROFILE_PACKAGE, raw, { label: 'AIプロファイルJSON' });
  assert.equal(migrated.value.schemaVersion, 2);
  assert.equal(migrated.value.profiles[0].generation.reasoningProfileId, 'profile-reasoning');
  assert.equal(migrated.value.profiles[0].generation.outputProfileId, null);
  assert.equal(migrated.value.profiles[0].generation.critiqueProfileId, null);
  assert.equal(Object.hasOwn(migrated.value.profiles[0].generation, 'draftProfileId'), false);
});

test('v1.0.3のgame-state schema 1はgenerationRun監査と履歴内snapshotを保持してschema 2へ移行する', () => {
  const oldRun = {
    schemaVersion: 1, executionMode: 'automatic', depth: 4, ownerProfileId: 'owner', taskCategory: 'speech',
    normalCallCount: 3, totalCallCount: 3, finalStageId: 'proofread',
    stages: [
      { stageId: 'draft', executorProfileId: 'draft-ai', status: 'accepted', attemptCount: 1, targetTextFields: [], skipReason: null, rawResponse: '{"draft":1}', fallbackUsed: false, issues: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 } },
      { stageId: 'render', executorProfileId: 'render-ai', status: 'applied', attemptCount: 1, targetTextFields: ['publicSpeech'], skipReason: null, rawResponse: '{"publicSpeech":"a"}', fallbackUsed: false, issues: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 } },
      { stageId: 'proofread', executorProfileId: 'review-ai', status: 'applied', attemptCount: 1, targetTextFields: ['publicSpeech'], skipReason: null, rawResponse: '{"publicSpeech":"b"}', fallbackUsed: false, issues: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 } },
    ],
  };
  const raw = {
    schemaVersion: 1,
    aiTurns: [{ id: 'turn-a', generationRun: oldRun }],
    undoStack: [{ id: 'history-a', state: { schemaVersion: 1, aiTurns: [{ id: 'turn-b', generationRun: oldRun }], undoStack: [], redoStack: [], restorePoints: [] } }],
    redoStack: [], restorePoints: [],
  };
  const migrated = migrateData(DATA_SCHEMA_KIND.GAME_STATE, raw, { label: 'ゲーム保存データ' }).value;
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.aiTurns[0].generationRun.stages.map((stage) => stage.stageId), ['decide', 'render', 'render']);
  assert.equal(migrated.aiTurns[0].generationRun.finalStageId, 'render');
  assert.equal(migrated.aiTurns[0].generationRun.schemaVersion, 2);
  assert.deepEqual(migrated.aiTurns[0].generationRun.stages.map((stage) => stage.rejectedAttempts), [[], [], []]);
  assert.equal(migrated.undoStack[0].state.schemaVersion, 2);
  assert.equal(migrated.undoStack[0].state.aiTurns[0].generationRun.schemaVersion, 2);
});
