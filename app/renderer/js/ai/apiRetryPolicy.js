/**
 * 責務: 構造化されたAPIエラーとユーザー設定から、停止・同一要求再試行・最新状態・公開履歴全文での再試行を決定する。
 * 変更ルール: HTTP通信・DOM操作・ゲーム状態更新を行わない。プロバイダー固有のHTTP分類はapp/main/providerClients.jsを正本とし、このモジュールは分類結果を再解釈しない。Retry-Afterが未指定またはnullの場合は既定待機時間を使用し、即時再送しない。
 */

(function exposeApiRetryPolicy(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiWerewolfApiRetryPolicy = Object.freeze(api);
}(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  const ERROR_LABELS = Object.freeze({
    API_KEY_MISSING: 'APIキーが未設定です。',
    AUTHENTICATION_FAILED: '認証に失敗しました。',
    PERMISSION_DENIED: 'APIの利用権限がありません。',
    ENDPOINT_OR_MODEL_NOT_FOUND: 'APIエンドポイントまたはモデルが見つかりません。',
    INVALID_REQUEST: 'API要求の形式が不正です。',
    CONFIGURATION_ERROR: 'AIプロファイル設定が不正です。',
    PROFILE_BUDGET_EXCEEDED: 'プロファイル利用上限によりAPI送信を停止しました。',
    RATE_LIMITED: 'APIのレート制限に達しました。',
    PROVIDER_UNAVAILABLE: 'API事業者が一時的に利用できません。',
    NETWORK_UNAVAILABLE: 'APIへ接続できません。',
    REQUEST_TIMEOUT: 'API要求がタイムアウトしました。',
    DELIVERY_UNKNOWN: 'API側で処理済みか確認できません。',
    CANCELLED: 'API要求を中止しました。',
    INVALID_PROVIDER_RESPONSE: 'APIが不正な応答を返しました。',
    EMPTY_PROVIDER_RESPONSE: 'APIが空の応答を返しました。',
  });

  function normalizedRetryDelay(value) {
    if (value === null || value === undefined) return 750;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 750;
    return Math.min(30000, Math.max(0, Math.trunc(parsed)));
  }

  function decideApiRetry({ error, action = 'retry', retryIndex = 0 } = {}) {
    if (retryIndex >= 1) return { type: 'stop', delayMs: 0, reason: 'retry-limit' };
    if (action === 'stop') return { type: 'stop', delayMs: 0, reason: 'user-policy' };
    if (error?.deliveryUnknown) return { type: 'stop', delayMs: 0, reason: 'delivery-unknown' };
    if (error?.retryable !== true) return { type: 'stop', delayMs: 0, reason: 'not-retryable' };
    return {
      type: action === 'full-history-retry' ? 'full-history-retry' : 'retry',
      delayMs: normalizedRetryDelay(error?.retryAfterMs),
      reason: 'retryable',
    };
  }

  function apiErrorMessage(error) {
    const label = ERROR_LABELS[error?.code] ?? 'API要求に失敗しました。';
    const detail = String(error?.message ?? '').trim();
    return detail && detail !== label ? `${label} ${detail}` : label;
  }

  function retryStatusMessage(playerName, decision) {
    const wait = decision.delayMs > 0 ? `${(decision.delayMs / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}秒後に` : '';
    if (decision.type === 'full-history-retry') return `${playerName}の最新状態を再取得し、公開履歴全文で${wait}1回だけ再試行します。`;
    return `${playerName}のAPI要求を${wait}同じ内容で1回だけ再試行します。`;
  }

  return {
    apiErrorMessage,
    decideApiRetry,
    normalizedRetryDelay,
    retryStatusMessage,
  };
}));
