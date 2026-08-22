/**
 * 責務: AI応答失敗時の状態再同期と通常・修復・再生成・通信再試行で共有する呼び出し予算を確認する。
 * 変更ルール: 個別バリデータ文言や修復プロンプトを固定せず、再同期判定と呼び出し上限という機械的な再試行状態だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../../app/renderer/js/ai/responseRetryPolicy.js');

test('状態不一致は回答修復せず最新プロンプト再生成へ進む', () => {
  const decision = policy.decideNext({
    recoveryMode: 'stop',
    phase: 'normal',
    commitResult: { issues: [{ code: 'STALE_PROMPT', category: 'state', message: '状態更新' }] },
  });
  assert.equal(decision.action, 'regenerate-prompt');
});

test('通常・修復・再生成とAPI通信再試行は最大4呼び出しを共有する', () => {
  assert.equal(policy.canGenerate(0), true);
  assert.equal(policy.canGenerate(3), true);
  assert.equal(policy.canGenerate(4), false);
  assert.equal(policy.DEFAULT_CALL_BUDGET, 4);
});

