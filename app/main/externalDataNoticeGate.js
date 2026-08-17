/**
 * 責務: 外部LLMへの実通信直前に確認済み状態を検査し、未確認なら通信処理そのものを開始させない。
 * 変更ルール: 設定保存やUI表示を扱わない。外部/ローカル分類はshared/dataTransmissionPolicy.jsを正本とし、外部通信を追加するMain処理はこのGate経由で実行する。
 */

'use strict';

const { ProviderRequestError } = require('./providerClients.js');
const { isExternalDataProvider } = require('../shared/dataTransmissionPolicy.js');

function assertExternalDataNoticeAccepted(profile, privacyNoticeStore) {
  if (!isExternalDataProvider(profile?.provider) || privacyNoticeStore?.status().accepted === true) return;
  throw new ProviderRequestError('外部LLMへのデータ送信について未確認です。AI管理の「AI通信とプライバシー」を確認してから外部LLMを使用してください。', {
    provider: profile?.provider ?? '',
    code: 'EXTERNAL_DATA_NOTICE_REQUIRED',
    retryable: false,
    deliveryUnknown: false,
  });
}

async function runExternalDataOperation({ profile, privacyNoticeStore, operation }) {
  if (typeof operation !== 'function') throw new TypeError('外部LLM通信処理がありません。');
  assertExternalDataNoticeAccepted(profile, privacyNoticeStore);
  return operation();
}

module.exports = {
  assertExternalDataNoticeAccepted,
  runExternalDataOperation,
};
