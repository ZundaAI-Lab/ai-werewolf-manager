/**
 * 責務: 現在の配役からCO・構造化能力履歴へ使用できる役職IDを導出し、人間UIとAI JSONで共通使用するCO正規化・遷移検証を提供する。
 * 変更ルール:
 * - 公開発言本文を参照してCOを推定しない。coOperationだけを正本とする。
 * - AI応答の解析、状態更新、文章生成を行わない。
 * - 役職IDを独自に列挙せず、ROLE_DEFINITIONSの属性を正本とする。
 * - 現在の配役に存在しない役職を候補へ含めない。
 */

import { ROLE_DEFINITIONS, ROLE_IDS } from '../../config/constants.js';

export const CO_OPERATION_ACTIONS = Object.freeze(['none', 'declare', 'change', 'withdraw']);

function configuredRoleIds(roleComposition = {}) {
  return ROLE_IDS.filter((roleId) => Number(roleComposition?.[roleId] ?? 0) > 0);
}

export function buildClaimRolePolicy(roleComposition = {}) {
  const presentRoleIds = configuredRoleIds(roleComposition);
  const abilityClaimRoleIds = presentRoleIds.filter((roleId) => (
    ROLE_DEFINITIONS[roleId]?.publicAbilityClaim
  ));
  return Object.freeze({
    coRoleIds: Object.freeze(['none', ...presentRoleIds]),
    abilityClaimRoleIds: Object.freeze(abilityClaimRoleIds),
  });
}

export function isClaimRoleAllowed(policy, roleId) {
  return Boolean(policy?.coRoleIds?.includes(roleId));
}

export function isAbilityClaimRoleAllowed(policy, roleId) {
  return Boolean(policy?.abilityClaimRoleIds?.includes(roleId));
}

export function normalizeCoOperation(value = null) {
  const action = String(value?.action ?? 'none');
  const roleId = action === 'none' || action === 'withdraw'
    ? 'none'
    : String(value?.roleId ?? 'none');
  return { action, roleId };
}

export function validateCoOperationTransition({
  policy,
  activeRoleId = null,
  operation,
} = {}) {
  const normalized = normalizeCoOperation(operation);
  const errors = [];
  if (!CO_OPERATION_ACTIONS.includes(normalized.action)) {
    errors.push(`coOperation.actionは ${CO_OPERATION_ACTIONS.join(' / ')} のいずれかで指定してください。`);
    return { ok: false, errors, operation: normalized };
  }
  if (!isClaimRoleAllowed(policy, normalized.roleId)) {
    errors.push(`coOperation.roleIdは ${policy?.coRoleIds?.join(' / ') ?? 'none'} のいずれかで指定してください。`);
    return { ok: false, errors, operation: normalized };
  }
  if (normalized.action === 'none') return { ok: true, errors, operation: normalized };
  if (normalized.action === 'declare' && activeRoleId) {
    errors.push(`すでに${activeRoleId}でCO中です。COを変更する場合はaction: changeを使用してください。`);
  }
  if (normalized.action === 'change') {
    if (!activeRoleId) errors.push('現在COしていません。新しくCOする場合はaction: declareを使用してください。');
    else if (activeRoleId === normalized.roleId) errors.push('現在と同じ役職への変更はできません。action: noneを使用してください。');
  }
  if (normalized.action === 'withdraw' && !activeRoleId) {
    errors.push('撤回できる有効なCOがありません。');
  }
  return { ok: errors.length === 0, errors, operation: normalized };
}
