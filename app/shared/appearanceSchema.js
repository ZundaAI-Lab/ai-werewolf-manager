/**
 * 責務: Electron Main・Rendererで共有する外観設定の現行schemaVersion、許可値、既定値を定義する。
 * 変更ルール: schemaVersionはdataCompatibility/schemaVersions.jsを正本とし、保存形式変更時はschemaVersion更新とmigration追加を同時に行う。公開表示は配色同期の有無と、文字サイズ・背景効果・アニメーションの独立設定を保持する。永続化・DOM操作・CSS適用は行わない。
 */

(function initializeAppearanceSchema(root, factory) {
  'use strict';

  const commonJs = typeof module === 'object' && module.exports;
  const versions = commonJs ? require('./dataCompatibility/schemaVersions.js') : root?.AiWerewolfDataSchemaVersions;
  const api = factory(versions);
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfAppearanceSchema = api;
    if (root.window && root.window !== root) root.window.AiWerewolfAppearanceSchema = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, (versions) => {
  'use strict';

  if (!versions) throw new Error('データschema定義を読み込めません。');
  const APPEARANCE_SCHEMA_VERSION = versions.getCurrentDataSchemaVersion(versions.DATA_SCHEMA_KIND.APPEARANCE);
  const APPEARANCE_STORAGE_KEYS = Object.freeze(['schemaVersion', 'management', 'publicDisplay']);
  const MANAGEMENT_APPEARANCE_KEYS = Object.freeze(['theme', 'accent', 'fontSize', 'density', 'effects', 'motion']);
  const PUBLIC_APPEARANCE_KEYS = Object.freeze(['inheritPalette', 'theme', 'accent', 'fontSize', 'effects', 'motion']);
  const APPEARANCE_THEMES = Object.freeze(['dark', 'red', 'blue', 'zunda']);
  const APPEARANCE_ACCENTS = Object.freeze(['purple', 'blue', 'cyan', 'green', 'lime', 'orange', 'pink']);
  const MANAGEMENT_FONT_SIZES = Object.freeze(['small', 'normal', 'large']);
  const PUBLIC_FONT_SIZES = Object.freeze(['normal', 'large', 'xlarge']);
  const APPEARANCE_DENSITIES = Object.freeze(['compact', 'normal', 'comfortable']);
  const APPEARANCE_MOTIONS = Object.freeze(['normal', 'reduced']);

  function createDefaultAppearanceSettings() {
    return {
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      management: {
        theme: 'dark',
        accent: 'purple',
        fontSize: 'normal',
        density: 'normal',
        effects: true,
        motion: 'normal',
      },
      publicDisplay: {
        inheritPalette: true,
        theme: 'blue',
        accent: 'purple',
        fontSize: 'large',
        effects: true,
        motion: 'normal',
      },
    };
  }

  return Object.freeze({
    APPEARANCE_SCHEMA_VERSION,
    APPEARANCE_STORAGE_KEYS,
    MANAGEMENT_APPEARANCE_KEYS,
    PUBLIC_APPEARANCE_KEYS,
    APPEARANCE_THEMES,
    APPEARANCE_ACCENTS,
    MANAGEMENT_FONT_SIZES,
    PUBLIC_FONT_SIZES,
    APPEARANCE_DENSITIES,
    APPEARANCE_MOTIONS,
    createDefaultAppearanceSettings,
  });
});
