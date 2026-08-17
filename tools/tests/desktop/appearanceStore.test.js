/**
 * 責務: 配色同期と公開表示独立の文字サイズ・背景効果・アニメーションを含む現行外観schemaがMainで厳密に保存・再読込されることを検証する。
 * 変更ルール: 過去不具合のschema再現は持たず、現行保存形・再読込・不正値拒否という今後の保存契約だけを確認する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppearanceStore } = require('../../../app/main/appearanceStore.js');
const {
  APPEARANCE_SCHEMA_VERSION,
  createDefaultAppearanceSettings,
} = require('../../../app/shared/appearanceSchema.js');

test('公開表示の配色同期と独立した表示・演出設定を保存して再読込する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-appearance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = new AppearanceStore(root);
  const current = store.publicSettings();
  const saved = store.savePublicSettings({
    ...current,
    management: { ...current.management, theme: 'red', accent: 'orange', effects: true, motion: 'normal' },
    publicDisplay: {
      ...current.publicDisplay,
      inheritPalette: false,
      theme: 'zunda',
      accent: 'cyan',
      fontSize: 'xlarge',
      effects: false,
      motion: 'reduced',
    },
  });

  assert.equal(saved.schemaVersion, APPEARANCE_SCHEMA_VERSION);
  assert.deepEqual(saved.publicDisplay, {
    inheritPalette: false,
    theme: 'zunda',
    accent: 'cyan',
    fontSize: 'xlarge',
    effects: false,
    motion: 'reduced',
  });
  assert.deepEqual(new AppearanceStore(root).publicSettings(), saved);
});

test('公開表示の配色・演出項目は共有許可値と型だけを受理する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-appearance-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = new AppearanceStore(root);
  const current = store.publicSettings();
  assert.throws(
    () => store.savePublicSettings({
      ...current,
      publicDisplay: { ...current.publicDisplay, accent: 'invalid-accent' },
    }),
    /publicDisplay\.accent/u,
  );
  assert.throws(
    () => store.savePublicSettings({
      ...current,
      publicDisplay: { ...current.publicDisplay, motion: 'fast' },
    }),
    /publicDisplay\.motion/u,
  );
  assert.throws(
    () => store.savePublicSettings({
      ...current,
      publicDisplay: { ...current.publicDisplay, effects: 'yes' },
    }),
    /publicDisplay\.effects/u,
  );
});
