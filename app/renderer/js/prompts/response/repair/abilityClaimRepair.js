/**
 * 責務: 任意能力結果主張のキー、対象名、根拠参照、時点理由を公開可能範囲へ補正する。
 * 変更ルール: 能力結果そのものを推定・生成せず、入力済み主張の形式と参照だけを扱う。
 */

import {
  getAbilityEvidenceWindow,
  getUnlistedAbilityReasonSequences,
} from '../../../domain/policies/abilityClaimTimelinePolicy.js';
import { resolvePublicAbilityClaimRequirements } from '../../../domain/policies/publicAbilityClaimPolicy.js';
import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';
import {
  deepEqual,
  normalizeEnumField,
  normalizePositiveIntegerRefs,
  removeNullOptionalFields,
  repairExactKeys,
  resolvePlayer,
  uniqueBy,
} from './repairUtilities.js';

function repairAbilityClaims(state, payload, operations) {
  if (!Object.hasOwn(payload, 'abilityClaims')) return;
  if (isPlainObject(payload.abilityClaims)) {
    payload.abilityClaims = [payload.abilityClaims];
    operation(operations, 'SINGLE_VALUE_WRAPPED', 'abilityClaims', '単一能力結果をabilityClaims配列へ変換しました。');
  }
  if (!Array.isArray(payload.abilityClaims)) {
    delete payload.abilityClaims;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'abilityClaims', '配列でないabilityClaimsを省略しました。');
    return;
  }
  payload.abilityClaims = payload.abilityClaims.filter(isPlainObject).map((claim, index) => {
    const path = `abilityClaims[${index}]`;
    repairExactKeys(claim, path, ['roleId', 'resultDay', 'target', 'result', 'selectionBasis', 'evidenceEventSequences', 'selectionReasonAtTime'], operations);
    removeNullOptionalFields(claim, ['roleId', 'resultDay', 'target', 'result'], path, operations);
    normalizeEnumField(claim, 'roleId', path, operations);
    normalizeEnumField(claim, 'result', path, operations);
    normalizeEnumField(claim, 'selectionBasis', path, operations);
    if (typeof claim.resultDay === 'string' && /^\d+$/u.test(claim.resultDay.trim())) {
      claim.resultDay = Number(claim.resultDay);
      operation(operations, 'NUMBER_STRING_NORMALIZED', `${path}.resultDay`, `${path}.resultDayを整数へ変換しました。`);
    }
    if (typeof claim.target === 'string') {
      const player = resolvePlayer(state, claim.target);
      if (player && player.name !== claim.target) {
        claim.target = player.name;
        operation(operations, 'PLAYER_REFERENCE_CANONICALIZED', `${path}.target`, `${path}.targetを正式表示名へ修正しました。`);
      }
    }
    normalizePositiveIntegerRefs(claim, 'evidenceEventSequences', path, operations);
    const requiredKeys = ['roleId', 'resultDay', 'target', 'result'];
    if (requiredKeys.some((key) => !Object.hasOwn(claim, key) || claim[key] === null || claim[key] === '')) {
      operation(operations, 'INCOMPLETE_OPTIONAL_ITEM_REMOVED', path, `${path}は能力結果を確定できないため省略しました。`);
      return null;
    }
    if (claim.roleId === 'medium' && Number.isInteger(claim.resultDay) && typeof claim.target === 'string') {
      const target = resolvePlayer(state, claim.target);
      const requirements = target ? resolvePublicAbilityClaimRequirements(state, {
        roleId: 'medium', observedDay: claim.resultDay, targetId: target.id,
      }) : null;
      if (requirements?.requiredEvidenceRefs?.length) {
        claim.selectionBasis = 'rule-forced';
        claim.evidenceEventSequences = [...requirements.requiredEvidenceRefs];
        delete claim.selectionReasonAtTime;
        operation(operations, 'MEDIUM_TIMELINE_NORMALIZED', path, '霊能結果の選定根拠を対応する処刑履歴へ固定しました。');
      }
    } else {
      const allowedRefs = new Set(getAbilityEvidenceWindow(state, claim.resultDay).map((event) => Number(event.sequence)));
      if (Array.isArray(claim.evidenceEventSequences)) {
        const validRefs = claim.evidenceEventSequences.filter((ref) => allowedRefs.has(Number(ref)));
        if (!deepEqual(validRefs, claim.evidenceEventSequences)) {
          claim.evidenceEventSequences = validRefs;
          operation(operations, 'INVALID_ABILITY_EVENT_SEQUENCES_REMOVED', `${path}.evidenceEventSequences`, '能力決定時点で利用できない公開参照を除外しました。');
        }
      }
      if (['guard', 'namahage', 'snowWoman'].includes(claim.roleId) && claim.result !== 'unknown') {
        claim.result = 'unknown';
        operation(operations, 'UNOBSERVABLE_RESULT_NORMALIZED', `${path}.result`, '個別成否が通知されない役職のresultをunknownへ固定しました。');
      }
      if (claim.selectionBasis === 'public-evidence' && !(claim.evidenceEventSequences?.length)) {
        claim.selectionBasis = 'no-public-information';
        operation(operations, 'SELECTION_BASIS_NORMALIZED', `${path}.selectionBasis`, '有効な公開参照がないためselectionBasisをno-public-informationへ修正しました。');
      }
      if (claim.selectionBasis === 'no-public-information' && claim.evidenceEventSequences?.length) {
        claim.selectionBasis = 'public-evidence';
        operation(operations, 'SELECTION_BASIS_NORMALIZED', `${path}.selectionBasis`, '有効な公開参照があるためselectionBasisをpublic-evidenceへ修正しました。');
      }
      const unlistedReasonSequences = getUnlistedAbilityReasonSequences(claim.selectionReasonAtTime, claim.evidenceEventSequences);
      if (unlistedReasonSequences.length) {
        delete claim.selectionReasonAtTime;
        operation(operations, 'INVALID_ABILITY_REASON_REFERENCES_REMOVED', `${path}.selectionReasonAtTime`, `構造化根拠にない公開番号（${unlistedReasonSequences.map((sequence) => `#${sequence}`).join('、')}）を含む選定理由を未入力化しました。`);
      }
    }
    return claim;
  }).filter(Boolean);
  payload.abilityClaims = uniqueBy(payload.abilityClaims, (claim) => JSON.stringify(claim));
  if (!payload.abilityClaims.length) {
    delete payload.abilityClaims;
    operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'abilityClaims', '公開対象がないabilityClaimsを省略しました。');
  }
}


export { repairAbilityClaims };
