/**
 * 責務: Renderer全体で共有する確認・入力ダイアログをHTML dialogで表示し、BrowserWindowのフォーカスを安全に復帰する。
 * 変更ルール: OS/ブラウザネイティブのconfirm/alert/promptへフォールバックしない。ゲーム状態更新や画面固有の判断は持たず、共通#modal-dialogの表示・結果返却・フォーカス復帰だけを担当する。
 */

// @ts-check

function resolveDialog() {
  const dialog = document.querySelector('#modal-dialog');
  return dialog instanceof HTMLDialogElement ? dialog : null;
}

function restoreWindowFocus(previousFocus) {
  window.requestAnimationFrame(() => {
    window.focus();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
  });
}

function prepareDialog(dialog, previousFocus) {
  if (dialog.open) return false;
  dialog.returnValue = 'cancel';
  dialog.addEventListener('close', () => restoreWindowFocus(previousFocus), { once: true });
  return true;
}

export function confirmAppDialog({
  title = '確認',
  message = '',
  confirmLabel = '実行',
  danger = false,
} = {}) {
  const dialog = resolveDialog();
  if (!dialog) return Promise.resolve(false);
  const previousFocus = document.activeElement;
  if (!prepareDialog(dialog, previousFocus)) return Promise.resolve(false);

  dialog.innerHTML = `<form method="dialog">
    <div class="modal-header"><h3 data-app-confirm-title></h3></div>
    <div class="modal-body"><p class="app-dialog-message" data-app-confirm-message></p></div>
    <div class="modal-footer"><button class="button ghost" value="cancel" type="submit">キャンセル</button><button class="button ${danger ? 'danger' : 'primary'}" value="confirm" type="submit" data-app-confirm-submit autofocus></button></div>
  </form>`;
  dialog.querySelector('[data-app-confirm-title]').textContent = String(title ?? '確認');
  const messageElement = /** @type {HTMLElement} */ (dialog.querySelector('[data-app-confirm-message]'));
  messageElement.textContent = String(message ?? '');
  dialog.querySelector('[data-app-confirm-submit]').textContent = String(confirmLabel ?? '実行');

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      dialog.innerHTML = '';
      resolve(accepted);
    }, { once: true });
    dialog.showModal();
  });
}

export function promptAppDialog({
  title = '入力',
  message = '',
  label = '入力',
  initialValue = '',
  placeholder = '',
  confirmLabel = '確定',
  multiline = false,
  required = true,
} = {}) {
  const dialog = resolveDialog();
  if (!dialog) return Promise.resolve(null);
  const previousFocus = document.activeElement;
  if (!prepareDialog(dialog, previousFocus)) return Promise.resolve(null);

  const control = multiline
    ? '<textarea data-app-prompt-input rows="4"></textarea>'
    : '<input data-app-prompt-input type="text">';
  dialog.innerHTML = `<form method="dialog">
    <div class="modal-header"><h3 data-app-prompt-title></h3></div>
    <div class="modal-body"><p class="app-dialog-message" data-app-prompt-message hidden></p><label class="field"><span data-app-prompt-label></span>${control}</label></div>
    <div class="modal-footer"><button class="button ghost" value="cancel" type="submit">キャンセル</button><button class="button primary" value="confirm" type="submit" data-app-prompt-submit></button></div>
  </form>`;
  dialog.querySelector('[data-app-prompt-title]').textContent = String(title ?? '入力');
  const messageElement = /** @type {HTMLElement} */ (dialog.querySelector('[data-app-prompt-message]'));
  const resolvedMessage = String(message ?? '');
  messageElement.textContent = resolvedMessage;
  messageElement.hidden = !resolvedMessage;
  dialog.querySelector('[data-app-prompt-label]').textContent = String(label ?? '入力');
  dialog.querySelector('[data-app-prompt-submit]').textContent = String(confirmLabel ?? '確定');
  const input = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (dialog.querySelector('[data-app-prompt-input]'));
  input.value = String(initialValue ?? '');
  input.placeholder = String(placeholder ?? '');
  input.required = Boolean(required);

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'confirm' ? String(input.value ?? '') : null;
      dialog.innerHTML = '';
      resolve(value);
    }, { once: true });
    dialog.showModal();
    window.requestAnimationFrame(() => {
      input.focus();
      if (typeof input.select === 'function') input.select();
    });
  });
}
