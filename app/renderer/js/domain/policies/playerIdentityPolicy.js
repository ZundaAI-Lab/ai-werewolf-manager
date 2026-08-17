/**
 * 責務: プレイヤー表示名、別名、相手別呼称について、共有characterTextPolicyの機械解析向け入力条件をゲーム側APIとして公開する。
 * 変更ルール: 入力内容を黙って変換しない。文字数上限・禁則文字・予約語は共有characterTextPolicyを正本とし、本モジュールへ重複定義しない。性格文や発言本文には適用しない。
 */

import {
  CHARACTER_TEXT_LIMITS,
  validateCharacterAlias,
  validateCharacterCallName,
  validateCharacterDisplayName,
} from '../../characters/config/characterTextPolicyAdapter.js';

export const PLAYER_NAME_MAX_LENGTH = CHARACTER_TEXT_LIMITS.name;
export const CALL_NAME_MAX_LENGTH = CHARACTER_TEXT_LIMITS.callNamePreferred;

function result(value, errors) {
  return {
    ok: errors.length === 0,
    errors,
    value: String(value ?? '').trim(),
  };
}

export function validatePlayerDisplayName(value) {
  return result(value, validateCharacterDisplayName(value, { label: '表示名' }));
}

export function validatePlayerAlias(value) {
  return result(value, validateCharacterAlias(value, { label: '別名' }));
}

export function validateCallName(value, { allowEmpty = false } = {}) {
  return result(value, validateCharacterCallName(value, { label: '呼称', allowEmpty }));
}
