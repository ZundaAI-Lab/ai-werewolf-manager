/**
 * 責務: 最終キャラ発言化工程のtextPatch回答について、JSON解析・対象キー検証・元文章連続性検証・検証済み差分のmergeを自動/手動生成へ共通提供する。
 * 変更ルール: API通信、DOM、ゲーム状態更新、最終候補のゲーム意味検証を行わない。textPatchの受理条件は本サービスを唯一の適用入口とし、自動/手動経路で個別再実装しない。失敗時は候補を変更せず、generationStageResponseの機械検証issueをそのまま返す。
 */

import {
  mergeTextPatch,
  parseTextPatchResponse,
  validateTextPatchContinuity,
  validateTextPatchForStage,
} from '../prompts/stages/generationStageResponse.js';

export function validateAndMergeGenerationTextPatch({
  stageId,
  candidateObject,
  targetTextFields,
  rawResponse,
} = {}) {
  const parsedPatch = parseTextPatchResponse(rawResponse);
  if (!parsedPatch.ok) {
    return { ok: false, candidateObject, textPatch: null, issues: parsedPatch.issues };
  }

  const patchValidation = validateTextPatchForStage({
    stageId,
    targetTextFields,
    textPatch: parsedPatch.textPatch,
  });
  if (!patchValidation.ok) {
    return { ok: false, candidateObject, textPatch: parsedPatch.textPatch, issues: patchValidation.issues };
  }

  const continuityValidation = validateTextPatchContinuity({
    stageId,
    candidateObject,
    targetTextFields,
    textPatch: parsedPatch.textPatch,
  });
  if (!continuityValidation.ok) {
    return { ok: false, candidateObject, textPatch: parsedPatch.textPatch, issues: continuityValidation.issues };
  }

  return {
    ok: true,
    candidateObject: mergeTextPatch(candidateObject, parsedPatch.textPatch, targetTextFields),
    textPatch: parsedPatch.textPatch,
    issues: [],
  };
}
