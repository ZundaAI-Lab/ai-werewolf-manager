/**
 * 責務: ツール本体と、任意の配色同期・独立した表示/演出設定を持つ公開表示の外観設定だけをuserData内の専用JSONへ永続化する。
 * 変更ルール: AI設定・ゲーム状態・画面描画を扱わない。製品schema互換層で旧schemaを現行へ一方向migrationした後に共有appearanceSchema.jsの現行保存形を検証し、未来schemaは推測して読まない。migration前ファイルはpre-schemaバックアップを残す。Renderer入力は未知項目を拒否し、原子的保存の成功後だけメモリへ反映する。
 */

'use strict';

const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');
const { DATA_SCHEMA_KIND } = require('../shared/dataCompatibility/schemaVersions.js');
const { migratePersistedDocument } = require('./dataCompatibilityPersistence.js');
const {
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
} = require('../shared/appearanceSchema.js');

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactObjectKeys(value, allowedKeys, label) {
  if (!plainObject(value)) throw new TypeError(`${label}はオブジェクトで指定してください。`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new RangeError(`${label}に未知の項目があります: ${unknown.join(', ')}`);
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new RangeError(`${label}の値が不正です。`);
  return value;
}

function normalizeAppearanceSettings(raw) {
  exactObjectKeys(raw, APPEARANCE_STORAGE_KEYS, '外観設定');
  if (raw.schemaVersion !== APPEARANCE_SCHEMA_VERSION) throw new RangeError('外観設定schemaVersionが一致しません。');
  exactObjectKeys(raw.management, MANAGEMENT_APPEARANCE_KEYS, 'management');
  exactObjectKeys(raw.publicDisplay, PUBLIC_APPEARANCE_KEYS, 'publicDisplay');

  if (typeof raw.management.effects !== 'boolean') throw new TypeError('management.effectsは真偽値で指定してください。');
  if (typeof raw.publicDisplay.inheritPalette !== 'boolean') throw new TypeError('publicDisplay.inheritPaletteは真偽値で指定してください。');
  if (typeof raw.publicDisplay.effects !== 'boolean') throw new TypeError('publicDisplay.effectsは真偽値で指定してください。');

  return {
    schemaVersion: APPEARANCE_SCHEMA_VERSION,
    management: {
      theme: enumValue(raw.management.theme, APPEARANCE_THEMES, 'management.theme'),
      accent: enumValue(raw.management.accent, APPEARANCE_ACCENTS, 'management.accent'),
      fontSize: enumValue(raw.management.fontSize, MANAGEMENT_FONT_SIZES, 'management.fontSize'),
      density: enumValue(raw.management.density, APPEARANCE_DENSITIES, 'management.density'),
      effects: raw.management.effects,
      motion: enumValue(raw.management.motion, APPEARANCE_MOTIONS, 'management.motion'),
    },
    publicDisplay: {
      inheritPalette: raw.publicDisplay.inheritPalette,
      theme: enumValue(raw.publicDisplay.theme, APPEARANCE_THEMES, 'publicDisplay.theme'),
      accent: enumValue(raw.publicDisplay.accent, APPEARANCE_ACCENTS, 'publicDisplay.accent'),
      fontSize: enumValue(raw.publicDisplay.fontSize, PUBLIC_FONT_SIZES, 'publicDisplay.fontSize'),
      effects: raw.publicDisplay.effects,
      motion: enumValue(raw.publicDisplay.motion, APPEARANCE_MOTIONS, 'publicDisplay.motion'),
    },
  };
}

function fsyncDirectoryBestEffort(directoryPath) {
  let descriptor = null;
  try {
    descriptor = openSync(directoryPath, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'w', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    fsyncDirectoryBestEffort(dirname(path));
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
}

class AppearanceStore {
  constructor(userDataPath) {
    this.path = join(userDataPath, 'appearance.json');
    this.settings = this._loadCurrentOrDefault();
  }

  _loadCurrentOrDefault() {
    if (!existsSync(this.path)) return createDefaultAppearanceSettings();
    try {
      const migration = migratePersistedDocument(JSON.parse(readFileSync(this.path, 'utf8')), { kind: DATA_SCHEMA_KIND.APPEARANCE, label: '外観設定', path: this.path });
      const normalized = normalizeAppearanceSettings(migration.value);
      if (migration.migrated) atomicWriteJson(this.path, normalized);
      return normalized;
    } catch (error) {
      console.warn('外観設定を読み込めないため既定値を使用します。元ファイルは変更しません。', error);
      return createDefaultAppearanceSettings();
    }
  }

  publicSettings() {
    return structuredClone(this.settings);
  }

  savePublicSettings(raw) {
    const next = normalizeAppearanceSettings(raw);
    atomicWriteJson(this.path, next);
    this.settings = next;
    return this.publicSettings();
  }
}

module.exports = {
  AppearanceStore,
  normalizeAppearanceSettings,
};
