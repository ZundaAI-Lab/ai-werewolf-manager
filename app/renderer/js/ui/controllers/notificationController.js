/**
 * 責務: 単一トースト、通知履歴、自動実行時の表示抑制と夜間匿名化を所有する。
 * 変更ルール: ゲーム規則を独自実装せず、storeと通知表示領域だけを明示依存として受け取る。通知履歴・表示中トースト・タイマー・抑制深度・採番は本Controllerだけで保持し、AppUIへ内部状態を戻さない。
 */

// @ts-check

import { TOAST_DURATION_MS, normalizeToastType, maskNightActorNames } from './uiStateFormatters.js';

export function createNotificationController({ store, toastRegion }) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('状態Storeがありません。');

  /** @type {Array<Record<string, unknown>>} */
  const notificationHistory = [];
  /** @type {{ element: HTMLDivElement, messageNode: HTMLSpanElement, key: string, type: string } | null} */
  let activeToast = null;
  /** @type {number | null} */
  let activeToastTimer = null;
  let automaticNotificationDepth = 0;
  let nightActorPrivacyDepth = 0;
  let notificationSequence = 0;

  function beginAutomaticNotifications() {
    automaticNotificationDepth += 1;
  }

  function endAutomaticNotifications() {
    automaticNotificationDepth = Math.max(0, automaticNotificationDepth - 1);
  }

  function beginNightActorPrivacy() {
    nightActorPrivacyDepth += 1;
  }

  function endNightActorPrivacy() {
    nightActorPrivacyDepth = Math.max(0, nightActorPrivacyDepth - 1);
  }

  function getNotificationHistory() {
    return notificationHistory.map((item) => ({ ...item }));
  }

  function hasActiveErrorToast() {
    return activeToast?.type === 'error';
  }

  function dismissToast(key = '') {
    if (!activeToast || (key && activeToast.key !== key)) return false;
    if (activeToastTimer !== null) window.clearTimeout(activeToastTimer);
    activeToast.element.remove();
    activeToast = null;
    activeToastTimer = null;
    return true;
  }

  function toast(message, type = 'info', options = {}) {
    const rawText = String(message ?? '').trim();
    if (!rawText) return null;
    const normalizedType = normalizeToastType(type);
    const key = String(options.key ?? '');
    const automatic = automaticNotificationDepth > 0;
    const state = store.getState();
    const concealNightActor = Boolean(options.concealNightActor)
      || ((automatic || nightActorPrivacyDepth > 0) && state?.game?.phase === 'night');
    const text = concealNightActor ? maskNightActorNames(rawText, state) : rawText;
    const blockedByPersistentError = activeToast?.type === 'error'
      && normalizedType !== 'error'
      && !options.replaceError;
    const suppressed = Boolean(options.silent)
      || blockedByPersistentError
      || (automatic && ['success', 'info'].includes(normalizedType) && !options.forceDisplay);
    const historyEntry = {
      id: `notification-${Date.now()}-${notificationSequence += 1}`,
      timestamp: new Date().toISOString(),
      message: text,
      type: normalizedType,
      key,
      source: String(options.source ?? (automatic ? 'automatic' : 'manual')),
      displayed: !suppressed,
    };
    notificationHistory.push(historyEntry);
    if (suppressed || !toastRegion) return historyEntry.id;

    /** @type {HTMLDivElement} */
    let item;
    /** @type {HTMLSpanElement} */
    let messageNode;
    if (!activeToast || !key || activeToast.key !== key) {
      dismissToast();
      item = document.createElement('div');
      messageNode = document.createElement('span');
      messageNode.className = 'toast-message';
      const closeButton = document.createElement('button');
      closeButton.className = 'toast-close';
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', '通知を閉じる');
      closeButton.textContent = '×';
      closeButton.addEventListener('click', () => dismissToast(key));
      item.append(messageNode, closeButton);
      toastRegion.append(item);
    } else {
      item = activeToast.element;
      messageNode = activeToast.messageNode;
    }

    item.className = `toast ${normalizedType}`;
    item.setAttribute('role', normalizedType === 'error' ? 'alert' : 'status');
    item.dataset.toastKey = key;
    messageNode.textContent = text;
    activeToast = { element: item, messageNode, key, type: normalizedType };

    if (activeToastTimer !== null) window.clearTimeout(activeToastTimer);
    const configuredDuration = Number(options.durationMs);
    const durationMs = Number.isFinite(configuredDuration)
      ? Math.max(0, configuredDuration)
      : TOAST_DURATION_MS[normalizedType];
    activeToastTimer = durationMs > 0
      ? window.setTimeout(() => dismissToast(key), durationMs)
      : null;
    return historyEntry.id;
  }

  return Object.freeze({
    beginAutomaticNotifications,
    endAutomaticNotifications,
    beginNightActorPrivacy,
    endNightActorPrivacy,
    getNotificationHistory,
    hasActiveErrorToast,
    dismissToast,
    toast,
  });
}
