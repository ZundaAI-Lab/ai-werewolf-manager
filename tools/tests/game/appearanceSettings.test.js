/**
 * 責務: 公開表示がテーマ＋アクセントだけを任意同期し、文字サイズ・背景効果・アニメーションを独立保持する現行外観契約と設定UIを検証する。
 * 変更ルール: CSSの色値や細かな装飾は固定せず、共有schema・実効設定・同期中の表示値・項目順・ツール本体と共通の表現だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAppearanceSettings,
  normalizeAppearanceSettings,
  resolvePublicAppearance,
} from '../../../app/renderer/js/appearance/appearanceModel.js';
import { renderAppearanceView } from '../../../app/renderer/js/ui/appearance/appearanceView.js';

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

test('公開表示フォームは配色・表示・演出の順で独立範囲が分かる表現にする', () => {
  const settings = defaultAppearanceSettings();
  settings.publicDisplay.inheritPalette = false;
  settings.publicDisplay.theme = 'zunda';
  settings.publicDisplay.accent = 'pink';
  settings.publicDisplay.effects = false;
  settings.publicDisplay.motion = 'reduced';
  const html = renderAppearanceView(settings);

  assert.match(html, /<h4>観戦用<\/h4>/u);
  assert.doesNotMatch(html, /観戦・動画・配信用/u);
  assert.match(html, /name="public-inherit-palette"/u);
  assert.match(html, /<strong>管理画面と同じ配色を使用<\/strong>/u);
  assert.match(html, /テーマとアクセントカラーを管理画面の設定に合わせます。/u);
  assert.match(html, /name="public-theme" value="zunda" checked/u);
  assert.match(html, /name="public-accent" value="pink" checked/u);
  assert.match(html, /<span>文字サイズ<\/span><select name="public-font-size">/u);
  assert.match(html, /<span>アニメーション<\/span><select name="public-motion">/u);
  assert.match(html, /name="public-effects"/u);
  assert.doesNotMatch(html, /管理画面と共有/u);
  assert.doesNotMatch(html, /公開表示テーマ/u);
  assert.doesNotMatch(html, /公開表示文字サイズ/u);

  const publicSection = html.slice(html.indexOf('<span class="eyebrow">公開表示</span>'));
  const paletteIndex = publicSection.indexOf('<h5>配色</h5>');
  const themeIndex = publicSection.indexOf('<legend>テーマ</legend>');
  const accentIndex = publicSection.indexOf('<legend>アクセントカラー</legend>');
  const displayIndex = publicSection.indexOf('<h5>表示</h5>');
  const fontIndex = publicSection.indexOf('<span>文字サイズ</span>');
  const effectsSectionIndex = publicSection.indexOf('<h5>演出</h5>');
  const motionIndex = publicSection.indexOf('<span>アニメーション</span>');
  const effectsIndex = publicSection.indexOf('<strong>背景効果・影を使用</strong>');
  assert.ok(
    paletteIndex >= 0
      && paletteIndex < themeIndex
      && themeIndex < accentIndex
      && accentIndex < displayIndex
      && displayIndex < fontIndex
      && fontIndex < effectsSectionIndex
      && effectsSectionIndex < motionIndex
      && motionIndex < effectsIndex,
  );
});

test('配色同期中は管理画面の実効テーマとアクセントを表示し両方の選択だけ無効化する', () => {
  const settings = defaultAppearanceSettings();
  settings.management.theme = 'zunda';
  settings.management.accent = 'green';
  settings.publicDisplay.inheritPalette = true;
  settings.publicDisplay.theme = 'blue';
  settings.publicDisplay.accent = 'pink';
  const html = renderAppearanceView(settings);

  assert.equal((html.match(/data-public-palette-options aria-disabled="true"/gu) ?? []).length, 2);
  assert.match(html, /name="public-theme" value="zunda" checked disabled/u);
  assert.match(html, /name="public-accent" value="green" checked disabled/u);
  assert.doesNotMatch(html, /name="public-theme" value="blue" checked/u);
  assert.doesNotMatch(html, /name="public-accent" value="pink" checked/u);
  assert.equal((html.match(/name="public-theme"/gu) ?? []).length, 4);
  assert.equal((html.match(/name="public-accent"/gu) ?? []).length, 7);
});
