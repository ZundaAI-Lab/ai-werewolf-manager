/**
 * 責務: Electron Main・Rendererで共有するエンティティIDの文字種・長さ・予約語制約を一元提供する。
 * 変更ルール: ID生成、参照先確認、保存、DOM操作を行わない。受理条件とエラーメッセージは本モジュールだけで変更し、Main境界とRenderer状態検証の双方で同じAPIを使用する。
 */

(function initializeEntityIdPolicy(root, factory) {
  'use strict';

  const api = factory();
  const commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfEntityIdPolicy = api;
    if (root.window && root.window !== root) root.window.AiWerewolfEntityIdPolicy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const ENTITY_ID_MAX_LENGTH = 128;
  const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
  const RESERVED_ENTITY_IDS = new Set(['__proto__', 'constructor', 'prototype']);

  function validationMessage(label) {
    return `${label}は半角英数字で始まる${ENTITY_ID_MAX_LENGTH}文字以内の英数字・ピリオド・ハイフン・アンダースコア・コロンで指定してください。`;
  }

  function isValidEntityId(value) {
    return typeof value === 'string'
      && ENTITY_ID_PATTERN.test(value)
      && !RESERVED_ENTITY_IDS.has(value);
  }

  function requireEntityId(value, label = 'ID') {
    const id = String(value ?? '').trim();
    if (!isValidEntityId(id)) throw new RangeError(validationMessage(label));
    return id;
  }

  function validateEntityId(value, label = 'ID') {
    return isValidEntityId(value) ? [] : [validationMessage(label)];
  }

  return Object.freeze({
    ENTITY_ID_MAX_LENGTH,
    ENTITY_ID_PATTERN,
    isValidEntityId,
    requireEntityId,
    validateEntityId,
  });
});
