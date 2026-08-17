/**
 * 責務: LLM向けHTTP通信、応答サイズ制限、HTTP・ネットワークエラー分類を共通実装する。
 * 変更ルール: プロバイダー固有リクエスト本文を組み立てず、秘密情報や応答本文を例外外へ漏らさない。
 */

'use strict';

const {
  MAX_PROVIDER_RESPONSE_BYTES, PRE_SEND_NETWORK_CODES, ProviderRequestError,
} = require('./providerConstants.js');

function parseRetryAfter(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30000, Math.round(seconds * 1000));
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(30000, Math.max(0, timestamp - now));
}

function httpErrorClassification(status) {
  if (status === 400) return { code: 'INVALID_REQUEST', retryable: false };
  if (status === 401) return { code: 'AUTHENTICATION_FAILED', retryable: false };
  if (status === 403) return { code: 'PERMISSION_DENIED', retryable: false };
  if (status === 404) return { code: 'ENDPOINT_OR_MODEL_NOT_FOUND', retryable: false };
  if (status === 408) return { code: 'REQUEST_TIMEOUT', retryable: true };
  if (status === 409) return { code: 'CONFLICT', retryable: true };
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'PROVIDER_UNAVAILABLE', retryable: true };
  return { code: 'HTTP_ERROR', retryable: false };
}


function publicHttpErrorMessage(provider, status, code) {
  const prefix = `${provider} API`;
  if (code === 'INVALID_REQUEST') return `${prefix}が要求内容を受理できませんでした（HTTP ${status}）。設定・モデル・要求上限を確認してください。`;
  if (code === 'AUTHENTICATION_FAILED') return `${prefix}の認証に失敗しました（HTTP ${status}）。APIキーを確認してください。`;
  if (code === 'PERMISSION_DENIED') return `${prefix}へのアクセスが拒否されました（HTTP ${status}）。APIキーの権限やプロジェクト設定を確認してください。`;
  if (code === 'ENDPOINT_OR_MODEL_NOT_FOUND') return `${prefix}のエンドポイントまたはモデルが見つかりません（HTTP ${status}）。`;
  if (code === 'REQUEST_TIMEOUT') return `${prefix}が要求を期限内に処理できませんでした（HTTP ${status}）。`;
  if (code === 'CONFLICT') return `${prefix}で要求の競合が発生しました（HTTP ${status}）。`;
  if (code === 'RATE_LIMITED') return `${prefix}の利用制限に達しました（HTTP ${status}）。時間を置いて再試行してください。`;
  if (code === 'PROVIDER_UNAVAILABLE') return `${prefix}が一時的に利用できません（HTTP ${status}）。時間を置いて再試行してください。`;
  return `${prefix}がエラーを返しました（HTTP ${status}）。`;
}

function networkFailure(error, provider, signal) {
  const abortCode = signal?.reason?.code;
  if (abortCode === 'CANCELLED') {
    return new ProviderRequestError(`${provider}への要求を中止しました。`, { provider, code: 'CANCELLED' });
  }
  if (abortCode === 'REQUEST_TIMEOUT' || error?.name === 'TimeoutError') {
    return new ProviderRequestError(`${provider}への要求がタイムアウトしました。`, {
      provider,
      code: 'REQUEST_TIMEOUT',
      retryable: true,
    });
  }
  const causeCode = error?.cause?.code ?? error?.code ?? '';
  if (PRE_SEND_NETWORK_CODES.has(causeCode)) {
    return new ProviderRequestError(`${provider}へ接続できません: ${error.message}`, {
      provider,
      code: 'NETWORK_UNAVAILABLE',
      retryable: true,
    });
  }
  return new ProviderRequestError(`${provider}への送信結果を確認できません: ${error.message}`, {
    provider,
    code: 'DELIVERY_UNKNOWN',
    retryable: false,
    deliveryUnknown: true,
  });
}

function providerResponseTooLarge(provider, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  return new ProviderRequestError(`${provider} API応答がサイズ上限（${maxBytes} bytes）を超えました。`, {
    provider,
    code: 'PROVIDER_RESPONSE_TOO_LARGE',
    retryable: false,
  });
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // サイズ超過時は本文破棄を優先し、cancel失敗で元の構造化エラーを上書きしない。
  }
}

async function readProviderResponseText(response, {
  provider,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
} = {}) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw providerResponseTooLarge(provider, maxBytes);
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let receivedBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value?.byteLength ?? 0;
        if (receivedBytes > maxBytes) {
          await reader.cancel();
          throw providerResponseTooLarge(provider, maxBytes);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock?.();
    }
  }

  const responseText = await response.text();
  if (Buffer.byteLength(responseText, 'utf8') > maxBytes) throw providerResponseTooLarge(provider, maxBytes);
  return responseText;
}

async function requestJson({ provider, url, method = 'POST', headers = {}, body, signal }) {
  let response;
  const requestHeaders = { accept: 'application/json', ...headers };
  const options = {
    method,
    redirect: 'error',
    headers: body === undefined ? requestHeaders : { 'content-type': 'application/json', ...requestHeaders },
    signal,
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw networkFailure(error, provider, signal);
  }

  let responseText;
  try {
    responseText = await readProviderResponseText(response, { provider });
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(`${provider} API応答の受信結果を確認できません: ${error.message}`, {
      provider,
      code: 'DELIVERY_UNKNOWN',
      retryable: false,
      deliveryUnknown: true,
    });
  }

  let parsed = null;
  try {
    parsed = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const classification = httpErrorClassification(response.status);
    throw new ProviderRequestError(publicHttpErrorMessage(provider, response.status, classification.code), {
      provider,
      status: response.status,
      responseBody: responseText.slice(0, 2000),
      retryable: classification.retryable,
      code: classification.code,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
  if (!parsed) {
    throw new ProviderRequestError(`${provider} APIがJSON以外を返しました。`, {
      provider,
      code: 'INVALID_PROVIDER_RESPONSE',
      responseBody: responseText.slice(0, 2000),
    });
  }
  return parsed;
}


module.exports = {
  cancelResponseBody, httpErrorClassification, networkFailure, parseRetryAfter,
  providerResponseTooLarge, readProviderResponseText, requestJson,
};
