/**
 * 責務: AI応答のevidenceRefs件数上限を一元管理し、通常判断と投票判断で同じ上限制約をSchema・プロンプト・自動修復へ供給する。
 * 変更ルール: evidenceRefsのJSONキー名・配列型・公開可視性判定は変更せず、件数上限だけを定義する。投票は短時間で確定すべきため通常判断より厳しい上限を使用する。
 */

export const MAX_EVIDENCE_REFS = 5;
export const MAX_VOTE_EVIDENCE_REFS = 3;

export function evidenceRefMaxItemsForMode(mode = '') {
  return mode === 'vote' ? MAX_VOTE_EVIDENCE_REFS : MAX_EVIDENCE_REFS;
}
