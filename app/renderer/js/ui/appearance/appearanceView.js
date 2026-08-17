/**
 * 責務: 管理画面と公開表示の外観設定dialogを、共通の表現規則と公開表示固有の配色同期・表示・演出区分に従って現在値から生成する。
 * 変更ルール: 永続化・DOMイベント処理・CSS適用を行わない。公開表示では配色だけを任意同期し、文字サイズ・背景効果・アニメーションは独立設定として表示する。選択肢は共有appearanceSchema.jsの現行許可値と一致させる。
 */

import { normalizeAppearanceSettings } from '../../appearance/appearanceModel.js';

const THEME_LABELS = Object.freeze({ dark: 'ダーク', red: 'ワインレッド', blue: 'ネイビー', zunda: 'ずんだ' });
const ACCENT_LABELS = Object.freeze({ purple: '紫', blue: '青', cyan: '水色', green: '緑', lime: '黄緑', orange: 'オレンジ', pink: 'ピンク' });
const FONT_LABELS = Object.freeze({ small: '小', normal: '標準', large: '大', xlarge: '特大' });
const DENSITY_LABELS = Object.freeze({ compact: 'コンパクト', normal: '標準', comfortable: 'ゆったり' });

function option(value, label, selected) {
  return `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`;
}

function themeCards(selected, name, disabled = false) {
  return Object.entries(THEME_LABELS).map(([value, label]) => `<label class="appearance-theme-card appearance-theme-${value}">
    <input type="radio" name="${name}" value="${value}"${selected === value ? ' checked' : ''}${disabled ? ' disabled' : ''}>
    <span class="appearance-theme-preview" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>${label}</strong>
  </label>`).join('');
}

function accentChoices(selected, name, disabled = false) {
  return Object.entries(ACCENT_LABELS).map(([value, label]) => `<label class="appearance-accent-choice" title="${label}">
    <input type="radio" name="${name}" value="${value}"${selected === value ? ' checked' : ''}${disabled ? ' disabled' : ''}>
    <span class="appearance-accent-swatch accent-${value}" aria-hidden="true"></span>
    <span>${label}</span>
  </label>`).join('');
}

function publicPaletteValue(publicDisplay, management, key) {
  return publicDisplay.inheritPalette ? management[key] : publicDisplay[key];
}

export function renderAppearanceView(raw) {
  const settings = normalizeAppearanceSettings(raw);
  const management = settings.management;
  const publicDisplay = settings.publicDisplay;
  const publicTheme = publicPaletteValue(publicDisplay, management, 'theme');
  const publicAccent = publicPaletteValue(publicDisplay, management, 'accent');
  return `<form method="dialog" class="appearance-form" data-appearance-form>
    <div class="modal-header appearance-modal-header">
      <div><h3>外観設定</h3><p>管理画面と公開表示の見た目を変更します。変更はすぐに反映されます。</p></div>
      <button class="button ghost small" value="close" type="submit">閉じる</button>
    </div>
    <div class="modal-body appearance-modal-body">
      <section class="appearance-section">
        <div class="appearance-section-heading"><div><span class="eyebrow">管理画面</span><h4>ツール本体</h4></div><p>操作画面のテーマ、読みやすさ、情報密度を調整します。</p></div>
        <fieldset class="appearance-fieldset"><legend>テーマ</legend><div class="appearance-theme-grid">${themeCards(management.theme, 'management-theme')}</div></fieldset>
        <fieldset class="appearance-fieldset"><legend>アクセントカラー</legend><div class="appearance-accent-grid">${accentChoices(management.accent, 'management-accent')}</div></fieldset>
        <div class="appearance-control-grid">
          <label class="field"><span>文字サイズ</span><select name="management-font-size">${option('small', FONT_LABELS.small, management.fontSize)}${option('normal', FONT_LABELS.normal, management.fontSize)}${option('large', FONT_LABELS.large, management.fontSize)}</select></label>
          <label class="field"><span>表示密度</span><select name="management-density">${option('compact', DENSITY_LABELS.compact, management.density)}${option('normal', DENSITY_LABELS.normal, management.density)}${option('comfortable', DENSITY_LABELS.comfortable, management.density)}</select></label>
          <label class="field"><span>アニメーション</span><select name="management-motion">${option('normal', '標準', management.motion)}${option('reduced', '控えめ', management.motion)}</select></label>
          <label class="appearance-toggle-row"><input type="checkbox" name="management-effects"${management.effects ? ' checked' : ''}><span><strong>背景効果・影を使用</strong><small>グラデーション、ぼかし、カードの影を表示します。</small></span></label>
        </div>
      </section>
      <section class="appearance-section">
        <div class="appearance-section-heading"><div><span class="eyebrow">公開表示</span><h4>観戦用</h4></div><p>公開タブ、別ウィンドウ、HTML出力へ同じ設定を反映します。</p></div>
        <div class="appearance-subsection">
          <div class="appearance-subsection-heading"><h5>配色</h5><p>テーマとアクセントカラーを設定します。</p></div>
          <label class="appearance-toggle-row appearance-public-inherit"><input type="checkbox" name="public-inherit-palette"${publicDisplay.inheritPalette ? ' checked' : ''}><span><strong>管理画面と同じ配色を使用</strong><small>テーマとアクセントカラーを管理画面の設定に合わせます。</small></span></label>
          <fieldset class="appearance-fieldset"><legend>テーマ</legend><div class="appearance-theme-grid appearance-public-palette-options" data-public-palette-options aria-disabled="${publicDisplay.inheritPalette ? 'true' : 'false'}">${themeCards(publicTheme, 'public-theme', publicDisplay.inheritPalette)}</div></fieldset>
          <fieldset class="appearance-fieldset"><legend>アクセントカラー</legend><div class="appearance-accent-grid appearance-public-palette-options" data-public-palette-options aria-disabled="${publicDisplay.inheritPalette ? 'true' : 'false'}">${accentChoices(publicAccent, 'public-accent', publicDisplay.inheritPalette)}</div></fieldset>
        </div>
        <div class="appearance-subsection">
          <div class="appearance-subsection-heading"><h5>表示</h5></div>
          <div class="appearance-control-grid appearance-public-control-grid">
            <label class="field"><span>文字サイズ</span><select name="public-font-size">${option('normal', FONT_LABELS.normal, publicDisplay.fontSize)}${option('large', FONT_LABELS.large, publicDisplay.fontSize)}${option('xlarge', FONT_LABELS.xlarge, publicDisplay.fontSize)}</select></label>
          </div>
        </div>
        <div class="appearance-subsection">
          <div class="appearance-subsection-heading"><h5>演出</h5></div>
          <div class="appearance-control-grid">
            <label class="field"><span>アニメーション</span><select name="public-motion">${option('normal', '標準', publicDisplay.motion)}${option('reduced', '控えめ', publicDisplay.motion)}</select></label>
            <label class="appearance-toggle-row"><input type="checkbox" name="public-effects"${publicDisplay.effects ? ' checked' : ''}><span><strong>背景効果・影を使用</strong><small>グラデーション、ぼかし、カードの影を表示します。</small></span></label>
          </div>
        </div>
      </section>
    </div>
    <div class="modal-footer appearance-modal-footer">
      <button class="button ghost" data-appearance-reset type="button">初期設定に戻す</button>
      <button class="button primary" value="close" type="submit">閉じる</button>
    </div>
  </form>`;
}
