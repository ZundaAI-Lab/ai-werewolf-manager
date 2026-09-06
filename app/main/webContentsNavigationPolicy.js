/**
 * 責務: Electronの全webContentsに対する新規ウィンドウ・外部URL・ナビゲーション境界を一元管理する。
 * 変更ルール: Rendererのゲーム/UI責務を持ち込まず、外部URLはアプリ内で実際に表示する公式リンクのHTTPSホストだけを許可する。about:blank子ウィンドウはMain Rendererからの公開表示用途だけ許可し、子ウィンドウからの追加window.open・任意遷移・webview添付は拒否する。
 */

'use strict';

const EXTERNAL_LINK_HOSTS = new Set([
  'production.lusty-kiss.com',
  'www.virvoxproject.com',
  'x.com',
  'zunko.jp',
]);

const CHILD_WINDOW_OPTIONS = Object.freeze({
  webPreferences: Object.freeze({
    preload: undefined,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  }),
});

function isAllowedExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ''));
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && EXTERNAL_LINK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function installWebContentsNavigationPolicy(contents, {
  isMainContents,
  rendererIndexUrl,
  openExternal,
  reportExternalOpenError = () => {},
} = {}) {
  if (!contents || typeof contents.setWindowOpenHandler !== 'function' || typeof contents.on !== 'function') {
    throw new TypeError('webContentsがありません。');
  }
  if (typeof isMainContents !== 'function') throw new TypeError('Main Renderer判定関数がありません。');
  if (typeof openExternal !== 'function') throw new TypeError('外部URL起動関数がありません。');
  const internalRendererUrl = String(rendererIndexUrl ?? '');

  contents.setWindowOpenHandler(({ url }) => {
    const mainContents = isMainContents(contents) === true;
    if (mainContents && url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: CHILD_WINDOW_OPTIONS };
    }
    if (mainContents && isAllowedExternalUrl(url)) {
      Promise.resolve(openExternal(url)).catch((error) => reportExternalOpenError(error, url));
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const currentUrl = String(contents.getURL?.() ?? '');
    const targetUrl = String(url ?? '');
    const mainContents = isMainContents(contents) === true;
    const allowed = targetUrl === currentUrl
      || (mainContents && targetUrl === internalRendererUrl)
      || (!mainContents && targetUrl === 'about:blank');
    if (!allowed) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
}

module.exports = {
  CHILD_WINDOW_OPTIONS,
  EXTERNAL_LINK_HOSTS,
  installWebContentsNavigationPolicy,
  isAllowedExternalUrl,
};
