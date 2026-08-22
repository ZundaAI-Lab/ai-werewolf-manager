/**
 * 責務: 公開表示UIの主要安全境界を、ソース文字列ではなく公開APIの挙動で検証する。
 * 変更ルール: AppUI内部の関数名、Controller生成コード、DOM配置、CSS値を固定しない。外部へ公開するHTMLの安全性とController依存境界だけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(__dirname, '../../../app/renderer/js', relativePath)).href;
}

test('公開ウィンドウControllerは必要依存の欠落を生成時に拒否する', async () => {
  const { createPublicWindowController } = await import(moduleUrl('ui/controllers/publicWindowController.js'));
  const store = { getState: () => ({}) };
  const getConfidential = () => false;
  const toast = () => {};

  assert.throws(() => createPublicWindowController({ store: null, getConfidential, toast }), /状態Store/u);
  assert.throws(() => createPublicWindowController({ store, getConfidential: null, toast }), /機密表示取得関数/u);
  assert.throws(() => createPublicWindowController({ store, getConfidential, toast: null }), /通知関数/u);
  assert.doesNotThrow(() => createPublicWindowController({ store, getConfidential, toast }));
});

test('単一公開HTMLはタイトルをエスケープし実行scriptを許可しない', async () => {
  const { buildStandalonePublicHtml } = await import(moduleUrl('public/publicHtmlExport.js'));
  const html = buildStandalonePublicHtml({
    title: '<script>alert(1)</script>',
    snapshot: {
      game: { title: '公開テスト', status: 'setup', day: 0, phase: 'setup', phaseLabel: '準備中' },
      players: [],
      claims: [],
      publicAbilityClaims: [],
      events: [],
      voteSession: null,
      execution: null,
      result: null,
    },
    appearance: null,
  });

  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(html.includes("script-src 'none'"), true);
  assert.equal(html.includes('<script'), false);
});
