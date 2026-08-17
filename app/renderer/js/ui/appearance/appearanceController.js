/**
 * 責務: 管理画面・公開表示の外観設定dialogの開閉、公開表示の配色同期を含むフォーム変更の即時プレビュー、Mainへの永続化、初期設定へのリセットを所有する。
 * 変更ルール: CSSトークン定義・ゲーム状態・AI設定を変更しない。公開表示ではテーマとアクセントだけを一括同期し、文字サイズ・背景効果・アニメーションは常に独立値として保存する。外観設定は専用IPCだけで直列保存し、保存成功した設定をconfirmed状態の正本とする。最新保存に失敗した場合は未保存プレビューをconfirmed状態へ戻し、ブラウザストレージへ保存しない。
 */

import { applyManagementAppearance } from '../../appearance/appearanceTheme.js';
import { defaultAppearanceSettings, normalizeAppearanceSettings } from '../../appearance/appearanceModel.js';
import { renderAppearanceView } from './appearanceView.js';

function readFormSettings(dialog, current) {
  const form = dialog.querySelector('[data-appearance-form]');
  if (!form) return current;
  const data = new FormData(form);
  return normalizeAppearanceSettings({
    schemaVersion: current.schemaVersion,
    management: {
      theme: data.get('management-theme'),
      accent: data.get('management-accent'),
      fontSize: data.get('management-font-size'),
      density: data.get('management-density'),
      effects: form.elements.namedItem('management-effects')?.checked === true,
      motion: data.get('management-motion'),
    },
    publicDisplay: {
      inheritPalette: form.elements.namedItem('public-inherit-palette')?.checked === true,
      theme: data.get('public-theme') ?? current.publicDisplay.theme,
      accent: data.get('public-accent') ?? current.publicDisplay.accent,
      fontSize: data.get('public-font-size'),
      effects: form.elements.namedItem('public-effects')?.checked === true,
      motion: data.get('public-motion'),
    },
  });
}

function syncPublicPaletteControls(dialog, settings) {
  const inherited = settings.publicDisplay.inheritPalette;
  const selectedTheme = inherited ? settings.management.theme : settings.publicDisplay.theme;
  const selectedAccent = inherited ? settings.management.accent : settings.publicDisplay.accent;

  dialog.querySelectorAll('[data-public-palette-options]').forEach((group) => {
    group.setAttribute('aria-disabled', inherited ? 'true' : 'false');
  });
  dialog.querySelectorAll('[name="public-theme"]').forEach((input) => {
    input.disabled = inherited;
    input.checked = input.value === selectedTheme;
  });
  dialog.querySelectorAll('[name="public-accent"]').forEach((input) => {
    input.disabled = inherited;
    input.checked = input.value === selectedAccent;
  });
}

export function createAppearanceController({ dialog, initialSettings, saveSettings, toast, onChange }) {
  if (!dialog) throw new TypeError('外観設定dialogがありません。');
  if (typeof saveSettings !== 'function') throw new TypeError('外観設定保存関数がありません。');

  let settings = normalizeAppearanceSettings(initialSettings);
  let confirmedSettings = structuredClone(settings);
  let saveSequence = 0;
  let saveQueue = Promise.resolve();

  function publish(next) {
    settings = applyManagementAppearance(next);
    onChange?.(structuredClone(settings));
  }

  function rerenderOpenDialog() {
    if (dialog.open) dialog.innerHTML = renderAppearanceView(settings);
  }

  function persist(next) {
    const sequence = ++saveSequence;
    const candidate = structuredClone(next);
    saveQueue = saveQueue.then(async () => {
      try {
        const saved = normalizeAppearanceSettings(await saveSettings(candidate));
        confirmedSettings = structuredClone(saved);
        if (sequence === saveSequence) {
          publish(saved);
          rerenderOpenDialog();
        }
      } catch (error) {
        if (sequence === saveSequence) {
          publish(confirmedSettings);
          rerenderOpenDialog();
          toast?.(`外観設定を保存できませんでした: ${error.message}`, 'error');
        }
      }
    });
    return saveQueue;
  }

  function open() {
    dialog.innerHTML = renderAppearanceView(settings);
    dialog.showModal();
  }

  dialog.addEventListener('change', (event) => {
    if (!event.target.closest('[data-appearance-form]')) return;
    const next = readFormSettings(dialog, settings);
    syncPublicPaletteControls(dialog, next);
    publish(next);
    void persist(next);
  });

  dialog.addEventListener('click', (event) => {
    if (!event.target.closest('[data-appearance-reset]')) return;
    const next = defaultAppearanceSettings();
    dialog.innerHTML = renderAppearanceView(next);
    publish(next);
    void persist(next);
  });

  return Object.freeze({
    open,
    getSettings: () => structuredClone(settings),
  });
}
