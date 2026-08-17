/**
 * 責務: AIプロファイル接続診断が通常生成と同じProvider Router契約を守ることを確認する。
 * 変更ルール: Provider単体の詳細は重複検証せず、接続診断が正式promptEnvelopeで実際のProvider Routerを通過できる境界だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionTestPromptEnvelope, testProfileConnection } = require('../../../app/main/profileConnectionTest.js');

test('接続診断は正式なpromptEnvelopeでOpenAI Provider Routerを通過しusageを返す', async () => {
  const originalFetch = global.fetch;
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: 'resp-connection',
      output_text: '{"ok":true,"message":"接続確認"}',
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await testProfileConnection({
      profile: {
        id: 'openai-luna',
        label: 'GPT-5.6 Luna',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        timeoutMs: 60000,
        maxOutputTokens: 2048,
      },
      apiKey: 'secret',
      serializeError: (error) => ({ message: error?.message ?? String(error) }),
    });

    assert.equal(result.ok, true);
    assert.equal(requestBody.model, 'gpt-5.6-luna');
    assert.equal(requestBody.text.format.type, 'json_schema');
    assert.equal(requestBody.text.format.name, 'connection_test_response');
    assert.equal(requestBody.text.format.strict, true);
    assert.match(requestBody.input[0].content.at(-1).text, /接続確認用/u);
    assert.equal(result.usage.totalTokens, 16);
    assert.equal(connectionTestPromptEnvelope().cacheIdentity.promptFamily, 'connection-test');
  } finally {
    global.fetch = originalFetch;
  }
});
