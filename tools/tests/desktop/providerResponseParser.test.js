/**
 * 責務: Provider本文のJSON抽出がMainスレッドを非線形走査で占有せず、単一の完結JSONだけを決定的に抽出することを検証する。
 * 変更ルール: ゲーム固有の回答キーを前提にせず、応答構造の正規化境界だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractFirstJsonObject,
  normalizeProviderText,
} = require('../../../app/main/llm/providerResponseParser.js');

test('Provider JSON抽出は単一の完結オブジェクトだけを抽出し複数候補や未閉鎖外側を誤採用しない', () => {
  assert.equal(extractFirstJsonObject('説明\n{"ok":true}\n以上'), '{"ok":true}');
  assert.equal(extractFirstJsonObject('{"draft":1}\n{"speech":"hello"}'), '');
  assert.equal(extractFirstJsonObject('{"speech":"a","meta":{}, truncated'), '');
});

test('extract-objectは完結thinkingを本文候補から除外し未閉鎖thinkingを最終回答として採用しない', () => {
  const profile = { provider: 'local-openai-compatible', jsonResponseMode: 'extract-object' };
  const completed = normalizeProviderText(profile, '<think>plan {"draft":1} done</think>\n{"speech":"hello"}');
  assert.equal(completed.text, '{"speech":"hello"}');
  assert.equal(completed.jsonObjectExtracted, true);

  const attributed = normalizeProviderText(profile, '<THINK id="reasoning">plan {"draft":1}</THINK>\n{"speech":"hello"}');
  assert.equal(attributed.text, '{"speech":"hello"}');
  assert.equal(attributed.jsonObjectExtracted, true);

  const truncatedThinking = '<think>plan {"draft":1}';
  const incomplete = normalizeProviderText(profile, truncatedThinking);
  assert.equal(incomplete.text, truncatedThinking);
  assert.equal(incomplete.jsonObjectExtracted, false);
});

test('extract-objectは大量の未閉鎖thinkingタグをMainで非線形走査せず有界時間で処理する', { timeout: 1000 }, () => {
  const profile = { provider: 'local-openai-compatible', jsonResponseMode: 'extract-object' };
  const degenerated = 'lorem ipsum <think> '.repeat(60_000);
  const result = normalizeProviderText(profile, degenerated);
  assert.equal(result.text, degenerated.trim());
  assert.equal(result.jsonObjectExtracted, false);
});

test('Provider JSON抽出は大量の未閉鎖波括弧と過剰ネストを有界時間で終了する', { timeout: 1000 }, () => {
  assert.equal(extractFirstJsonObject('{'.repeat(100_000)), '');
  const overNested = `{"value":${'['.repeat(256)}0${']'.repeat(256)}}`;
  assert.equal(extractFirstJsonObject(overNested), '');
});
