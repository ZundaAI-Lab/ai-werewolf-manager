/**
 * 責務: 現在状態からデスクトップ自動復元に必要な保存スナップショットを作り、Renderer側でIPC送信用JSON文字列へ直列化する。
 * 変更ルール: 現在状態と訂正用restorePointsは保持し、セッション内だけで使うUndo／Redo履歴は自動保存へ含めない。完全JSON出力の仕様は変更しない。Mainスレッドで巨大ゲーム状態をJSON.stringifyしないため、デスクトップ自動保存の直列化はここを正本とする。
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

export function serializeAutosaveState(state) {
  try {
    const serialized = JSON.stringify(createAutosaveState(state));
    if (typeof serialized !== 'string') throw new TypeError('自動保存データをJSONへ直列化できません。');
    return serialized;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('自動保存')) throw error;
    throw new TypeError(`自動保存データをJSONへ直列化できません: ${error.message}`);
  }
}
