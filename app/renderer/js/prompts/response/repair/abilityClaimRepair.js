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
    normalizeEnumField(claim, 'intent', path, operations);
    if (!['truthful', 'deception'].includes(claim.intent)) {
      operation(operations, 'INCOMPLETE_OPTIONAL_ITEM_REMOVED', path, `${path}.intentがtruthful/deceptionではないため省略しました。`);
      return null;
    }

    if (claim.intent === 'truthful') {
      repairExactKeys(claim, path, ['intent', 'sourceRef', 'selectionBasis', 'evidenceRefs', 'selectionReasonAtTime'], operations);
      if (typeof claim.sourceRef === 'string' && /^\d+$/u.test(claim.sourceRef.trim())) {
        claim.sourceRef = Number(claim.sourceRef);
        operation(operations, 'NUMBER_STRING_NORMALIZED', `${path}.sourceRef`, `${path}.sourceRefを整数へ変換しました。`);
      }
      if (!Number.isInteger(claim.sourceRef) || claim.sourceRef < 1) {
        operation(operations, 'INCOMPLETE_OPTIONAL_ITEM_REMOVED', path, `${path}.sourceRefが有効なP#番号ではないため省略しました。`);
        return null;
      }
      normalizeEnumField(claim, 'selectionBasis', path, operations);
      normalizePositiveIntegerRefs(claim, 'evidenceRefs', path, operations);
      if (claim.selectionBasis === 'public-evidence' && !(claim.evidenceRefs?.length)) {
        claim.selectionBasis = 'no-public-information';
        operation(operations, 'SELECTION_BASIS_NORMALIZED', `${path}.selectionBasis`, '有効な公開参照がないためselectionBasisをno-public-informationへ修正しました。');
      }
      if (claim.selectionBasis === 'no-public-information' && claim.evidenceRefs?.length) {
        claim.selectionBasis = 'public-evidence';
        operation(operations, 'SELECTION_BASIS_NORMALIZED', `${path}.selectionBasis`, '有効な公開参照があるためselectionBasisをpublic-evidenceへ修正しました。');
      }
      return claim;
    }

    repairExactKeys(claim, path, ['intent', 'roleId', 'actionDay', 'actionPhase', 'availableDay', 'availablePhase', 'target', 'result', 'selectionBasis', 'evidenceRefs', 'selectionReasonAtTime'], operations);
    removeNullOptionalFields(claim, ['roleId', 'actionDay', 'actionPhase', 'availableDay', 'availablePhase', 'target', 'result'], path, operations);
    normalizeEnumField(claim, 'roleId', path, operations);
    normalizeEnumField(claim, 'result', path, operations);
    normalizeEnumField(claim, 'selectionBasis', path, operations);
    for (const key of ['actionDay', 'availableDay']) {
      if (typeof claim[key] === 'string' && /^\d+$/u.test(claim[key].trim())) {
        claim[key] = Number(claim[key]);
        operation(operations, 'NUMBER_STRING_NORMALIZED', `${path}.${key}`, `${path}.${key}を整数へ変換しました。`);
      }
    }
    normalizeEnumField(claim, 'actionPhase', path, operations);
    normalizeEnumField(claim, 'availablePhase', path, operations);
    if (typeof claim.target === 'string') {
      const player = resolvePlayer(state, claim.target);
      if (player && player.name !== claim.target) {
        claim.target = player.name;
        operation(operations, 'PLAYER_REFERENCE_CANONICALIZED', `${path}.target`, `${path}.targetを正式表示名へ修正しました。`);
      }
    }
    normalizePositiveIntegerRefs(claim, 'evidenceRefs', path, operations);
    const requiredKeys = ['roleId', 'actionDay', 'actionPhase', 'availableDay', 'availablePhase', 'target', 'result'];
    if (requiredKeys.some((key) => !Object.hasOwn(claim, key) || claim[key] === null || claim[key] === '')) {
      operation(operations, 'INCOMPLETE_OPTIONAL_ITEM_REMOVED', path, `${path}は騙り能力結果を確定できないため省略しました。`);
      return null;
    }
    if (claim.roleId === 'medium' && Number.isInteger(claim.actionDay) && typeof claim.target === 'string') {
      const target = resolvePlayer(state, claim.target);
      const requirements = target ? resolvePublicAbilityClaimRequirements(state, {
        roleId: 'medium', actionDay: claim.actionDay, targetId: target.id,
      }) : null;
      if (requirements?.requiredEvidenceRefs?.length) {
        claim.selectionBasis = 'rule-forced';
        claim.evidenceRefs = [...requirements.requiredEvidenceRefs];
        delete claim.selectionReasonAtTime;
        operation(operations, 'MEDIUM_TIMELINE_NORMALIZED', path, '霊能結果の選定根拠を対応する処刑履歴へ固定しました。');
      }
    } else {
      const allowedRefs = new Set(getAbilityEvidenceWindow(state, claim.actionDay).map((event) => Number(event.sequence)));
      if (Array.isArray(claim.evidenceRefs)) {
        const validRefs = claim.evidenceRefs.filter((ref) => allowedRefs.has(Number(ref)));
        if (!deepEqual(validRefs, claim.evidenceRefs)) {
          claim.evidenceRefs = validRefs;
          operation(operations, 'INVALID_ABILITY_EVENT_SEQUENCES_REMOVED', `${path}.evidenceRefs`, '能力決定時点で利用できない公開参照を除外しました。');
        }
      }
      if (['guard', 'namahage', 'snowWoman'].includes(claim.roleId) && claim.result !== 'unknown') {
        claim.result = 'unknown';
        operation(operations, 'UNOBSERVABLE_RESULT_NORMALIZED', `${path}.result`, '個別成否が通知されない役職のresultをunknownへ固定しました。');
      }
      if (claim.selectionBasis === 'public-evidence' && !(claim.evidenceRefs?.length)) {
        claim.selectionBasis = 'no-public-information';
        operation(operations, 'SELECTION_BASIS_NORMALIZED', `${path}.selectionBasis`, '有効な公開参照がないためselectionBasisをno-public-informationへ修正しました。');
      }
      if (claim.selectionBasis === 'no-public-information' && claim.evidenceRefs?.length) {
        claim.selectionBasis = 'public-evidence';
        operation(operations, 'SELECTION_BASIS_NORMALIZED', `${path}.selectionBasis`, '有効な公開参照があるためselectionBasisをpublic-evidenceへ修正しました。');
      }
      const unlistedReasonSequences = getUnlistedAbilityReasonSequences(claim.selectionReasonAtTime, claim.evidenceRefs);
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
