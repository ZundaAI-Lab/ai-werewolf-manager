/**
 * 責務: app/shared/entityIdPolicy.jsの共有契約をRenderer ES Moduleへ接続する。
 * 変更ルール: ID規則や文言を複製しない。共有スクリプトはbundleより前に読み込み、契約欠落時は起動を明示的に失敗させる。
 */

import * as sharedPolicyModule from '../../../../shared/entityIdPolicy.js';

const policy = sharedPolicyModule.default ?? globalThis.AiWerewolfEntityIdPolicy;
if (!policy) throw new Error('共有エンティティIDポリシーを読み込めませんでした。');

export const {
  ENTITY_ID_MAX_LENGTH,
  ENTITY_ID_PATTERN,
  isValidEntityId,
  requireEntityId,
  validateEntityId,
} = policy;
