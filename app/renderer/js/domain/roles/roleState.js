/**
 * 責務: 役職固有状態の初期形と、能力選択時に確定する直前対象・家主情報の更新を提供する。
 * 変更ルール: 勝敗・対象可否・夜解決を判定しない。訪問と凍結は共通の直前対象制約を使い、旧来の永久対象履歴を残さない。
 */

export function createRoleState(roleId, overrides = null) {
  const source = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  if (roleId === 'namahage') {
    return { lastTargetId: source.lastTargetId ?? null };
  }
  if (roleId === 'snowWoman') {
    return { lastTargetId: source.lastTargetId ?? null };
  }
  if (roleId === 'zashikiWarashi') {
    return {
      ownerId: source.ownerId ?? null,
      ownerRoleId: source.ownerRoleId ?? null,
      resolvedTeam: source.resolvedTeam ?? null,
    };
  }
  return null;
}

export function markRoleActionSelected(player, actionType, target, team = null) {
  if (!player) return;
  if (actionType === 'visit' || actionType === 'freeze') {
    player.roleState ??= createRoleState(actionType === 'visit' ? 'namahage' : 'snowWoman');
    player.roleState.lastTargetId = target.id;
    return;
  }
  if (actionType === 'choose-owner') {
    player.roleState ??= createRoleState('zashikiWarashi');
    player.roleState.ownerId = target.id;
    player.roleState.ownerRoleId = target.roleId;
    player.roleState.resolvedTeam = team;
  }
}
