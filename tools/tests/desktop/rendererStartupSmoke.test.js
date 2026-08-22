/**
 * 責務: 製品index.htmlが参照する起動scriptが実在し、生成bundleが現行ソースと一致することを、bundle本文を書き換えず確認する。
 * 変更ルール: テスト都合でbundleのbootstrap入口を差し替えない。DOM実行環境を模擬した疑似起動成功を作らず、ここでは配布HTMLから実在資産へ解決できることだけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertGeneratedBuildFreshness } = require('../../build/buildIdentity.js');

const projectRoot = path.join(__dirname, '..', '..', '..');
const rendererRoot = path.join(projectRoot, 'app', 'renderer');

function scriptSources(html) {
  return [...html.matchAll(/<script\s+src="([^"]+)"\s+defer><\/script>/gu)].map((match) => match[1]);
}

function localScriptPath(source) {
  const clean = source.replace(/\?.*$/u, '');
  return path.resolve(rendererRoot, clean);
}

test('起動HTMLのscript参照は実在ファイルと現行生成bundleへ解決する', () => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const sources = scriptSources(html);
  assert.ok(sources.length > 0, '起動scriptが1件以上必要です。');

  for (const source of sources) {
    assert.equal(fs.existsSync(localScriptPath(source)), true, `起動scriptが存在しません: ${source}`);
  }

  assert.equal(sources.some((source) => source.startsWith('./generated/bundle.js')), true, 'index.htmlから生成bundleを参照する');
  assert.equal(assertGeneratedBuildFreshness(projectRoot).ok, true, '生成bundleは現行ソースと一致する');
});
