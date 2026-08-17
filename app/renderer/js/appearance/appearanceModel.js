/**
 * 責務: Rendererで扱う外観設定を共有schemaの現行形式へ正規化し、公開表示の配色同期と独立した表示・演出設定を含む実効設定を導出する。
 * 変更ルール: DOM変更・永続化・CSS定義を行わない。過去schemaの移行は行わず、不正値は共有schemaの既定値へ局所的に戻す。schemaVersion・許可値・既定値はappearanceSchemaAdapter経由のapp/shared/appearanceSchema.jsだけを正本とし、本モジュールへ複製しない。
 */

import {
  APPEARANCE_SCHEMA_VERSION,
  APPEARANCE_THEMES,
  APPEARANCE_ACCENTS,
  MANAGEMENT_FONT_SIZES,
  PUBLIC_FONT_SIZES,
  APPEARANCE_DENSITIES,
  APPEARANCE_MOTIONS,
  createDefaultAppearanceSettings as createSharedDefaultAppearanceSettings,
} from './appearanceSchemaAdapter.js';

function allowed(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

export function defaultAppearanceSettings() {
  return createSharedDefaultAppearanceSettings();
}

export function normalizeAppearanceSettings(raw = {}) {
  const defaults = createSharedDefaultAppearanceSettings();
  const management = raw?.management ?? {};
  const publicDisplay = raw?.publicDisplay ?? {};
  return {
    schemaVersion: APPEARANCE_SCHEMA_VERSION,
    management: {
      theme: allowed(management.theme, APPEARANCE_THEMES, defaults.management.theme),
      accent: allowed(management.accent, APPEARANCE_ACCENTS, defaults.management.accent),
      fontSize: allowed(management.fontSize, MANAGEMENT_FONT_SIZES, defaults.management.fontSize),
      density: allowed(management.density, APPEARANCE_DENSITIES, defaults.management.density),
      effects: typeof management.effects === 'boolean' ? management.effects : defaults.management.effects,
      motion: allowed(management.motion, APPEARANCE_MOTIONS, defaults.management.motion),
    },
    publicDisplay: {
      inheritPalette: typeof publicDisplay.inheritPalette === 'boolean' ? publicDisplay.inheritPalette : defaults.publicDisplay.inheritPalette,
      theme: allowed(publicDisplay.theme, APPEARANCE_THEMES, defaults.publicDisplay.theme),
      accent: allowed(publicDisplay.accent, APPEARANCE_ACCENTS, defaults.publicDisplay.accent),
      fontSize: allowed(publicDisplay.fontSize, PUBLIC_FONT_SIZES, defaults.publicDisplay.fontSize),
      effects: typeof publicDisplay.effects === 'boolean' ? publicDisplay.effects : defaults.publicDisplay.effects,
      motion: allowed(publicDisplay.motion, APPEARANCE_MOTIONS, defaults.publicDisplay.motion),
    },
  };
}

export function resolvePublicAppearance(raw = {}) {
  const settings = normalizeAppearanceSettings(raw);
  return Object.freeze({
    theme: settings.publicDisplay.inheritPalette ? settings.management.theme : settings.publicDisplay.theme,
    accent: settings.publicDisplay.inheritPalette ? settings.management.accent : settings.publicDisplay.accent,
    fontSize: settings.publicDisplay.fontSize,
    density: 'normal',
    effects: settings.publicDisplay.effects,
    motion: settings.publicDisplay.motion,
  });
}
