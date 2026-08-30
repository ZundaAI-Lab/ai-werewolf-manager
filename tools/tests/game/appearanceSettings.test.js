/**
 * 責務: 公開表示がテーマ＋アクセントだけを任意同期し、文字サイズ・背景効果・アニメーションを独立保持する外観モデル契約を検証する。
 * 変更ルール: UI文言・DOM順序・選択肢個数は固定せず、設定値から実効公開外観を解決するDomain契約だけを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAppearanceSettings,
  normalizeAppearanceSettings,
  resolvePublicAppearance,
} from '../../../app/renderer/js/appearance/appearanceModel.js';

test('公開表示の配色同期はテーマとアクセントだけを管理画面から引き継ぐ', () => {
  const defaults = defaultAppearanceSettings();
  const settings = normalizeAppearanceSettings({
    ...defaults,
    management: {
      ...defaults.management,
      theme: 'red',
      accent: 'orange',
      effects: false,
      motion: 'reduced',
    },
    publicDisplay: {
      ...defaults.publicDisplay,
      inheritPalette: true,
      theme: 'blue',
      accent: 'cyan',
      fontSize: 'xlarge',
      effects: true,
      motion: 'normal',
    },
  });

  assert.equal(settings.publicDisplay.theme, 'blue');
  assert.equal(settings.publicDisplay.accent, 'cyan');
  assert.deepEqual(resolvePublicAppearance(settings), {
    theme: 'red',
    accent: 'orange',
    fontSize: 'xlarge',
    density: 'normal',
    effects: true,
    motion: 'normal',
  });
});

test('公開表示の配色同期を解除すると公開表示専用テーマとアクセントを使用する', () => {
  const settings = defaultAppearanceSettings();
  settings.management.theme = 'red';
  settings.management.accent = 'orange';
  settings.publicDisplay.inheritPalette = false;
  settings.publicDisplay.theme = 'zunda';
  settings.publicDisplay.accent = 'pink';
  settings.publicDisplay.effects = false;
  settings.publicDisplay.motion = 'reduced';

  assert.deepEqual(resolvePublicAppearance(settings), {
    theme: 'zunda',
    accent: 'pink',
    fontSize: 'large',
    density: 'normal',
    effects: false,
    motion: 'reduced',
  });
});
