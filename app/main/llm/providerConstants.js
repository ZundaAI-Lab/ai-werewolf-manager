/**
 * 責務: LLMプロバイダー共通の固定値、能力表、構造化エラー型を定義する。
 * 変更ルール: 通信・ゲーム処理を実装せず、API差異の静的契約だけを保持する。既定エンドポイント・既定モデルはshared/providerDefaults.jsを正本とし、ここへ複製しない。
 */

'use strict';

const { LOCAL_OPENAI_PROVIDER } = require('../../shared/localLlmConfig.js');
const { PROVIDER_DEFAULTS } = require('../../shared/providerDefaults.js');

const PROVIDER_CAPABILITIES = Object.freeze({
  openai: Object.freeze({ requestStyle: 'responses', outputTokenField: 'max_output_tokens' }),
  anthropic: Object.freeze({ requestStyle: 'anthropic-messages', outputTokenField: 'max_tokens' }),
  gemini: Object.freeze({ requestStyle: 'gemini-generate-content', outputTokenField: 'maxOutputTokens' }),
  xai: Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_tokens' }),
  deepseek: Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_tokens' }),
  qwen: Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_tokens' }),
  kimi: Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_tokens' }),
  glm: Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_tokens' }),
  'openai-compatible': Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_completion_tokens' }),
  [LOCAL_OPENAI_PROVIDER]: Object.freeze({ requestStyle: 'chat-completions', outputTokenField: 'max_tokens' }),
});

const CHAT_TOKEN_LIMIT_FIELDS = Object.freeze(['max_completion_tokens', 'max_tokens']);
const JSON_REQUEST_MODES = Object.freeze(['prompt-only', 'json-object']);
const JSON_RESPONSE_MODES = Object.freeze(['strict', 'extract-object']);
const LOCAL_PROVIDERS = new Set([LOCAL_OPENAI_PROVIDER]);
const CUSTOM_ENDPOINT_PROVIDERS = new Set(['openai-compatible', LOCAL_OPENAI_PROVIDER]);
const OFFICIAL_PROVIDERS = new Set(Object.keys(PROVIDER_DEFAULTS).filter((provider) => !['demo', ...CUSTOM_ENDPOINT_PROVIDERS].includes(provider)));
const PRE_SEND_NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const OLLAMA_NATIVE_THINKING_RESERVE_TOKENS = Object.freeze({
  none: 0,
  low: 4096,
  medium: 8192,
  high: 16384,
  max: 32768,
});
const OLLAMA_THINKING_CONTINUATION_LIMIT = 2;
const OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS = 256;

class ProviderRequestError extends Error {
  constructor(message, {
    provider,
    code = 'UNKNOWN',
    status = null,
    responseBody = '',
    retryable = false,
    deliveryUnknown = false,
    retryAfterMs = null,
  } = {}) {
    super(message);
    this.name = 'ProviderRequestError';
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.responseBody = responseBody;
    this.retryable = retryable;
    this.deliveryUnknown = deliveryUnknown;
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = {
  CHAT_TOKEN_LIMIT_FIELDS, CUSTOM_ENDPOINT_PROVIDERS, JSON_REQUEST_MODES, JSON_RESPONSE_MODES,
  LOCAL_OPENAI_PROVIDER, LOCAL_PROVIDERS, MAX_PROVIDER_RESPONSE_BYTES,
  OLLAMA_NATIVE_FIXED_OVERHEAD_TOKENS, OLLAMA_NATIVE_THINKING_RESERVE_TOKENS,
  OLLAMA_THINKING_CONTINUATION_LIMIT, OFFICIAL_PROVIDERS, PRE_SEND_NETWORK_CODES,
  PROVIDER_CAPABILITIES, PROVIDER_DEFAULTS, ProviderRequestError,
};
