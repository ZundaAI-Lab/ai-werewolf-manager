/**
 * 責務: 現在状態からデスクトップ自動復元に必要な保存スナップショットを作る。
 * 変更ルール: 現在状態と訂正用restorePointsは保持し、セッション内だけで使うUndo／Redo履歴は自動保存へ含めない。完全JSON出力の仕様は変更しない。
 */

export function createAutosaveState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('自動保存対象のゲーム状態が不正です。');
  }
  return {
    ...state,
    undoStack: [],
    redoStack: [],
  };
}
