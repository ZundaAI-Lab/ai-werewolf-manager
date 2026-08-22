/**
 * 責務: RendererのES Module製品ソースをNode vmベースのデスクトップ単体テストで同期評価できるよう、import/export構文だけをテスト用script表現へ変換する。
 * 変更ルール: 製品ロジックを書き換えず、import行の除去とexport修飾子／export-listの除去だけを行う。依存APIのstubやwindow公開互換は各テスト側で明示する。
 */

'use strict';

function esmSourceAsVmScript(source) {
  return String(source ?? '')
    .replace(/^import[^\n]*;\s*$/gmu, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gu, '')
    .replace(/\n?export\s*\{[\s\S]*?\};?\s*$/gu, '\n');
}

module.exports = { esmSourceAsVmScript };
