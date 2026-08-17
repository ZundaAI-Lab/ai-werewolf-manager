/**
 * 責務: evidenceFocusごとの通常推理モード候補順を単一の正本として提供する。
 * 変更ルール: 発火条件、対象選択、スコア計算、表現方針を持たない。候補順を変更する場合は推理ディレクタと計測結果の両方へ同じ定義が反映されるよう本モジュールだけを変更する。
 */

const MODES_BY_EVIDENCE_FOCUS = Object.freeze({
  balanced: Object.freeze(['synthesize-claims', 'compare-candidates', 'evaluate-information-gain']),
  response: Object.freeze(['probe-response', 'compare-candidates', 'synthesize-claims']),
  chronology: Object.freeze(['trace-change', 'check-consistency', 'compare-candidates']),
  consistency: Object.freeze(['check-consistency', 'trace-change', 'synthesize-claims']),
  commitment: Object.freeze(['inspect-commitment', 'check-consistency', 'compare-candidates']),
  'social-reaction': Object.freeze(['compare-pair', 'challenge-consensus', 'probe-response']),
});

export function getReasoningModeCandidates(evidenceFocus = 'balanced') {
  return [...(MODES_BY_EVIDENCE_FOCUS[evidenceFocus] ?? MODES_BY_EVIDENCE_FOCUS.balanced)];
}
