/**
 * 責務: 公開判断状態の列挙値、初期形、AI差分更新の適用、前回状態との決定的比較、変更メタデータ生成を一元管理する。
 * 変更ルール: assessmentLevelの許可値は本ファイルを正本とし、プロンプト・応答解析・状態検証で共用する。人物名解決や公開イベント参照の検証を行わない。回答時点の日付はsourceDayへ保存し、死亡・日付変更による現在盤面への射影はdecisionTargetPolicy.jsへ委譲する。応答パーサーは構文だけ、responseValidator.jsは対象・根拠整合だけを担当する。
 */

export const DECISION_ASSESSMENT_LEVELS = Object.freeze([
  'unresolved',
  'slight',
  'moderate',
  'strong',
]);

const DECISION_COMPARISON_FIELDS = Object.freeze([
  'suspicionCandidateIds',
  'executionCandidateIds',
  'intendedVoteId',
  'assessmentLevel',
]);

const DECISION_PATCH_FIELDS = Object.freeze([
  'suspicionCandidateIds',
  'executionCandidateIds',
  'intendedVoteId',
  'assessmentLevel',
  'leaveAliveBenefit',
  'misexecutionCost',
  'selectionDifference',
  'uncertainty',
  'nextDiscriminatingInformation',
]);

const DECISION_GROUNDING_CAUSES = Object.freeze([
  'unchanged',
  'new-public-evidence',
  'response-evaluation',
  'self-correction',
  'role-structure-change',
  'vote-pressure',
]);

function normalizeCandidateIds(ids) {
  return [...new Set((ids ?? []).filter(Boolean).map(String))].sort();
}

function sameCandidateSet(left, right) {
  return JSON.stringify(normalizeCandidateIds(left)) === JSON.stringify(normalizeCandidateIds(right));
}

export function createEmptyDecisionState() {
  return {
    suspicionCandidateIds: [],
    executionCandidateIds: [],
    intendedVoteId: null,
    assessmentLevel: 'unresolved',
    keyPublicEvidenceEventIds: [],
    leaveAliveBenefit: '',
    misexecutionCost: '',
    selectionDifference: '',
    uncertainty: '',
    nextDiscriminatingInformation: '',
    decisionReason: '',
    revisionCause: 'unchanged',
    hasDecisionChanged: false,
    changedFields: [],
    updatedAt: null,
    sourceAiTurnId: null,
    sourceEventId: null,
    sourceDay: null,
  };
}

export function isSubstantiveDecisionReason(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const normalized = text
    .replace(/[。．.!！?？]+$/gu, '')
    .replace(/\s+/gu, '')
    .toLowerCase();
  return !/^(?:none|なし|特になし|特にありません|未定|前回と同じ(?:です)?|変更なし|判断変更なし)$/u.test(normalized);
}

export function compareDecisionStates(previous = {}, next = {}) {
  const before = previous ?? {};
  const after = next ?? {};
  const changedFields = [];
  if (!sameCandidateSet(before.suspicionCandidateIds, after.suspicionCandidateIds)) {
    changedFields.push('suspicionCandidateIds');
  }
  if (!sameCandidateSet(before.executionCandidateIds, after.executionCandidateIds)) {
    changedFields.push('executionCandidateIds');
  }
  if ((before.intendedVoteId ?? null) !== (after.intendedVoteId ?? null)) {
    changedFields.push('intendedVoteId');
  }
  if (String(before.assessmentLevel ?? 'unresolved') !== String(after.assessmentLevel ?? 'unresolved')) {
    changedFields.push('assessmentLevel');
  }
  return changedFields;
}

export function applyDecisionPatch(previousState, patch) {
  if (!patch || !['keep', 'patch'].includes(String(patch.mode ?? ''))) return null;
  const base = {
    ...createEmptyDecisionState(),
    ...(previousState ?? {}),
    suspicionCandidateIds: [...(previousState?.suspicionCandidateIds ?? [])],
    executionCandidateIds: [...(previousState?.executionCandidateIds ?? [])],
    keyPublicEvidenceEventIds: [...(previousState?.keyPublicEvidenceEventIds ?? [])],
  };
  const sourceChanges = patch.mode === 'patch' && patch.changes && typeof patch.changes === 'object'
    ? patch.changes
    : {};
  const next = { ...base };
  Object.entries(sourceChanges).forEach(([key, value]) => {
    if (!DECISION_PATCH_FIELDS.includes(key)) return;
    if (key === 'suspicionCandidateIds' || key === 'executionCandidateIds') {
      next[key] = normalizeCandidateIds(value);
      return;
    }
    if (key === 'intendedVoteId') {
      next[key] = value ? String(value) : null;
      return;
    }
    if (key === 'assessmentLevel') {
      next[key] = String(value ?? 'unresolved');
      return;
    }
    next[key] = String(value ?? '');
  });
  next.decisionReason = String(patch.decisionReason ?? '').trim();
  next.revisionCause = DECISION_GROUNDING_CAUSES.includes(String(patch.revisionCause ?? ''))
    ? String(patch.revisionCause)
    : 'unchanged';
  if (Array.isArray(patch.keyPublicEvidenceEventIds)) {
    next.keyPublicEvidenceEventIds = [...new Set(patch.keyPublicEvidenceEventIds.filter(Boolean).map(String))];
  }
  return next;
}

export function deriveDecisionTransition(previous, next, {
  hasPreviousDecision = Boolean(previous?.updatedAt),
} = {}) {
  const changedFields = compareDecisionStates(previous, next);
  const hasDecisionChanged = !hasPreviousDecision || changedFields.length > 0;
  return { changedFields, hasDecisionChanged };
}

export {
  DECISION_COMPARISON_FIELDS,
  DECISION_GROUNDING_CAUSES,
  DECISION_PATCH_FIELDS,
};
