/**
 * 責務: MainとRendererが共有するエンドポイント受理条件を一つのPolicyで固定する。
 * 変更ルール: UI文言配置やHTTP送信を検証せず、URL・認証情報・loopback・HTTPSの共通境界だけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { validateEndpoint } = require('../../../app/shared/endpointPolicy.js');
const { normalizeEndpoint } = require('../../../app/main/llm/providerProfilePolicy.js');

test('共有Endpoint Policyはloopback HTTPを許可し外部HTTP・userinfo・fragmentを拒否する', () => {
  assert.deepEqual(validateEndpoint('http://127.0.0.1:11434/'), {
    ok: true,
    normalizedEndpoint: 'http://127.0.0.1:11434',
    message: '',
  });
  assert.equal(validateEndpoint('http://example.com/v1').ok, false);
  assert.equal(validateEndpoint('https://user:pass@example.com/v1').ok, false);
  assert.equal(validateEndpoint('https://example.com/v1#secret').ok, false);
  assert.equal(validateEndpoint('https://example.com/v1', { requireLoopback: true }).ok, false);
  assert.equal(validateEndpoint('http://[::1]:11434/', { requireLoopback: true }).ok, true);
});

test('MainのnormalizeEndpointは共有Policyを使用しRenderer側に独自URL判定を持たない', () => {
  assert.equal(normalizeEndpoint({ provider: 'local-openai-compatible', endpoint: 'http://localhost:11434/' }), 'http://localhost:11434');
  assert.throws(
    () => normalizeEndpoint({ provider: 'local-openai-compatible', endpoint: 'https://example.com/v1' }),
    /localhost・127\.0\.0\.1・::1/u,
  );
  const rendererSource = readFileSync(join(__dirname, '../../../app/renderer/js/automation/desktopAutomationManagementView.js'), 'utf8');
  assert.match(rendererSource, /endpointPolicy\.validateEndpoint/u);
  assert.doesNotMatch(rendererSource, /new URL\(/u);
});
