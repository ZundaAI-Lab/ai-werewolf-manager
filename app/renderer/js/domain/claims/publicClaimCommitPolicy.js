/**
 * 責務: 公開発言に付随するCO操作と能力結果主張を、通常発言・回答優先発言で共通の規則により正規化・検証する。
 * 変更ルール: ゲーム状態を更新せず、公開発言本文・質問関連・通常進行を扱わない。CO候補は公開配役構成からclaimRolePolicyで決定し、役職欠け後の実配役を公開判定へ混入させない。能力結果の形式・時系列・対象制約はpublicAbilityClaimPolicyを唯一の正本とする。
 */

import { buildClaimRolePolicy, normalizeCoOperation, validateCoOperationTransition } from './claimRolePolicy.js';
import { getPublicRoleComposition } from '../roles/roleComposition.js';
import {
  getPublicAbilityClaimDefinition,
  resolvePublicAbilityClaimRequirements,
  validatePublicAbilityClaim,
} from '../policies/publicAbilityClaimPolicy.js';

function activeClaimRoleId(state, playerId) {
  return (state.claims ?? []).find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId ?? null;
}

function normalizeAbilityClaim(state, playerId, claim, claimedRoleAfter) {
  const claimedRoleId = claim.claimedRoleId ?? claim.roleId ?? claimedRoleAfter;
  const actionDay = Number(claim.actionDay);
  const targetId = claim.targetId ?? null;
  const forced = resolvePublicAbilityClaimRequirements(state, {
    roleId: claimedRoleId,
    actionDay,
    targetId,
  });
  return {
    action: 'publish',
    actorId: playerId,
    claimedRoleId,
    actionType: claim.actionType ?? getPublicAbilityClaimDefinition(claimedRoleId)?.actionType ?? null,
    targetId,
    result: claim.result,
    actionDay,
    actionPhase: String(claim.actionPhase ?? ''),
    availableDay: Number(claim.availableDay),
    availablePhase: String(claim.availablePhase ?? ''),
    selectionBasis: claimedRoleId === 'medium'
      ? forced.selectionBasis
      : String(claim.selectionBasis ?? ''),
    evidenceEventIds: claimedRoleId === 'medium'
      ? [...forced.requiredEvidenceEventIds]
      : [...(claim.evidenceEventIds ?? [])],
    selectionReasonAtTime: claimedRoleId === 'medium'
      ? ''
      : String(claim.selectionReasonAtTime ?? '').trim(),
  };
}

export function resolvePublicClaimCommit(state, {
  playerId,
  coOperation = null,
  abilityClaims = [],
} = {}) {
  const activeBefore = activeClaimRoleId(state, playerId);
  const coValidation = validateCoOperationTransition({
    policy: buildClaimRolePolicy(getPublicRoleComposition(state)),
    activeRoleId: activeBefore,
    operation: normalizeCoOperation(coOperation),
  });
  if (!coValidation.ok) {
    return {
      ok: false,
      errors: [...coValidation.errors],
      operation: coValidation.operation,
      activeRoleAfter: activeBefore,
      abilityClaims: [],
    };
  }

  const operation = coValidation.operation;
  let activeRoleAfter = activeBefore;
  if (['declare', 'change'].includes(operation.action)) activeRoleAfter = operation.roleId;
  if (operation.action === 'withdraw') activeRoleAfter = null;

  const normalizedClaims = (abilityClaims ?? [])
    .filter((claim) => claim?.targetId && claim?.result)
    .map((claim) => normalizeAbilityClaim(state, playerId, claim, activeRoleAfter));
  const errors = [];
  if (normalizedClaims.length && !activeRoleAfter) {
    errors.push('能力結果を公開する場合は、同じ発言までに対応する役職をCOしてください。');
  }
  if (normalizedClaims.some((claim) => claim.claimedRoleId !== activeRoleAfter)) {
    errors.push('能力結果主張の役職と発言後に有効となるCO役職が一致していません。');
  }

  const validatedClaims = [];
  normalizedClaims.forEach((claim) => {
    errors.push(...validatePublicAbilityClaim(state, {
      actorId: playerId,
      claim,
      activeRoleId: activeRoleAfter,
      announcedDay: state.game.day,
      additionalClaims: validatedClaims,
    }));
    validatedClaims.push(claim);
  });

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    operation,
    activeRoleAfter,
    abilityClaims: errors.length ? [] : normalizedClaims,
  };
}
