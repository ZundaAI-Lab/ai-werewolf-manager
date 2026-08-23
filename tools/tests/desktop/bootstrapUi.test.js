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


test('公開別ウィンドウのホイール入力は表示documentの縦スクロールへ反映する', async (t) => {
  const { createPublicWindowController } = await import(moduleUrl('ui/controllers/publicWindowController.js'));
  const previousWindow = global.window;
  t.after(() => {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });

  const wheelListeners = [];
  const scrollingElement = { scrollHeight: 2400, clientHeight: 600, scrollTop: 120 };
  const documentElement = { dataset: {} };
  const publicRoot = { innerHTML: '' };
  const popup = {
    closed: false,
    opener: {},
    document: {
      documentElement,
      scrollingElement,
      write() {},
      close() {},
      querySelector(selector) { return selector === '#public-root' ? publicRoot : null; },
    },
    addEventListener(type, listener) {
      if (type === 'wheel') wheelListeners.push(listener);
    },
    focus() {},
  };
  global.window = {
    location: { href: 'file:///tmp/renderer/index.html' },
    open() { return popup; },
  };

  const state = {
    schemaVersion: 1,
    publicRevision: 0,
    game: { title: '公開テスト', status: 'setup', day: 0, phase: 'setup' },
    players: [],
    claims: [],
    publicAbilityClaims: [],
    events: [],
    result: null,
  };
  const controller = createPublicWindowController({
    store: { getState: () => state },
    getConfidential: () => false,
    toast: () => {},
  });

  controller._openPublicWindow();
  assert.equal(wheelListeners.length, 1);

  let prevented = false;
  wheelListeners[0]({
    ctrlKey: false,
    deltaY: 180,
    deltaMode: 0,
    preventDefault() { prevented = true; },
  });

  assert.equal(scrollingElement.scrollTop, 300);
  assert.equal(prevented, true);
});
