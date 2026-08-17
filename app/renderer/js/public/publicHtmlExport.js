/**
 * 責務: 出力時点で選択された公開専用スナップショットと公開表示外観だけを、画面版と同じ話者メタ情報・改行・投票内訳を保った外部依存のない単一HTMLへ固定化して出力する。
 * 変更ルール: 完全状態や表示対象外スナップショットをHTMLへ埋め込まない。機密情報の表示可否は出力前に確定し、出力HTML自身には機密情報の切替機能・別表示用データ・実行スクリプトを持たせない。
 */

import { escapeHtml } from '../shared/utils.js';
import { renderPublicSnapshot } from '../ui/views/public/publicView.js';
import { resolvePublicAppearance } from '../appearance/appearanceModel.js';
import { PUBLIC_VIEW_CSS } from '../../generated/publicViewStyles.js';

export function buildStandalonePublicHtml({
  title,
  snapshot,
  appearance,
}) {
  const publicHtml = renderPublicSnapshot(snapshot);
  const publicAppearance = resolvePublicAppearance(appearance);
  return `<!doctype html>
<html lang="ja" data-public-document="true" data-theme="${escapeHtml(publicAppearance.theme)}" data-accent="${escapeHtml(publicAppearance.accent)}" data-font-size="${escapeHtml(publicAppearance.fontSize)}" data-density="normal" data-effects="${publicAppearance.effects ? 'on' : 'off'}" data-motion="${escapeHtml(publicAppearance.motion)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<style>${PUBLIC_VIEW_CSS}</style>
</head>
<body>
<main id="public-view">${publicHtml}</main>
</body>
</html>`;
}

export function downloadStandalonePublicHtml(options) {
  const html = buildStandalonePublicHtml(options);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = options.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
