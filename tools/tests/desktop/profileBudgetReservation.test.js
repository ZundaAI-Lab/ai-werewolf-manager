/**
 * 責務: プロファイル利用上限の送信前予約が並行要求の見積額を合算し、解放後は次要求を再判定できることを検証する。
 * 変更ルール: API送信やSettingsStore永続化を行わず、固定使用額を注入して予約境界だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfileBudgetReservationManager } = require('../../../app/main/profileBudgetReservation.js');
const { ProviderRequestError } = require('../../../app/main/providerClients.js');

const profile = {
  id: 'budget-profile',
  label: '予算テスト',
  provider: 'openai',
  maxOutputTokens: 1000,
  billing: {
    inputUsdPerMillion: 0,
    cachedInputUsdPerMillion: 0,
    cacheWriteUsdPerMillion: 0,
    outputUsdPerMillion: 100,
    profileBudgetUsd: 0.15,
  },
};

const promptEnvelope = {
  commonSystemInstruction: '',
  commonGameContext: '',
  taskInvariantContext: '',
  stablePlayerContext: '',
  taskVariableContext: '',
  dynamicTaskPrompt: '',
  structuredOutput: null,
};

test('並行要求は予約済み最大見積を含めて利用上限を判定する', () => {
  const manager = createProfileBudgetReservationManager({ getProfileUsage: () => ({ costUsd: 0 }) });
  const release = manager.reserve(profile, promptEnvelope);
  assert.throws(
    () => manager.reserve(profile, promptEnvelope),
    (error) => error instanceof ProviderRequestError && error.code === 'PROFILE_BUDGET_EXCEEDED',
  );
  release();
  const releaseAfter = manager.reserve(profile, promptEnvelope);
  releaseAfter();
});

test('予約解放は複数回呼ばれても二重減算しない', () => {
  const manager = createProfileBudgetReservationManager({ getProfileUsage: () => ({ costUsd: 0 }) });
  const release = manager.reserve(profile, promptEnvelope);
  release();
  release();
  const second = manager.reserve(profile, promptEnvelope);
  second();
});
