/**
 * 責務: Main Rendererと子webContentsの外部リンク・新規ウィンドウ・ナビゲーション境界を検証する。
 * 変更ルール: Electron実体を起動せず、許可ホストとMain/子の権限差だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installWebContentsNavigationPolicy,
  isAllowedExternalUrl,
} = require('../../../app/main/webContentsNavigationPolicy.js');

function contentsStub(initialUrl = '') {
  let currentUrl = initialUrl;
  const listeners = new Map();
  let windowOpenHandler = null;
  return {
    listeners,
    setWindowOpenHandler(handler) { windowOpenHandler = handler; },
    on(type, handler) { listeners.set(type, handler); },
    getURL() { return currentUrl; },
    setURL(url) { currentUrl = url; },
    open(url) { return windowOpenHandler({ url }); },
  };
}

function navigationEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('外部リンクは実際に表示するHTTPS公式ホストだけ許可する', () => {
  assert.equal(isAllowedExternalUrl('https://zunko.jp/guideline.html'), true);
  assert.equal(isAllowedExternalUrl('https://www.virvoxproject.com/'), true);
  assert.equal(isAllowedExternalUrl('https://production.lusty-kiss.com/tos'), true);
  assert.equal(isAllowedExternalUrl('https://x.com/ZundaAI'), true);
  assert.equal(isAllowedExternalUrl('https://example.com/?secret=value'), false);
  assert.equal(isAllowedExternalUrl('http://zunko.jp/'), false);
  assert.equal(isAllowedExternalUrl('https://user:pass@zunko.jp/'), false);
});

test('Main Rendererだけが公開子ウィンドウと許可済み外部リンクを開ける', async () => {
  const contents = contentsStub('file:///app/renderer/index.html');
  const opened = [];
  installWebContentsNavigationPolicy(contents, {
    isMainContents: () => true,
    rendererIndexUrl: 'file:///app/renderer/index.html',
    openExternal: async (url) => opened.push(url),
  });

  assert.equal(contents.open('about:blank').action, 'allow');
  assert.equal(contents.open('https://zunko.jp/').action, 'deny');
  await Promise.resolve();
  assert.deepEqual(opened, ['https://zunko.jp/']);
  assert.equal(contents.open('https://example.com/').action, 'deny');
  assert.deepEqual(opened, ['https://zunko.jp/']);
});

test('子webContentsは追加window.openと任意遷移を拒否しwebview添付も拒否する', () => {
  const contents = contentsStub('about:blank');
  installWebContentsNavigationPolicy(contents, {
    isMainContents: () => false,
    rendererIndexUrl: 'file:///app/renderer/index.html',
    openExternal: async () => { throw new Error('呼ばれない'); },
  });

  assert.equal(contents.open('about:blank').action, 'deny');
  assert.equal(contents.open('https://zunko.jp/').action, 'deny');

  const allowedSame = navigationEvent();
  contents.listeners.get('will-navigate')(allowedSame, 'about:blank');
  assert.equal(allowedSame.prevented, false);

  const blockedNavigation = navigationEvent();
  contents.listeners.get('will-navigate')(blockedNavigation, 'https://zunko.jp/');
  assert.equal(blockedNavigation.prevented, true);

  const webviewEvent = navigationEvent();
  contents.listeners.get('will-attach-webview')(webviewEvent);
  assert.equal(webviewEvent.prevented, true);
});
