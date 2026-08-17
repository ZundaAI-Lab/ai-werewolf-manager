/**
 * 責務: ローカルOpenAI互換LLMのモデル一覧URL、認証任意、モデル応答形式の正規化を検証する。
 * 変更ルール: 外部ネットワークへ接続しない。通信統合テストはテスト内で起動した127.0.0.1の一時HTTPサーバーだけを使用する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  listLocalModels,
  modelIdsFromBody,
  modelsEndpointFromChatEndpoint,
} = require('../../../app/main/localLlmClient.js');
const { generateWithProvider } = require('../../../app/main/providerClients.js');

async function withMockFetch(body, run) {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return { result: await run(), requests };
  } finally {
    global.fetch = originalFetch;
  }
}

test('Chat Completions URLからOpenAI互換モデル一覧URLを生成する', () => {
  assert.equal(
    modelsEndpointFromChatEndpoint('http://127.0.0.1:1234/v1/chat/completions'),
    'http://127.0.0.1:1234/v1/models',
  );
  assert.equal(
    modelsEndpointFromChatEndpoint('http://127.0.0.1:11434/custom/v1/chat/completions?x=1'),
    'http://127.0.0.1:11434/custom/v1/models',
  );
});

test('認証なしローカルLLMからモデル一覧を取得する', async () => {
  const { result, requests } = await withMockFetch({
    data: [{ id: 'qwen-local' }, { id: 'llama-local' }, { id: 'qwen-local' }],
  }, () => listLocalModels({
    profile: {
      provider: 'local-openai-compatible',
      endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    },
    apiKey: '',
  }));
  assert.deepEqual(result.models, ['llama-local', 'qwen-local']);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(Object.hasOwn(requests[0].options.headers, 'authorization'), false);
});

test('各ローカルサーバーのモデル配列形式を共通IDへ正規化する', () => {
  assert.deepEqual(modelIdsFromBody({ models: [{ name: 'ollama-a' }, { model: 'ollama-b' }, 'ollama-c'] }), [
    'ollama-a',
    'ollama-b',
    'ollama-c',
  ]);
});


