/**
 * 責務: 構文回復と項目別の決定的修復を順に適用し、再検証用候補と監査操作を返す公開窓口である。
 * 変更ルール: 項目固有の修復規則を実装せず、repair配下の各責務を呼び分ける。必須値を新規生成しない。判断根拠・陣営戦略のように意味を持つ構造化項目は、不正時に黙って破棄せず再生成対象として保持する。speechInteractionは公開本文とは独立した補助制御として専用修復後も不正なら未指定扱いにできる。投票では有効なactionAnswerを進行上の正本として保護し、意味を変えない任意項目だけを監査操作付きで破棄できる。
 */

import { getRequiredResponseTopLevelKeys, getResponseTopLevelKeys } from './responseContract.js';
import { extractJsonObjectText, operation, parseCompleteTopLevelFields, parseJsonObjectStrict } from './repair/jsonObjectRecovery.js';
import { deletePathValue, normalizeIssuePath, parseIssuePathSegments, removeEmptyOptionalAncestors } from './repair/repairUtilities.js';
import { repairSpeechInteraction } from './repair/speechInteractionRepair.js';
import { repairCoOperation } from './repair/coOperationRepair.js';
import { repairAbilityClaims } from './repair/abilityClaimRepair.js';
import { repairDecisionUpdate } from './repair/decisionUpdateRepair.js';
import { repairFactionStrategy } from './repair/factionStrategyRepair.js';
import { repairSharedStrategy } from './repair/sharedStrategyRepair.js';
import { repairAttackAssessment } from './repair/attackAssessmentRepair.js';
import { repairFreezeEstimates } from './repair/freezeEstimateRepair.js';
import { repairSelectionRationale, repairInternalMemo, repairTopLevel } from './repair/responseValueRepair.js';

const NON_DISCARDABLE_SEMANTIC_OPTIONAL_KEYS = new Set(['decisionPatch', 'factionStrategy']);

function isDiscardProtectedOptionalKey(topLevelKey, taskType) {
  if (String(taskType ?? '') === 'vote') return topLevelKey === 'speechInteraction';
  return NON_DISCARDABLE_SEMANTIC_OPTIONAL_KEYS.has(topLevelKey);
}

export function repairAiResponseCandidate(state, taskArtifact, rawResponse) {
  const operations = [];
  const extracted = extractJsonObjectText(rawResponse, operations);
  let payload;
  const mode = String(taskArtifact?.mode ?? '');
  try {
    payload = parseJsonObjectStrict(extracted, operations);
  } catch (error) {
    if (error?.code === 'AMBIGUOUS_DUPLICATE_KEY') {
      return {
        applied: false,
        originalRawResponse: String(rawResponse ?? ''),
        repairedRawResponse: String(rawResponse ?? ''),
        operations: [],
        blockedReason: error.code,
      };
    }
    payload = parseCompleteTopLevelFields(rawResponse, getResponseTopLevelKeys(mode), operations);
    if (!payload) {
      return {
        applied: false,
        originalRawResponse: String(rawResponse ?? ''),
        repairedRawResponse: String(rawResponse ?? ''),
        operations: [],
        blockedReason: error?.code ?? 'INVALID_JSON',
      };
    }
  }


  const taskType = String(taskArtifact?.taskType ?? '');
  const playerId = String(taskArtifact?.playerId ?? '');
  const candidateIds = [...(taskArtifact?.validTargetIds ?? [])];
  repairTopLevel(payload, mode, operations);
  repairSpeechInteraction(state, playerId, payload, operations);
  repairCoOperation(state, playerId, payload, operations);
  repairAbilityClaims(state, payload, operations);
  repairDecisionUpdate(state, playerId, taskType, candidateIds, payload, operations);
  repairFactionStrategy(state, playerId, payload, operations);
  repairSharedStrategy(state, payload, operations);
  repairAttackAssessment(state, taskType, candidateIds, payload, operations);
  repairFreezeEstimates(state, playerId, payload, operations);
  repairSelectionRationale(taskType, payload, operations);
  repairInternalMemo(payload, operations);

  const repairedRawResponse = JSON.stringify(payload);
  const originalRawResponse = String(rawResponse ?? '');
  return {
    applied: operations.length > 0 && repairedRawResponse !== originalRawResponse.trim(),
    originalRawResponse,
    repairedRawResponse,
    operations,
    blockedReason: null,
  };
}


export function discardInvalidOptionalResponseFields(rawResponse, mode, issues = [], { taskType = '' } = {}) {
  const operations = [];
  let payload;
  try {
    payload = parseJsonObjectStrict(String(rawResponse ?? '').trim(), operations);
  } catch (error) {
    return {
      applied: false,
      originalRawResponse: String(rawResponse ?? ''),
      repairedRawResponse: String(rawResponse ?? ''),
      operations: [],
      blockedReason: error?.code ?? 'INVALID_JSON',
    };
  }
  const required = new Set(getRequiredResponseTopLevelKeys(mode));
  const allowed = new Set(getResponseTopLevelKeys(mode));
  for (const issue of issues ?? []) {
    const segments = parseIssuePathSegments(issue?.path);
    const topLevelKey = segments[0];
    if (typeof topLevelKey !== 'string' || required.has(topLevelKey) || isDiscardProtectedOptionalKey(topLevelKey, taskType)) continue;
    if (!allowed.has(topLevelKey)) {
      if (Object.hasOwn(payload, topLevelKey)) {
        delete payload[topLevelKey];
        operation(operations, 'INVALID_OPTIONAL_FIELD_DISCARDED', topLevelKey, `未定義の任意項目${topLevelKey}を未入力扱いにしました。`);
      }
      continue;
    }
    const deleted = deletePathValue(payload, segments);
    if (!deleted && Object.hasOwn(payload, topLevelKey)) delete payload[topLevelKey];
    if (deleted || !Object.hasOwn(payload, topLevelKey)) {
      operation(operations, 'INVALID_OPTIONAL_FIELD_DISCARDED', normalizeIssuePath(issue?.path) || topLevelKey, `${normalizeIssuePath(issue?.path) || topLevelKey}を未入力扱いにし、他のAI生成結果を保持しました。`);
      removeEmptyOptionalAncestors(payload, topLevelKey);
    }
  }
  const repairedRawResponse = JSON.stringify(payload);
  const originalRawResponse = String(rawResponse ?? '');
  return {
    applied: operations.length > 0 && repairedRawResponse !== originalRawResponse.trim(),
    originalRawResponse,
    repairedRawResponse,
    operations,
    blockedReason: null,
  };
}

export function autoRepairIssues(autoRepair) {
  return (autoRepair?.operations ?? []).map((item) => ({
    code: `AUTO_REPAIR_${String(item.code ?? 'APPLIED')}`,
    message: String(item.message ?? 'AI応答を決定的に自動補正しました。'),
  }));
}


