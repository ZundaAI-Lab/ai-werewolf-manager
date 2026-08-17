/**
 * 責務: publicView.cssを単体公開HTML埋め込み用の決定的ES Moduleへ変換し、生成物がCSS正本と一致するか検査する。
 * 変更ルール:
 * - 公開表示のCSS内容をこのモジュールへ複製せず、app/renderer/css/publicView.cssだけを入力正本とする。
 * - 生成先はapp/renderer/generated/publicViewStyles.jsだけとし、業務モジュールやstyles.cssを書き換えない。
 * - 生成形式を変更した場合はbuildIdentity.jsの鮮度検査を通し、既存生成物を黙って再利用しない。
 * - 単体HTMLのstyle要素を途中終了させる文字列は生成前に拒否する。
 */

'use strict';

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function publicViewCssPaths(projectRoot) {
  return Object.freeze({
    sourcePath: join(projectRoot, 'app', 'renderer', 'css', 'publicView.css'),
    generatedPath: join(projectRoot, 'app', 'renderer', 'generated', 'publicViewStyles.js'),
  });
}

function renderPublicViewCssModule(projectRoot) {
  const { sourcePath } = publicViewCssPaths(projectRoot);
  const css = readFileSync(sourcePath, 'utf8');
  if (/<\/style/iu.test(css)) {
    throw new Error('publicView.cssに単体HTMLのstyle要素を終了させる文字列を含めることはできません。');
  }
  return `/**\n * publicView.cssから生成される単体公開HTML用スタイル。手動編集しない。\n */\n\nexport const PUBLIC_VIEW_CSS = ${JSON.stringify(css)};\n`;
}

function writePublicViewCssModule(projectRoot) {
  const { generatedPath } = publicViewCssPaths(projectRoot);
  writeFileSync(generatedPath, renderPublicViewCssModule(projectRoot), 'utf8');
  return generatedPath;
}

function inspectPublicViewCssAsset(projectRoot) {
  const { generatedPath } = publicViewCssPaths(projectRoot);
  if (!existsSync(generatedPath)) {
    return Object.freeze({ ok: false, error: 'generated/publicViewStyles.jsがありません。' });
  }
  const expected = renderPublicViewCssModule(projectRoot);
  const actual = readFileSync(generatedPath, 'utf8');
  if (actual !== expected) {
    return Object.freeze({ ok: false, error: 'generated/publicViewStyles.jsがpublicView.cssと一致しません。' });
  }
  return Object.freeze({ ok: true, error: null });
}

module.exports = {
  inspectPublicViewCssAsset,
  publicViewCssPaths,
  renderPublicViewCssModule,
  writePublicViewCssModule,
};
