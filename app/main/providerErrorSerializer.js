/**
 * 責務: Provider境界の例外をRendererへ返してよい構造化エラーへ変換し、想定外例外の内部詳細を公開面から遮断する。
 * 変更ルール: ProviderRequestErrorと利用者が修正可能なRangeErrorだけ具体的メッセージを返し、UNKNOWNの詳細はMainログだけへ残す。ゲーム規則や再試行判断は持たない。
 */

'use strict';

const { ProviderRequestError } = require('./providerClients.js');

function serializeProviderError(error, provider = '', { logger = console } = {}) {
  if (error instanceof ProviderRequestError) {
    return {
      code: error.code,
      message: error.message,
      provider: error.provider ?? provider,
      status: error.status,
      retryable: error.retryable === true,
      deliveryUnknown: error.deliveryUnknown === true,
      retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
    };
  }
  const configurationError = error instanceof RangeError;
  if (!configurationError) logger?.error?.('LLM処理で想定外の内部エラーが発生しました。', error);
  return {
    code: configurationError ? 'CONFIGURATION_ERROR' : 'UNKNOWN',
    message: configurationError
      ? (error?.message ?? 'AI設定が不正です。')
      : '内部エラーが発生しました。詳細はMainプロセスのログを確認してください。',
    provider,
    status: null,
    retryable: false,
    deliveryUnknown: false,
    retryAfterMs: null,
  };
}

module.exports = { serializeProviderError };
