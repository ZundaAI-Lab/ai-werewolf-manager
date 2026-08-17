/**
 * 責務: 日本語IMEなどの文字合成中に全画面再描画を保留し、合成終了後に保留済み描画を一度だけ再開する状態を管理する。
 * 変更ルール: DOM描画、入力値保存、フォーカス復元は行わない。AppUIはcompositionイベントとrender要求をこの状態へ通知し、描画実行可否だけを受け取る。
 */

export function createRenderCompositionState() {
  return {
    isComposing: false,
    renderPending: false,
  };
}

export function beginRenderComposition(state) {
  state.isComposing = true;
}

export function deferRenderWhileComposing(state) {
  if (!state.isComposing) return false;
  state.renderPending = true;
  return true;
}

export function endRenderComposition(state) {
  const shouldRender = Boolean(state.isComposing && state.renderPending);
  state.isComposing = false;
  state.renderPending = false;
  return shouldRender;
}
