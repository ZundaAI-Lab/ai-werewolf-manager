/**
 * 責務: AppUIの全体再描画をまたいで、画面スクロール位置と編集中のdata-draft入力欄のフォーカス、選択範囲、入力欄内スクロール位置を保存・復元する。
 * 変更ルール: DOMの再描画やdraft値の保存は行わない。画面スクロールは常に対象とし、入力要素はdata-draftを持つ場合だけ復元する。タブ切替など別画面へ遷移して同じ入力欄が存在しない場合は画面スクロールだけを復元する。
 */

function selectionValue(control, key) {
  const raw = control?.[key];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function scrollValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function captureRenderFocusState(root, activeElement = document.activeElement, viewKey = '') {
  if (!root) return null;
  const state = {
    viewKey: String(viewKey ?? ''),
    rootScrollTop: scrollValue(root.scrollTop),
    rootScrollLeft: scrollValue(root.scrollLeft),
    draftKey: '',
    selectionStart: null,
    selectionEnd: null,
    selectionDirection: 'none',
    scrollTop: 0,
    scrollLeft: 0,
  };
  if (!activeElement || !root.contains(activeElement)) return state;
  const draftKey = String(activeElement.dataset?.draft ?? '');
  if (!draftKey) return state;
  return {
    ...state,
    draftKey,
    selectionStart: selectionValue(activeElement, 'selectionStart'),
    selectionEnd: selectionValue(activeElement, 'selectionEnd'),
    selectionDirection: typeof activeElement.selectionDirection === 'string' ? activeElement.selectionDirection : 'none',
    scrollTop: scrollValue(activeElement.scrollTop),
    scrollLeft: scrollValue(activeElement.scrollLeft),
  };
}

function restoreRootScroll(root, focusState) {
  root.scrollTop = scrollValue(focusState?.rootScrollTop);
  root.scrollLeft = scrollValue(focusState?.rootScrollLeft);
}

export function restoreRenderFocusState(root, focusState, viewKey = '') {
  if (!root || !focusState) return false;
  const normalizedViewKey = String(viewKey ?? '');
  if (focusState.viewKey && normalizedViewKey && focusState.viewKey !== normalizedViewKey) return false;
  let restoredFocus = false;
  if (focusState.draftKey) {
    const control = [...root.querySelectorAll('[data-draft]')]
      .find((item) => String(item.dataset?.draft ?? '') === focusState.draftKey);
    if (control && typeof control.focus === 'function') {
      try {
        control.focus({ preventScroll: true });
      } catch {
        control.focus();
      }
      if (focusState.selectionStart !== null
        && focusState.selectionEnd !== null
        && typeof control.setSelectionRange === 'function') {
        const length = String(control.value ?? '').length;
        const start = Math.min(focusState.selectionStart, length);
        const end = Math.min(Math.max(start, focusState.selectionEnd), length);
        try {
          control.setSelectionRange(start, end, focusState.selectionDirection);
        } catch {
          // checkbox等、メソッドを持っていても選択範囲を扱えない入力種別ではフォーカスだけ復元する。
        }
      }
      control.scrollTop = scrollValue(focusState.scrollTop);
      control.scrollLeft = scrollValue(focusState.scrollLeft);
      restoredFocus = true;
    }
  }
  restoreRootScroll(root, focusState);
  return restoredFocus;
}
