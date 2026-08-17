/**
 * 責務: app/shared/appearanceSchema.jsの共有外観schemaをRenderer ES Moduleへ接続する。
 * 変更ルール: schemaVersion・許可値・既定値を複製しない。共有スクリプトを唯一の正本とし、契約欠落時は起動を明示的に失敗させる。
 */

import * as sharedSchemaModule from '../../../shared/appearanceSchema.js';

const schema = sharedSchemaModule.default ?? globalThis.AiWerewolfAppearanceSchema;
if (!schema) throw new Error('共有外観schemaを読み込めませんでした。');

export const {
  APPEARANCE_SCHEMA_VERSION,
  APPEARANCE_THEMES,
  APPEARANCE_ACCENTS,
  MANAGEMENT_FONT_SIZES,
  PUBLIC_FONT_SIZES,
  APPEARANCE_DENSITIES,
  APPEARANCE_MOTIONS,
  createDefaultAppearanceSettings,
} = schema;
