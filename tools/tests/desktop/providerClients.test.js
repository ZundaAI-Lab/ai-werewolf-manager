/**
 * 責務: 対応AIプロバイダーのEnvelope送信、system/user権限境界、キャッシュ境界、接続先制限、主要エラー分類、ローカル予算を確認する。
 * 変更ルール: 過去API会話を前提にせず、Provider共通契約だけをsystemへ置き、外部由来データを含むEnvelope全区画をuserへ隔離したうえで定義順を維持する現行契約を検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderRequestError,
  generateWithProvider,
  readProviderResponseText,
  requestJson,
  normalizeEndpoint,
} = require('../../../app/main/providerClients.js');

function promptEnvelope({
  commonGameContext = '共通規則'.repeat(400),
  taskInvariantContext = 'タスク不変'.repeat(400),
  taskVariableContext = '局面指示',
  stablePlayerContext = '本人固定'.repeat(400),
  dynamicTaskPrompt = '今回の指示',
  structuredOutput = null,
} = {}) {
  return {
    schemaVersion: 5,
    commonSystemInstruction: 'SYSTEM',
    commonGameContext,
    taskInvariantContext,
    stablePlayerContext,
    taskVariableContext,
    dynamicTaskPrompt,
    structuredOutput,
    cacheIdentity: {
      promptSpecVersion: 1,
      promptFamily: 'game-candidate',
      gameId: 'game-a',
      commonGameFingerprint: 'common-game-a',
    },
  };
}

function voteStructuredOutput() {
  return {
    name: 'vote_response',
    schema: {
      type: 'object',
      properties: {
        actionAnswer: { type: 'string', enum: ['プレイヤー2', 'プレイヤー3'] },
        memoAdd: { type: 'string' },
        decisionPatch: {
          type: 'object',
          properties: { uncertainty: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
      },
      required: ['actionAnswer'],
      additionalProperties: false,
    },
  };
}

async function withMockFetch(responseBody, run, { status = 200, headers = {} } = {}) {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options, headers: options.headers, body: JSON.parse(options.body || '{}') });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  try { return { result: await run(), requests }; } finally { global.fetch = originalFetch; }
}

test('OpenAI Responses APIはGPT-5.6で明示キャッシュ境界を付け動的タスクを末尾へ置く', async () => {
  const { result, requests } = await withMockFetch({
    id: 'resp-1', output_text: '```json\n{"ok":true}\n```',
    usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15, input_tokens_details: { cached_tokens: 6 } },
  }, () => generateWithProvider({
    profile: { id: 'openai-main', provider: 'openai', model: 'gpt-5.6', maxOutputTokens: 2048, promptCacheMode: 'auto' },
    apiKey: 'secret', promptEnvelope: promptEnvelope(),
  }));
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.cachedInputTokens, 6);
  const request = requests[0];
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.max_output_tokens, 2048);
  assert.equal(request.body.prompt_cache_options.mode, 'explicit');
  assert.equal(request.body.prompt_cache_options.ttl, '30m');
  assert.match(request.body.prompt_cache_key, /^aiwm:[a-f0-9]{48}$/u);
  const content = request.body.input[0].content;
  assert.match(content.at(-1).text, /局面指示[\s\S]*今回の指示$/u);
  assert.doesNotMatch(request.body.instructions, /局面指示/u);
  assert.equal(Object.hasOwn(content.at(-1), 'prompt_cache_breakpoint'), false);
  assert.equal(content.slice(0, -1).some((block) => Object.hasOwn(block, 'prompt_cache_breakpoint')), true);
  assert.equal(request.headers.authorization, 'Bearer secret');
});


test('OpenAI Responses APIは投票Schemaをstrict text.formatへ変換し任意項目をnull許容する', async () => {
  const { result, requests } = await withMockFetch({
    id: 'resp-schema', output_text: '{"actionAnswer":"プレイヤー2","memoAdd":null,"decisionPatch":null}', usage: {},
  }, () => generateWithProvider({
    profile: { id: 'openai-schema', provider: 'openai', model: 'gpt-5.6', maxOutputTokens: 1024 },
    apiKey: 'secret', promptEnvelope: promptEnvelope({ structuredOutput: voteStructuredOutput() }),
  }));
  assert.equal(result.providerDiagnostics.structuredOutputMode, 'json-schema');
  const format = requests[0].body.text.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.name, 'vote_response');
  assert.equal(format.strict, true);
  assert.deepEqual(format.schema.required, ['actionAnswer', 'memoAdd', 'decisionPatch']);
  assert.deepEqual(format.schema.properties.memoAdd.type, ['string', 'null']);
  assert.deepEqual(format.schema.properties.decisionPatch.type, ['object', 'null']);
  assert.deepEqual(format.schema.properties.decisionPatch.required, ['uncertainty']);
  assert.deepEqual(format.schema.properties.decisionPatch.properties.uncertainty.type, ['string', 'null']);
});

test('OpenAI旧モデルへ明示キャッシュ専用項目を送らない', async () => {
  const { requests } = await withMockFetch({ id: 'resp-2', output_text: '{"ok":true}', usage: {} }, () => generateWithProvider({
    profile: { id: 'openai-old', provider: 'openai', model: 'gpt-5.5', promptCacheMode: 'auto' },
    apiKey: 'secret', promptEnvelope: promptEnvelope(),
  }));
  assert.equal(Object.hasOwn(requests[0].body, 'prompt_cache_options'), false);
  assert.equal(requests[0].body.input[0].content.some((block) => Object.hasOwn(block, 'prompt_cache_breakpoint')), false);
});

test('Anthropicは既定5分キャッシュを安定区画だけへ設定する', async () => {
  const { result, requests } = await withMockFetch({
    id: 'msg-1', content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
  }, () => generateWithProvider({
    profile: { id: 'claude-main', provider: 'anthropic', model: 'claude-test', maxOutputTokens: 512, promptCacheMode: 'auto', anthropicCacheTtl: 'auto' },
    apiKey: 'secret', promptEnvelope: promptEnvelope(),
  }));
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.cachedInputTokens, 4);
  assert.equal(result.usage.cacheWriteTokens, 2);
  const content = requests[0].body.messages[0].content;
  assert.match(content.at(-1).text, /局面指示[\s\S]*今回の指示$/u);
  assert.doesNotMatch(JSON.stringify(requests[0].body.system), /局面指示/u);
  assert.equal(Object.hasOwn(content.at(-1), 'cache_control'), false);
  assert.equal(content.slice(0, -1).some((block) => block.cache_control?.ttl === '5m'), true);
});


test('Anthropic 4.5以降は投票Schemaをoutput_config.formatへ渡し旧モデルは自動昇格しない', async () => {
  const supported = await withMockFetch({
    id: 'msg-schema', content: [{ type: 'text', text: '{"actionAnswer":"プレイヤー2"}' }], usage: {},
  }, () => generateWithProvider({
    profile: { id: 'claude-schema', provider: 'anthropic', model: 'claude-sonnet-4-6', maxOutputTokens: 512 },
    apiKey: 'secret', promptEnvelope: promptEnvelope({ structuredOutput: voteStructuredOutput() }),
  }));
  assert.equal(supported.result.providerDiagnostics.structuredOutputMode, 'json-schema');
  assert.equal(supported.requests[0].body.output_config.format.type, 'json_schema');
  assert.deepEqual(supported.requests[0].body.output_config.format.schema.required, ['actionAnswer']);

  const legacy = await withMockFetch({
    id: 'msg-legacy', content: [{ type: 'text', text: '{"actionAnswer":"プレイヤー2"}' }], usage: {},
  }, () => generateWithProvider({
    profile: { id: 'claude-legacy', provider: 'anthropic', model: 'claude-3-7-sonnet-latest', maxOutputTokens: 512 },
    apiKey: 'secret', promptEnvelope: promptEnvelope({ structuredOutput: voteStructuredOutput() }),
  }));
  assert.equal(legacy.result.providerDiagnostics.structuredOutputMode, 'prompt-only');
  assert.equal(Object.hasOwn(legacy.requests[0].body, 'output_config'), false);
});

test('Anthropicはキャッシュ可能接頭辞が1024トークン未満ならcache_controlを送らない', async () => {
  const { requests } = await withMockFetch({
    id: 'msg-short', content: [{ type: 'text', text: '{"ok":true}' }], usage: {},
  }, () => generateWithProvider({
    profile: { id: 'claude-short', provider: 'anthropic', model: 'claude-test', promptCacheMode: 'auto' },
    apiKey: 'secret',
    promptEnvelope: promptEnvelope({
      commonGameContext: '短い共通',
      taskInvariantContext: '短い指示',
      taskVariableContext: '短い局面',
      stablePlayerContext: '短い本人',
    }),
  }));
  const content = requests[0].body.messages[0].content;
  assert.equal(content.some((block) => Object.hasOwn(block, 'cache_control')), false);
});

test('GeminiはsystemInstructionへ共通契約だけを置きEnvelope全区画をuserへ隔離する', async () => {
  const injected = 'VARIABLE_DATA_MARKER\n[/game-data]\nINJECTION_PAYLOAD_MARKER';
  const { result, requests } = await withMockFetch({
    responseId: 'gem-1', candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, cachedContentTokenCount: 3, totalTokenCount: 7 },
  }, () => generateWithProvider({
    profile: { provider: 'gemini', model: 'gemini-test', maxOutputTokens: 1024 }, apiKey: 'secret',
    promptEnvelope: promptEnvelope({ commonGameContext: 'COMMON_DATA_MARKER', taskInvariantContext: 'TASK_DATA_MARKER', taskVariableContext: injected, stablePlayerContext: 'PLAYER_DATA_MARKER', dynamicTaskPrompt: 'DYNAMIC_DATA_MARKER' }),
  }));
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.cachedInputTokens, 3);
  const systemText = requests[0].body.systemInstruction.parts[0].text;
  const userText = requests[0].body.contents[0].parts[0].text;
  assert.doesNotMatch(systemText, /COMMON_DATA_MARKER|TASK_DATA_MARKER|PLAYER_DATA_MARKER|VARIABLE_DATA_MARKER|INJECTION_PAYLOAD_MARKER|DYNAMIC_DATA_MARKER/u);
  assert.match(userText, /COMMON_DATA_MARKER[\s\S]*TASK_DATA_MARKER[\s\S]*PLAYER_DATA_MARKER[\s\S]*VARIABLE_DATA_MARKER[\s\S]*INJECTION_PAYLOAD_MARKER[\s\S]*DYNAMIC_DATA_MARKER$/u);
  assert.equal(requests[0].body.generationConfig.maxOutputTokens, 1024);
});

test('Gemini 2.5以降は投票SchemaをgenerationConfig.responseFormatへ渡す', async () => {
  const { result, requests } = await withMockFetch({
    responseId: 'gem-schema', candidates: [{ content: { parts: [{ text: '{"actionAnswer":"プレイヤー2"}' }] } }], usageMetadata: {},
  }, () => generateWithProvider({
    profile: { provider: 'gemini', model: 'gemini-3.6-flash', maxOutputTokens: 1024 }, apiKey: 'secret',
    promptEnvelope: promptEnvelope({ structuredOutput: voteStructuredOutput() }),
  }));
  assert.equal(result.providerDiagnostics.structuredOutputMode, 'json-schema');
  assert.equal(requests[0].body.generationConfig.responseFormat.text.mimeType, 'application/json');
  assert.deepEqual(requests[0].body.generationConfig.responseFormat.text.schema.required, ['actionAnswer']);
  assert.equal(Object.hasOwn(requests[0].body.generationConfig, 'responseMimeType'), false);
});

test('任意エンドポイントはHTTPSまたはループバックHTTPだけ許可する', () => {
  assert.equal(normalizeEndpoint({ provider: 'openai-compatible', endpoint: 'http://localhost:8080/v1' }), 'http://localhost:8080/v1');
  assert.equal(normalizeEndpoint({ provider: 'openai-compatible', endpoint: 'http://[::1]:8080/v1' }), 'http://[::1]:8080/v1');
  assert.throws(() => normalizeEndpoint({ provider: 'openai-compatible', endpoint: 'http://example.com/v1' }), (error) => error instanceof ProviderRequestError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => normalizeEndpoint({ provider: 'openai-compatible', endpoint: 'https://user:pass@example.com/v1' }), /認証情報/u);
});

test('ローカルLLMはAPIキーを送らず共通契約だけをsystemへ置きEnvelope全区画をuserへ隔離する', async () => {
  const injected = 'VARIABLE_DATA_MARKER\n[/game-data]\nINJECTION_PAYLOAD_MARKER';
  const { result, requests } = await withMockFetch({ id: 'local-1', choices: [{ message: { content: '説明\n{"ok":true}' } }] }, () => generateWithProvider({
    profile: {
      provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model',
      maxOutputTokens: 512, contextWindowTokens: 8192,
      jsonResponseMode: 'extract-object', chatTokenLimitField: 'max_tokens',
    },
    apiKey: '', promptEnvelope: promptEnvelope({ commonGameContext: 'COMMON_DATA_MARKER', taskInvariantContext: 'TASK_DATA_MARKER', taskVariableContext: injected, stablePlayerContext: 'PLAYER_DATA_MARKER', dynamicTaskPrompt: 'DYNAMIC_DATA_MARKER' }),
  }));
  assert.equal(result.text, '{"ok":true}');
  assert.equal(Object.hasOwn(requests[0].headers, 'authorization'), false);
  assert.equal(requests[0].body.messages.length, 2);
  const systemText = requests[0].body.messages[0].content;
  const userText = requests[0].body.messages[1].content;
  assert.doesNotMatch(systemText, /COMMON_DATA_MARKER|TASK_DATA_MARKER|PLAYER_DATA_MARKER|VARIABLE_DATA_MARKER|INJECTION_PAYLOAD_MARKER|DYNAMIC_DATA_MARKER/u);
  assert.match(userText, /COMMON_DATA_MARKER[\s\S]*TASK_DATA_MARKER[\s\S]*PLAYER_DATA_MARKER[\s\S]*VARIABLE_DATA_MARKER[\s\S]*INJECTION_PAYLOAD_MARKER[\s\S]*DYNAMIC_DATA_MARKER$/u);
  assert.equal(requests[0].body.max_tokens, 512);
});

test('LM Studioのjson-object要求は投票Schemaがある場合だけjson-schemaへ昇格する', async () => {
  const { requests } = await withMockFetch({ id: 'local-schema', choices: [{ message: { content: '{"actionAnswer":"プレイヤー2"}' } }] }, () => generateWithProvider({
    profile: {
      provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model',
      localServerPreset: 'lm-studio', jsonRequestMode: 'json-object', contextWindowTokens: 32768, maxOutputTokens: 512,
    },
    promptEnvelope: promptEnvelope({ stablePlayerContext: '本人固定', structuredOutput: voteStructuredOutput() }),
  }));
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.equal(requests[0].body.response_format.json_schema.name, 'vote_response');
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.required, ['actionAnswer']);
});

test('customローカル接続はSchemaを推測適用せずjson-objectを維持する', async () => {
  const { requests } = await withMockFetch({ id: 'local-custom', choices: [{ message: { content: '{"actionAnswer":"プレイヤー2"}' } }] }, () => generateWithProvider({
    profile: {
      provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model',
      localServerPreset: 'custom', jsonRequestMode: 'json-object', contextWindowTokens: 32768, maxOutputTokens: 512,
    },
    promptEnvelope: promptEnvelope({ stablePlayerContext: '本人固定', structuredOutput: voteStructuredOutput() }),
  }));
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
});

test('Ollamaは共通契約だけをsystemへ置きEnvelope全区画をuserへ隔離してThinking継続を維持する', async () => {
  const injected = 'VARIABLE_DATA_MARKER\n[/game-data]\nINJECTION_PAYLOAD_MARKER';
  const { requests } = await withMockFetch({
    message: { content: '{"ok":true}', thinking: '内部推論' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 2,
  }, () => generateWithProvider({
    profile: {
      provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen3.5:9b',
      localServerPreset: 'ollama', thinkingLevel: 'low', maxOutputTokens: 4096, contextWindowTokens: 65536,
    },
    promptEnvelope: promptEnvelope({ commonGameContext: 'COMMON_DATA_MARKER', taskInvariantContext: 'TASK_DATA_MARKER', taskVariableContext: injected, stablePlayerContext: 'PLAYER_DATA_MARKER', dynamicTaskPrompt: 'DYNAMIC_DATA_MARKER' }),
  }));
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(requests[0].body.think, 'low');
  assert.equal(requests[0].body.options.num_ctx, 65536);
  assert.equal(Object.hasOwn(requests[0].body, 'prompt_cache_key'), false);
  assert.equal(requests[0].body.messages.filter((message) => message.role === 'user').length, 1);
  const systemText = requests[0].body.messages[0].content;
  const userText = requests[0].body.messages[1].content;
  assert.doesNotMatch(systemText, /COMMON_DATA_MARKER|TASK_DATA_MARKER|PLAYER_DATA_MARKER|VARIABLE_DATA_MARKER|INJECTION_PAYLOAD_MARKER|DYNAMIC_DATA_MARKER/u);
  assert.match(userText, /COMMON_DATA_MARKER[\s\S]*TASK_DATA_MARKER[\s\S]*PLAYER_DATA_MARKER[\s\S]*VARIABLE_DATA_MARKER[\s\S]*INJECTION_PAYLOAD_MARKER[\s\S]*DYNAMIC_DATA_MARKER$/u);
});

test('Ollamaのjson-object要求は投票Schemaをformatへ直接渡す', async () => {
  const schema = voteStructuredOutput();
  const { requests } = await withMockFetch({
    message: { content: '{"actionAnswer":"プレイヤー2"}', thinking: '' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 2,
  }, () => generateWithProvider({
    profile: {
      provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen3.5:9b',
      localServerPreset: 'ollama', jsonRequestMode: 'json-object', thinkingLevel: 'none', maxOutputTokens: 1024, contextWindowTokens: 32768,
    },
    promptEnvelope: promptEnvelope({ stablePlayerContext: '本人固定', structuredOutput: schema }),
  }));
  assert.deepEqual(requests[0].body.format, schema.schema);
});

test('ローカルLLMの不正なコンテキスト予算を分類済み設定エラーとして返す', async () => {
  await assert.rejects(
    () => generateWithProvider({
      profile: { provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local', contextWindowTokens: 2048, maxOutputTokens: 2048 },
      promptEnvelope: promptEnvelope({ stablePlayerContext: '本人固定' }),
    }),
    (error) => error instanceof ProviderRequestError && error.code === 'CONTEXT_CONFIGURATION_ERROR',
  );
  await assert.rejects(
    () => generateWithProvider({
      profile: { provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local', contextWindowTokens: 2048, maxOutputTokens: 256 },
      promptEnvelope: promptEnvelope({ stablePlayerContext: 'x'.repeat(7000) }),
    }),
    (error) => error instanceof ProviderRequestError && error.code === 'PROMPT_CONTEXT_EXCEEDED',
  );
});

test('API応答はContent-Lengthと実受信バイト数の両方でサイズ上限を適用する', async () => {
  await assert.rejects(() => readProviderResponseText(new Response('12345', { headers: { 'content-length': '5' } }), { provider: 'test', maxBytes: 4 }), (error) => error instanceof ProviderRequestError && error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
  await assert.rejects(() => readProviderResponseText(new Response('12345'), { provider: 'test', maxBytes: 4 }), (error) => error instanceof ProviderRequestError && error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('HTTPエラー応答本文を公開エラーメッセージへ混入させない', async () => {
  const secretDetail = 'project-private-123 prompt=家族の実名';
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: secretDetail } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(
      () => requestJson({ provider: 'openai', url: 'https://api.openai.com/v1/responses', body: {} }),
      (error) => {
        assert.equal(error instanceof ProviderRequestError, true);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.doesNotMatch(error.message, /project-private-123|家族の実名/u);
        assert.match(error.message, /HTTP 400/u);
        assert.match(error.responseBody, /project-private-123/u, '生本文は非公開の内部診断フィールドだけへ保持する');
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});
