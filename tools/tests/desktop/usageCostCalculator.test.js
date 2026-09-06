/**
 * 責務: AI利用料金計算が入力・キャッシュ入力・出力単価を正しく合算し、プロファイル利用上限を判定する契約を検証する。
 * 変更ルール: 過去の丸め不具合や特定高額値をfixture化せず、通常の料金計算と上限判定という公開契約だけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateUsageCostUsd,
  profileBudgetStatus,
} = require('../../../app/main/llm/usageCostCalculator.js');

test('利用料金はトークン種別ごとの単価を合算し設定上限と比較する', () => {
  const profile = {
    provider: 'openai',
    billing: {
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 4,
      profileBudgetUsd: 5,
    },
  };
  const cost = calculateUsageCostUsd(profile, {
    inputTokens: 1_000_000,
    cachedInputTokens: 250_000,
    outputTokens: 500_000,
  });
  assert.equal(cost, 3.75);
  assert.equal(profileBudgetStatus(profile, 1, cost).wouldExceed, false);
  assert.equal(profileBudgetStatus(profile, 2, cost).wouldExceed, true);
});
