/**
 * 責務: voteでAIへ原則出力させるdecisionPatchの比較項目と説明文を、直接生成・構造草案の両方へ同一内容で提供する。
 * 変更ルール: 回答検証上のrequired/optionalを変更しない。ここで列挙する項目はAIへ具体化を促す優先項目であり、欠落時のエラー条件ではない。許可キー集合は呼出元のresponseContractを正本とし、ゲーム状態・秘密情報を参照しない。decisionPatchの根拠参照は#公開ログ番号だけに限定し、P#本人限定参照との名前空間を混同させない。
 */

import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';

export const VOTE_PROMPT_PRIORITY_DECISION_CHANGE_KEYS = Object.freeze([
  'executionCandidates', 'leaveAliveBenefit', 'misexecutionCost', 'selectionDifference',
]);

export function buildVoteDecisionPatchGuidanceRows(allowedKeys = []) {
  const normalizedAllowedKeys = [...new Set((allowedKeys ?? []).map(String).filter(Boolean))];
  const priorityKeys = VOTE_PROMPT_PRIORITY_DECISION_CHANGE_KEYS
    .filter((key) => normalizedAllowedKeys.includes(key));
  const rows = [
    `投票先はactionAnswer、投票理由はrationaleだけに記録します。decisionPatchはmode/changesで包まず、比較・不確実性・公開根拠参照を直下へ記録します。使用可能キー: ${normalizedAllowedKeys.join(' / ') || 'なし'}。${priorityKeys.length ? `特に ${priorityKeys.join(' / ')} を具体化してください。` : ''}`,
    'leaveAliveBenefitには対象を残すことで自陣営が得る利益、misexecutionCostにはその処刑が自陣営に不利だった場合の主要損失、selectionDifferenceには最有力の別候補との今日の処刑価値の差を記録します。',
    `decisionPatch.assessmentLevelは ${DECISION_ASSESSMENT_LEVELS.join(' / ')} のいずれかです。`,
    'decisionPatch.correctedSpeechRefsは自分の過去public-speechだけ、evidenceRefsは本人に見えているpublic-speech / vote-finalized / execution / dawnの#公開ログ番号だけを正整数で指定します。',
  ];
  return rows;
}

export function renderVoteDecisionPatchGuidance(allowedKeys = []) {
  return buildVoteDecisionPatchGuidanceRows(allowedKeys).join('\n');
}
