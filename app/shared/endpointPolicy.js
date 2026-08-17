/**
 * 責務: Electron Main・Rendererで共有する任意APIエンドポイントのURL・認証情報・フラグメント・ループバック・HTTPS制約を一元判定する。
 * 変更ルール: Provider既定値、HTTP送信、例外型、DOM表示を所有しない。接続先の受理条件と共通メッセージは本モジュールだけで変更する。
 */

(function exposeEndpointPolicy(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiWerewolfEndpointPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function trimTrailingSlash(value) {
    return String(value ?? '').trim().replace(/\/+$/u, '');
  }

  function isLoopbackHost(hostname) {
    const normalized = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/gu, '');
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  }

  function validateEndpoint(endpoint, { requireLoopback = false } = {}) {
    const configured = String(endpoint ?? '').trim();
    if (!configured) return Object.freeze({ ok: false, normalizedEndpoint: '', message: 'APIエンドポイントが未設定です。' });
    let url;
    try {
      url = new URL(configured);
    } catch {
      return Object.freeze({ ok: false, normalizedEndpoint: '', message: 'APIエンドポイントがURLではありません。' });
    }
    if (url.username || url.password) return Object.freeze({ ok: false, normalizedEndpoint: '', message: '認証情報を含むAPIエンドポイントは使用できません。' });
    if (url.hash) return Object.freeze({ ok: false, normalizedEndpoint: '', message: 'APIエンドポイントにフラグメントは指定できません。' });
    const loopback = isLoopbackHost(url.hostname);
    if (requireLoopback && !loopback) {
      return Object.freeze({ ok: false, normalizedEndpoint: '', message: 'ローカルLLMの接続先はlocalhost・127.0.0.1・::1だけ使用できます。' });
    }
    const loopbackHttp = url.protocol === 'http:' && loopback;
    if (url.protocol !== 'https:' && !loopbackHttp) {
      return Object.freeze({ ok: false, normalizedEndpoint: '', message: 'APIキーを送信する接続はHTTPSが必要です。HTTPはlocalhost・127.0.0.1・::1だけ使用できます。' });
    }
    return Object.freeze({ ok: true, normalizedEndpoint: trimTrailingSlash(url.toString()), message: '' });
  }

  return Object.freeze({ isLoopbackHost, trimTrailingSlash, validateEndpoint });
}));
