/**
 * 責務: AIプロファイルの接続診断で、任意のモデル一覧取得と必須の構造化JSON生成を独立した要求として実行する。
 * 変更ルール: モデル一覧取得の失敗・タイムアウトは警告へ留め、生成検査を中断しない。各外部要求は必ず別のAbortControllerとタイムアウトを使用し、生成要求は通常生成と同じpromptEnvelope契約でMainのProvider Routerへ渡す。
 */

'use strict';

const { generateWithProvider, isLocalProvider, ProviderRequestError } = require('./providerClients.js');
const { listLocalModels } = require('./localLlmClient.js');

function boundedTimeout(profile, maximumMs) {
  const configured = Number(profile?.timeoutMs);
  if (!Number.isFinite(configured) || configured <= 0) return maximumMs;
  return Math.min(configured, maximumMs);
}

async function runTimedRequest(operation, timeoutMs, provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ProviderRequestError('要求がタイムアウトしました。', {
    provider,
    code: 'REQUEST_TIMEOUT',
    retryable: true,
  })), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function parseStructuredObject(text, provider) {
  try {
    const structured = JSON.parse(text);
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) throw new TypeError('JSON object required');
    return structured;
  } catch {
    throw new ProviderRequestError('接続には成功しましたが、ゲーム進行に必要な単一JSONオブジェクトを生成できませんでした。JSON補正を有効にするか、命令追従性の高いモデルへ変更してください。', {
      provider,
      code: 'STRUCTURED_OUTPUT_UNSUPPORTED',
    });
  }
}

function connectionTestPromptEnvelope() {
  return {
    schemaVersion: 5,
    commonSystemInstruction: 'AI接続診断です。指定された構造化出力だけを返してください。',
    commonGameContext: '',
    taskInvariantContext: '',
    taskVariableContext: '',
    stablePlayerContext: '',
    dynamicTaskPrompt: '接続確認用です。ok=true、message="接続確認" の単一JSONオブジェクトを返してください。前後文は禁止です。',
    structuredOutput: {
      name: 'connection_test_response',
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          message: { type: 'string', enum: ['接続確認'] },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
    },
    cacheIdentity: {
      promptSpecVersion: 0,
      promptFamily: 'connection-test',
      gameId: '',
      commonGameFingerprint: 'connection-test-v1',
    },
  };
}

async function testProfileConnection({
  profile,
  apiKey = '',
  serializeError,
  discoverModels = listLocalModels,
  generate = generateWithProvider,
} = {}) {
  if (!profile || typeof profile !== 'object') throw new TypeError('profile is required');
  if (typeof serializeError !== 'function') throw new TypeError('serializeError is required');
  if (profile.provider === 'demo') {
    return {
      ok: true,
      text: '{"ok":true}',
      profile: { label: profile.label, provider: profile.provider, model: profile.model },
    };
  }

  let modelDiscovery = null;
  let modelDiscoveryWarning = null;
  if (isLocalProvider(profile)) {
    try {
      modelDiscovery = await runTimedRequest(
        (signal) => discoverModels({ profile, apiKey, signal }),
        boundedTimeout(profile, 30000),
        profile.provider,
      );
    } catch (error) {
      modelDiscoveryWarning = serializeError(error, profile.provider);
    }
  }

  const promptEnvelope = connectionTestPromptEnvelope();
  const result = await runTimedRequest(
    (signal) => generate({
      profile,
      apiKey,
      promptEnvelope,
      taskType: 'connection-test',
      playerName: '接続確認',
      signal,
    }),
    boundedTimeout(profile, 60000),
    profile.provider,
  );
  let structured = null;
  try {
    structured = parseStructuredObject(result.text, profile.provider);
  } catch (error) {
    error.usage = result.usage;
    throw error;
  }
  const models = modelDiscovery?.models ?? [];

  return {
    ok: true,
    text: result.text,
    usage: result.usage,
    profile: { label: profile.label, provider: profile.provider, model: profile.model },
    diagnostics: {
      structuredJson: Boolean(structured && typeof structured === 'object'),
      jsonObjectExtracted: result.normalization?.jsonObjectExtracted === true,
      authMode: apiKey ? 'bearer' : 'none',
      modelCount: models.length,
      modelListed: models.length ? models.includes(profile.model) : null,
      modelsEndpoint: modelDiscovery?.modelsEndpoint ?? null,
      modelDiscoveryWarning,
    },
  };
}

module.exports = {
  connectionTestPromptEnvelope,
  boundedTimeout,
  parseStructuredObject,
  runTimedRequest,
  testProfileConnection,
};
