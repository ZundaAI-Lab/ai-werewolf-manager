/**
 * 責務: Mainプロセス内のLLM通信機能を、変更前と同一の公開APIだけに限定して再公開する。
 * 変更ルール: 実装を追加せず、内部補助関数を公開しない。公開項目を変更する場合は利用箇所と契約テストを同時に更新する。
 */

'use strict';

const constants = require('./llm/providerConstants.js');
const profilePolicy = require('./llm/providerProfilePolicy.js');
const responseParser = require('./llm/providerResponseParser.js');
const httpClient = require('./llm/providerHttpClient.js');
const promptBudget = require('./llm/promptBudget.js');
const ollamaProvider = require('./llm/providers/ollamaProvider.js');
const router = require('./llm/providerClientRouter.js');

module.exports = {
  CHAT_TOKEN_LIMIT_FIELDS: constants.CHAT_TOKEN_LIMIT_FIELDS,
  CUSTOM_ENDPOINT_PROVIDERS: constants.CUSTOM_ENDPOINT_PROVIDERS,
  JSON_REQUEST_MODES: constants.JSON_REQUEST_MODES,
  JSON_RESPONSE_MODES: constants.JSON_RESPONSE_MODES,
  LOCAL_OPENAI_PROVIDER: constants.LOCAL_OPENAI_PROVIDER,
  LOCAL_PROVIDERS: constants.LOCAL_PROVIDERS,
  MAX_PROVIDER_RESPONSE_BYTES: constants.MAX_PROVIDER_RESPONSE_BYTES,
  OLLAMA_NATIVE_THINKING_RESERVE_TOKENS: constants.OLLAMA_NATIVE_THINKING_RESERVE_TOKENS,
  OLLAMA_THINKING_CONTINUATION_LIMIT: constants.OLLAMA_THINKING_CONTINUATION_LIMIT,
  OFFICIAL_PROVIDERS: constants.OFFICIAL_PROVIDERS,
  PROVIDER_CAPABILITIES: constants.PROVIDER_CAPABILITIES,
  PROVIDER_DEFAULTS: constants.PROVIDER_DEFAULTS,
  ProviderRequestError: constants.ProviderRequestError,
  bearerAuthorizationHeaders: profilePolicy.bearerAuthorizationHeaders,
  boundedInteger: profilePolicy.boundedInteger,
  defaultContextWindowTokens: profilePolicy.defaultContextWindowTokens,
  defaultProfile: profilePolicy.defaultProfile,
  estimateTextTokens: promptBudget.estimateTextTokens,
  extractFirstJsonObject: responseParser.extractFirstJsonObject,
  generateWithProvider: router.generateWithProvider,
  httpErrorClassification: httpClient.httpErrorClassification,
  isLocalProvider: profilePolicy.isLocalProvider,
  isOllamaProfile: ollamaProvider.isOllamaProfile,
  isLoopbackHost: profilePolicy.isLoopbackHost,
  normalizeChatTokenLimitField: profilePolicy.normalizeChatTokenLimitField,
  normalizeContextWindowTokens: profilePolicy.normalizeContextWindowTokens,
  normalizeEndpoint: profilePolicy.normalizeEndpoint,
  normalizeJsonRequestMode: profilePolicy.normalizeJsonRequestMode,
  normalizeJsonResponseMode: profilePolicy.normalizeJsonResponseMode,
  normalizeThinkingLevel: profilePolicy.normalizeThinkingLevel,
  normalizeAnthropicCacheTtl: profilePolicy.normalizeAnthropicCacheTtl,
  normalizePromptCacheMode: profilePolicy.normalizePromptCacheMode,
  normalizeMaxOutputTokens: profilePolicy.normalizeMaxOutputTokens,
  normalizeModel: profilePolicy.normalizeModel,
  ollamaGenerationBudgetTokens: ollamaProvider.ollamaGenerationBudgetTokens,
  ollamaNativeChatEndpoint: ollamaProvider.ollamaNativeChatEndpoint,
  ollamaNumPredictForMessages: ollamaProvider.ollamaNumPredictForMessages,
  ollamaThinkValue: ollamaProvider.ollamaThinkValue,
  ollamaThinkingReserveTokens: ollamaProvider.ollamaThinkingReserveTokens,
  parseRetryAfter: httpClient.parseRetryAfter,
  readProviderResponseText: httpClient.readProviderResponseText,
  requestJson: httpClient.requestJson,
  requiresApiKey: profilePolicy.requiresApiKey,
  stripCodeFence: responseParser.stripCodeFence,
  systemInstructionForRequest: profilePolicy.systemInstructionForRequest,
};
