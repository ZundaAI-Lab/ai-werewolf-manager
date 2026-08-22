/**
 * 責務: 公開HTML出力と公開ウィンドウの生成・同期、および公開表示専用外観の反映を所有する。
 * 変更ルール: ゲーム規則を独自実装せず、store・機密表示取得・通知だけを明示依存として受け取る。公開表示の外観はsetAppearanceで受け取ったスナップショットだけを保持し、AppUI全体へ依存しない。公開ウィンドウ参照も本Controllerだけで保持する。公開HTMLは出力時点の機密表示状態に対応するスナップショットだけを生成して渡し、非表示出力では機密スナップショット自体を生成しない。公開専用ウィンドウはhtml要素へ専用クラスを付与し、通常画面の固定レイアウトと独立して全文を縦スクロールできる状態を維持する。
 */

// @ts-check

import { buildPublicSnapshot } from '../../public/publicSnapshot.js';
import { escapeHtml, sanitizeFilenamePart } from '../../shared/utils.js';
import { downloadStandalonePublicHtml } from '../../public/publicHtmlExport.js';
import { renderPublicSnapshot } from '../views/public/publicView.js';
import { applyPublicAppearance } from '../../appearance/appearanceTheme.js';

export function createPublicWindowController({ store, getConfidential, toast }) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('状態Storeがありません。');
  if (typeof getConfidential !== 'function') throw new TypeError('機密表示取得関数がありません。');
  if (typeof toast !== 'function') throw new TypeError('通知関数がありません。');

  let publicWindow = null;
  let appearance = null;

  function _exportPublicHtml() {
    const state = store.getState();
    const safeTitle = sanitizeFilenamePart(state.game.title, { fallback: 'AI人狼公開表示' });
    const includeConfidential = Boolean(getConfidential());
    downloadStandalonePublicHtml({
      title: `${safeTitle} - 公開表示`,
      filename: `${safeTitle}_公開表示.html`,
      snapshot: buildPublicSnapshot(state, { includeConfidential }),
      appearance,
    });
    toast('公開表示HTMLを出力しました。', 'success');
  }

  function _updatePublicWindow() {
    if (!publicWindow || publicWindow.closed) return;
    const root = publicWindow.document.querySelector('#public-root');
    if (!root) return;
    applyPublicAppearance(appearance, publicWindow.document);
    root.innerHTML = renderPublicSnapshot(buildPublicSnapshot(store.getState(), {
      includeConfidential: getConfidential(),
    }));
  }

  function _openPublicWindow() {
    if (!publicWindow || publicWindow.closed) {
      publicWindow = window.open('', 'ai-werewolf-public', 'width=960,height=720');
      if (!publicWindow) {
        toast('ポップアップがブロックされました。', 'error');
        return;
      }
      const cssUrl = escapeHtml(new URL('./css/styles.css', window.location.href).href);
      publicWindow.document.write(`<!doctype html>
<html lang="ja" class="standalone-public-document">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <title>AI人狼 公開表示</title>
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body class="standalone-public">
  <main id="public-root"></main>
</body>
</html>`);
      publicWindow.document.close();
      applyPublicAppearance(appearance, publicWindow.document);
      try { publicWindow.opener = null; } catch {}
    }
    _updatePublicWindow();
    publicWindow.focus();
  }

  return Object.freeze({
    _exportPublicHtml,
    _openPublicWindow,
    _updatePublicWindow,
    setAppearance(next) {
      appearance = next ? structuredClone(next) : null;
      _updatePublicWindow();
    },
  });
}
