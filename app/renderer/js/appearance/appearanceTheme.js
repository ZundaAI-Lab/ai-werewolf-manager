/**
 * 責務: 正規化済み外観設定を管理画面documentまたは公開表示documentのdata属性へ反映する。
 * 変更ルール: 設定値の保存・画面フォーム生成・ゲーム状態変更を行わない。視覚表現そのものはstyles.cssを正本とする。
 */

import { normalizeAppearanceSettings, resolvePublicAppearance } from './appearanceModel.js';

function applyAttributes(element, appearance) {
  if (!element) return;
  element.dataset.theme = appearance.theme;
  element.dataset.accent = appearance.accent;
  element.dataset.fontSize = appearance.fontSize;
  element.dataset.density = appearance.density;
  element.dataset.effects = appearance.effects ? 'on' : 'off';
  element.dataset.motion = appearance.motion;
}

export function applyManagementAppearance(raw, documentRef = document) {
  const settings = normalizeAppearanceSettings(raw);
  applyAttributes(documentRef.documentElement, settings.management);
  return settings;
}

export function applyPublicAppearance(raw, documentRef) {
  const appearance = resolvePublicAppearance(raw);
  applyAttributes(documentRef?.documentElement, appearance);
  return appearance;
}
