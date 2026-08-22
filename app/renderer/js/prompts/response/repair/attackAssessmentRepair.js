/**
 * 責務: 襲撃比較評価の列挙値と代替対象名を現在の候補集合へ補正する。
 * 変更ルール: 襲撃判断を生成せず、任意評価項目の表記と対象整合だけを扱う。
 */

import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';
import {
  normalizeEnumField,
  removeNullOptionalFields,
  repairExactKeys,
  resolvePlayer,
} from './repairUtilities.js';
import {
  ATTACK_ASSESSMENT_KEYS,
  RISK_ALIASES,
} from './repairConstants.js';

function repairAttackAssessment(state, taskType, candidateIds, payload, operations) {
  if (!Object.hasOwn(payload, 'attackAssessment')) return;
  if (!isPlainObject(payload.attackAssessment)) {
    delete payload.attackAssessment;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'attackAssessment', 'オブジェクトでないattackAssessmentを省略しました。');
    return;
  }
  const assessment = repairExactKeys(payload.attackAssessment, 'attackAssessment', ATTACK_ASSESSMENT_KEYS, operations);
  removeNullOptionalFields(assessment, [], 'attackAssessment', operations);
  for (const key of ['hunterAliveChance', 'guardRisk', 'otherGuardRisk']) {
    normalizeEnumField(assessment, key, 'attackAssessment', operations, RISK_ALIASES);
  }
  const expectedTargetId = taskType === 'wolf-attack'
    ? resolvePlayer(state, payload.actionAnswer, candidateIds)?.id ?? null
    : null;
  if (typeof assessment.otherTarget === 'string') {
    const alternative = resolvePlayer(state, assessment.otherTarget, candidateIds);
    if (!alternative || (expectedTargetId && alternative.id === expectedTargetId)) {
      delete assessment.otherTarget;
      delete assessment.otherGuardRisk;
      operation(operations, 'INVALID_ALTERNATIVE_ASSESSMENT_REMOVED', 'attackAssessment.otherTarget', '無効または実対象と同一の比較候補を除外しました。');
    } else if (alternative.name !== assessment.otherTarget) {
      assessment.otherTarget = alternative.name;
      operation(operations, 'PLAYER_REFERENCE_CANONICALIZED', 'attackAssessment.otherTarget', '比較候補を正式表示名へ修正しました。');
    }
  }
  if (!Object.keys(assessment).length) {
    delete payload.attackAssessment;
    operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'attackAssessment', '有効項目がないattackAssessmentを省略しました。');
  }
}


export { repairAttackAssessment };
