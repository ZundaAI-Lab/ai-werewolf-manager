/**
 * 責務: Provider例外のRenderer公開情報が分類済みエラーだけに限定され、想定外例外の内部詳細を漏らさないことを検証する。
 * 変更ルール: 再試行ポリシーやProvider通信は検証せず、公開エラー境界だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRequestError } = require('../../../app/main/providerClients.js');
const { serializeProviderError } = require('../../../app/main/providerErrorSerializer.js');

test('分類済みProviderエラーと設定RangeErrorは利用者向け情報を保持する', () => {
  const provider = serializeProviderError(new ProviderRequestError('レート制限です。', {
    code: 'RATE_LIMITED', provider: 'openai', status: 429, retryable: true, retryAfterMs: 1000,
  }), 'openai', { logger: { error() {} } });
  assert.equal(provider.message, 'レート制限です。');
  assert.equal(provider.code, 'RATE_LIMITED');
  assert.equal(provider.status, 429);
  assert.equal(provider.retryable, true);

  const configuration = serializeProviderError(new RangeError('設定値が範囲外です。'), 'openai', { logger: { error() {} } });
  assert.equal(configuration.code, 'CONFIGURATION_ERROR');
  assert.equal(configuration.message, '設定値が範囲外です。');
});

test('想定外例外は内部メッセージをRendererへ返さずMainログだけへ残す', () => {
  const logs = [];
  const result = serializeProviderError(new Error('/secret/path internal-token'), 'openai', {
    logger: { error: (...args) => logs.push(args) },
  });
  assert.equal(result.code, 'UNKNOWN');
  assert.doesNotMatch(result.message, /secret|internal-token/u);
  assert.match(result.message, /内部エラー/u);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0][1]?.message), /secret\/path/u);
});
