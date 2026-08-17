/**
 * 責務: 状態検証で共有する列挙集合、ID検査、厳密形状検査、判断差分・人狼共有戦略差分の検査を提供する。
 * 変更ルール: 状態を修正せず、許可値は各ドメイン定義を正本とする。領域固有の進行検査を追加しない。
 */

import { PUBLIC_ABILITY_ROLE_IDS } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { ABILITY_SELECTION_BASES } from '../../domain/policies/abilityClaimTimelinePolicy.js';
import {
  DECISION_ASSESSMENT_LEVELS,
  DECISION_GROUNDING_CAUSES,
} from '../../domain/game/decisionState.js';
import {
  PARTNER_DISPOSITION_VALUES_SOLO,
  PARTNER_DISPOSITION_VALUES_WITH_PARTNER,
} from '../../domain/game/wolfPartnerDispositionPolicy.js';
import { validateEntityId } from '../../domain/policies/entityIdPolicyAdapter.js';


export const WOLF_CONVERSATION_PURPOSES = new Set(['opening-strategy', 'opening-strategy-and-attack', 'attack-planning']);
export const DECISION_ASSESSMENT_LEVEL_SET = new Set(DECISION_ASSESSMENT_LEVELS);
export const PUBLIC_ABILITY_ROLE_ID_SET = new Set(PUBLIC_ABILITY_ROLE_IDS);
export const ABILITY_SELECTION_BASE_SET = new Set(ABILITY_SELECTION_BASES);
export const CLAIM_STATUSES = new Set(['active', 'withdrawn', 'voided']);
export const ABILITY_STATUSES = new Set(['active', 'voided']);
export const DISCUSSION_ROUND_KINDS = new Set(['normal', 'targeted-response', 'gm-designated']);
export const WOLF_SHARED_STRATEGY_KEYS = ['claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan', 'collapsePlan', 'discussionPlan', 'attackPlan'];
export const WOLF_PARTNER_DISPOSITION_SET = new Set([...PARTNER_DISPOSITION_VALUES_WITH_PARTNER, ...PARTNER_DISPOSITION_VALUES_SOLO]);

export const DECISION_CHANGED_FIELDS = new Set(['suspicionCandidateIds', 'executionCandidateIds', 'intendedVoteId', 'assessmentLevel']);
export const DECISION_GROUNDING_CAUSE_SET = new Set(DECISION_GROUNDING_CAUSES);

export function validateStoredEntityId(id, itemLabel, errors) {
  validateEntityId(id, itemLabel).forEach((message) => errors.push(message));
}

export function validateStoredEntityIds(items, itemLabel, errors) {
  (items ?? []).forEach((item, index) => validateStoredEntityId(item?.id, `${itemLabel}[${index}].id`, errors));
}

export function validateDecisionMetadata(decision, label, errors, { allowUninitialized = false } = {}) {
  if (!decision) return;
  if (typeof decision.decisionReason !== 'string') errors.push(`${label}のdecisionReasonが文字列ではありません。`);
  if (typeof decision.revisionCause !== 'string' || !DECISION_GROUNDING_CAUSE_SET.has(decision.revisionCause)) errors.push(`${label}のrevisionCauseが不正です。`);
  if (!Array.isArray(decision.keyPublicEvidenceEventIds)) errors.push(`${label}のkeyPublicEvidenceEventIdsが配列ではありません。`);
  if (typeof decision.hasDecisionChanged !== 'boolean') errors.push(`${label}のhasDecisionChangedが真偽値ではありません。`);
  if (!Array.isArray(decision.changedFields)) {
    errors.push(`${label}のchangedFieldsが配列ではありません。`);
  } else {
    decision.changedFields.forEach((field) => {
      if (!DECISION_CHANGED_FIELDS.has(field)) errors.push(`${label}のchangedFieldsに不正な項目があります: ${field}`);
    });
  }
  if (allowUninitialized && !decision.updatedAt) {
    if (decision.decisionReason !== '' || decision.revisionCause !== 'unchanged' || (Array.isArray(decision.keyPublicEvidenceEventIds) && decision.keyPublicEvidenceEventIds.length) || decision.hasDecisionChanged !== false || (Array.isArray(decision.changedFields) && decision.changedFields.length)) {
      errors.push(`${label}の未更新状態に判断差分が残っています。`);
    }
    return;
  }
}
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}



export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateWolfSharedStrategyPatch(update, itemLabel, errors, { openingStrategy = false } = {}) {
  if (update === null || update === undefined) return;
  if (!isPlainObject(update) || !['keep', 'patch'].includes(String(update.mode ?? '')) || !isPlainObject(update.changes)) {
    errors.push(`${itemLabel}がkeep/patch差分形式ではありません。`);
    return;
  }
  const entries = Object.entries(update.changes);
  entries.forEach(([key, value]) => {
    if (!WOLF_SHARED_STRATEGY_KEYS.includes(key)) errors.push(`${itemLabel}.changes.${key}は定義されていない項目です。`);
    if (typeof value !== 'string') errors.push(`${itemLabel}.changes.${key}が文字列ではありません。`);
  });
  if (update.mode === 'keep' && entries.length) errors.push(`${itemLabel}はkeep時にchangesを空にしてください。`);
  if (update.mode === 'patch' && !entries.length) errors.push(`${itemLabel}はpatch時に変更項目が必要です。`);
  if (openingStrategy && Object.hasOwn(update.changes, 'attackPlan')) {
    errors.push(`${itemLabel}のDay 0 attackPlanはシステム固定値のため出力できません。`);
  }
}

export function validateExactObjectShape(actual, expected, label, errors) {
  if (!isPlainObject(actual)) {
    errors.push(`${label}がオブジェクトではありません。`);
    return;
  }

  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  const missingKeys = expectedKeys.filter((key) => !Object.hasOwn(actual, key));
  const extraKeys = actualKeys.filter((key) => !Object.hasOwn(expected, key));

  missingKeys.forEach((key) => errors.push(`${label}.${key}がありません。`));
  extraKeys.forEach((key) => errors.push(`${label}.${key}は定義されていない項目です。`));

  expectedKeys.forEach((key) => {
    if (!Object.hasOwn(actual, key)) return;
    if (isPlainObject(expected[key])) {
      validateExactObjectShape(actual[key], expected[key], `${label}.${key}`, errors);
    }
  });
}
