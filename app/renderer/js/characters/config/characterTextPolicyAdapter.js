/**
 * 責務: app/shared/characterTextPolicy.jsの共有文字数・識別文字列契約をRenderer ES Moduleへ接続する。
 * 変更ルール: 制限値・禁則文字・検証文言を複製しない。Main・UI・JSON検証・AI生成は共有契約の同じ値を参照する。
 */

import * as sharedPolicyModule from '../../../../shared/characterTextPolicy.js';

const policy = sharedPolicyModule.default ?? globalThis.AiWerewolfCharacterTextPolicy;
if (!policy) throw new Error('共有キャラクター文字数ポリシーを読み込めませんでした。');

export const {
  CHARACTER_TEXT_LIMITS,
  CHARACTER_TEXT_TARGETS,
  CHARACTER_TEXT_FIELDS,
  textLength,
  delimitedInputMaxLength,
  validateTextLength,
  validateIdentityText,
  validateCharacterDisplayName,
  validateCharacterAlias,
  validateCharacterCallName,
  validateCharacterTextPayload,
  requireCharacterTextPayload,
} = policy;
