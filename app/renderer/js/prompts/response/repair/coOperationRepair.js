/**
 * 責務: 任意CO操作を現在の公開CO状態と役職構成に照らして補正する。
 * 変更ルール: 新しいCO意思決定を生成せず、表記・既存状態・公開配役構成から得た許可役職だけを検査する。役職IDは許可役職集合からcanonical IDへ正規化し、役職欠け後の実配役を公開CO補正へ使用しない。
 */

import { buildClaimRolePolicy } from '../../../domain/claims/claimRolePolicy.js';
import { getPublicRoleComposition } from '../../../domain/roles/roleComposition.js';
import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';
import {
  normalizeEnumField,
  removeNullOptionalFields,
  repairExactKeys,
} from './repairUtilities.js';

function repairCoOperation(state, playerId, payload, operations) {
  if (!Object.hasOwn(payload, 'coOperation')) return;
  if (!isPlainObject(payload.coOperation)) {
    delete payload.coOperation;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'coOperation', 'オブジェクトでないcoOperationを省略しました。');
    return;
  }
  const value = repairExactKeys(payload.coOperation, 'coOperation', ['action', 'roleId'], operations);
  removeNullOptionalFields(value, [], 'coOperation', operations);
  normalizeEnumField(value, 'action', 'coOperation', operations);
  const allowedRoleIds = new Set(buildClaimRolePolicy(getPublicRoleComposition(state)).coRoleIds.filter((roleId) => roleId !== 'none'));
  const roleIdAliases = new Map([...allowedRoleIds].map((roleId) => [String(roleId).trim().toLowerCase(), roleId]));
  normalizeEnumField(value, 'roleId', 'coOperation', operations, roleIdAliases);
  const action = String(value.action ?? '');
  if (!['declare', 'change', 'withdraw'].includes(action)) {
    delete payload.coOperation;
    operation(operations, 'INCOMPLETE_OPTIONAL_SECTION_REMOVED', 'coOperation', '有効なCO操作ではないためcoOperationを省略しました。');
    return;
  }
  const activeRoleId = state.claims?.find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId ?? null;
  if (action === 'withdraw') {
    if (Object.hasOwn(value, 'roleId')) {
      delete value.roleId;
      operation(operations, 'UNNEEDED_OPTIONAL_FIELD_REMOVED', 'coOperation.roleId', 'withdrawでは不要なroleIdを省略しました。');
    }
    if (!activeRoleId) {
      delete payload.coOperation;
      operation(operations, 'REDUNDANT_CO_OPERATION_REMOVED', 'coOperation', '撤回対象がないwithdrawを省略しました。');
    }
    return;
  }
  if (!String(value.roleId ?? '').trim()) {
    delete payload.coOperation;
    operation(operations, 'INCOMPLETE_OPTIONAL_SECTION_REMOVED', 'coOperation', '役職を確定できないCO操作を省略しました。');
    return;
  }
  if (!allowedRoleIds.has(String(value.roleId))) {
    delete payload.coOperation;
    operation(operations, 'INVALID_CO_ROLE_REMOVED', 'coOperation', '現在許可されないCO役職の操作を省略しました。');
    return;
  }
  if (action === 'declare' && activeRoleId) {
    if (activeRoleId === value.roleId) {
      delete payload.coOperation;
      operation(operations, 'REDUNDANT_CO_OPERATION_REMOVED', 'coOperation', '現在と同一のCO宣言を省略しました。');
    } else {
      value.action = 'change';
      operation(operations, 'CO_TRANSITION_NORMALIZED', 'coOperation.action', '現在のCO状態に合わせてdeclareをchangeへ補正しました。');
    }
  } else if (action === 'change' && !activeRoleId) {
    value.action = 'declare';
    operation(operations, 'CO_TRANSITION_NORMALIZED', 'coOperation.action', '未CO状態のchangeをdeclareへ補正しました。');
  } else if (action === 'change' && activeRoleId === value.roleId) {
    delete payload.coOperation;
    operation(operations, 'REDUNDANT_CO_OPERATION_REMOVED', 'coOperation', '現在と同一役職へのchangeを省略しました。');
  }
}


export { repairCoOperation };
