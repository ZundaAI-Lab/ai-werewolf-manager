/**
 * 責務: AIへ今回のdecisionPatch JSON例として見せる任意項目を、推理モード・人物の推理傾向・既存の処刑判断局面から選ぶ。
 * 変更ルール:
 * - 本モジュールは回答検証必須性、機械許可キー、ゲーム状態更新を変更しない。JSON例への掲載は回答候補の提示だけを意味し、掲載項目の欠落をエラーにしてはならない。
 * - 処刑比較項目の表示タイミングは呼出元がpromptSituation / promptSectionPolicyで解決した既存フラグだけを受け取り、本モジュールで残り発言回数やvote条件を再判定しない。
 * - 推理モード固有項目は今回ターンの思考整理用であり、永続判断状態へ必須保存する前提を持たない。
 * - confrontationStyle / questionStyleは公開表現・質問方法の責務なので、本モジュールからdecisionPatch項目を追加しない。
 */

const BASE_FIELDS = Object.freeze([
  'suspects',
  'assessmentLevel',
  'reason',
  'evidenceRefs',
]);

const EXECUTION_FIELDS = Object.freeze([
  'executionCandidates',
  'leaveAliveBenefit',
  'misexecutionCost',
  'selectionDifference',
]);

const MODE_FIELDS = Object.freeze({
  'probe-response': Object.freeze(['unresolvedPoint', 'nextDiscriminatingInformation']),
  'evaluate-response': Object.freeze(['responseImpact', 'uncertainty']),
  'trace-change': Object.freeze(['changePoint', 'changeTrigger', 'changeNaturalness']),
  'check-consistency': Object.freeze(['conflictPoint', 'compatibleExplanation']),
  'inspect-commitment': Object.freeze(['commitmentAlignment', 'reversalExplanation']),
  'compare-pair': Object.freeze(['interactionAsymmetry', 'candidateDifference']),
  'challenge-consensus': Object.freeze(['consensusIndependence', 'counterHypothesis']),
  'evaluate-information-gain': Object.freeze(['nextDiscriminatingInformation']),
  'compare-candidates': Object.freeze(['comparisonAxis', 'candidateDifference']),
  'synthesize-claims': Object.freeze(['supportingSignals', 'counterSignals']),
  'hold-judgment': Object.freeze(['uncertainty', 'remainingHypotheses', 'nextDiscriminatingInformation']),
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function profileFields(reasoningProfile = null) {
  const profile = reasoningProfile ?? {};
  const fields = [];
  if (profile.hypothesisBreadth === 'wide') fields.push('remainingHypotheses');
  if (profile.uncertaintyStyle === 'explicit') fields.push('uncertainty');
  if (profile.uncertaintyStyle === 'analytical') {
    fields.push('remainingHypotheses', 'nextDiscriminatingInformation');
  }
  if (profile.updateTempo === 'conservative') fields.push('counterSignals');
  if (profile.updateTempo === 'rapid') fields.push('responseImpact');
  return fields;
}

export function resolveDecisionPromptFieldKeys({
  reasoningModeId = null,
  reasoningProfile = null,
  isExecutionDecisionWindow = false,
  isFinalDiscussionDecisionWindow = false,
  includeCorrectionReference = false,
} = {}) {
  return unique([
    ...BASE_FIELDS,
    ...(MODE_FIELDS[String(reasoningModeId ?? '')] ?? []),
    ...profileFields(reasoningProfile),
    ...(isExecutionDecisionWindow ? EXECUTION_FIELDS : []),
    ...(isFinalDiscussionDecisionWindow ? ['intendedVote'] : []),
    ...(includeCorrectionReference ? ['correctedSpeechRefs'] : []),
  ]);
}
