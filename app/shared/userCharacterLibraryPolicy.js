/**
 * 責務: Electron Main・Rendererで共有するユーザーキャラクターライブラリJSONの総サイズ上限を一元提供する。
 * 変更ルール: キャラクター内容のschema検証・文字数検証・保存・DOM操作を行わない。ライブラリ全体の転送・保存サイズ上限は本モジュールだけを正本とする。
 */

(function initializeUserCharacterLibraryPolicy(root, factory) {
  'use strict';

  const api = factory();
  const commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfUserCharacterLibraryPolicy = api;
    if (root.window && root.window !== root) root.window.AiWerewolfUserCharacterLibraryPolicy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const USER_CHARACTER_LIBRARY_MAX_BYTES = 8 * 1024 * 1024;

  function serializedByteLength(serialized) {
    return new TextEncoder().encode(String(serialized ?? '')).byteLength;
  }

  function assertUserCharacterLibrarySerializedSize(serialized, label = 'ユーザーキャラクターJSON') {
    const bytes = serializedByteLength(serialized);
    if (bytes > USER_CHARACTER_LIBRARY_MAX_BYTES) {
      throw new RangeError(`${label}は${USER_CHARACTER_LIBRARY_MAX_BYTES / (1024 * 1024)}MB以下にしてください。`);
    }
    return bytes;
  }

  return Object.freeze({
    USER_CHARACTER_LIBRARY_MAX_BYTES,
    serializedByteLength,
    assertUserCharacterLibrarySerializedSize,
  });
});
