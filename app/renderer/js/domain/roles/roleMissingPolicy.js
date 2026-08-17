/**
 * 責務: 役職欠けルールで欠け候補にできる役職を判定する。
 * 変更ルール: 欠け対象の選択・役職変更・公開情報生成は行わない。村人を含め、人狼系(roleClass=wolf)以外を欠け候補とする。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';

export function canRoleBeMissing(roleId) {
  const role = ROLE_DEFINITIONS[String(roleId ?? '')];
  return Boolean(role && role.roleClass !== 'wolf');
}

export function getRoleMissingCandidates(players = []) {
  return (players ?? []).filter((player) => canRoleBeMissing(player?.roleId));
}
