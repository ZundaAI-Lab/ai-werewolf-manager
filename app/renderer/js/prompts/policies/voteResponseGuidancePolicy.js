/**
 * 責務: voteでAIへ原則出力させるdecisionPatchの比較項目と説明文を、直接生成・多段候補工程の両方へ同一内容で提供する。
 * 変更ルール: 回答検証上のrequired/optionalを変更しない。ここで列挙する項目は今回JSON例へ表示された任意候補であり、欠落時のエラー条件ではない。機械許可キー集合はresponseContractを正本とし、本モジュールは表示集合だけを説明する。投票時の処刑比較はactionAnswerの投票対象を単一の基準対象とし、別候補の利益・損失を同じ比較欄へ混在させない。ゲーム状態・秘密情報を参照しない。decisionPatchの根拠参照は#公開ログ番号だけに限定し、P#本人限定参照との名前空間を混同させない。
 */

import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';

export const VOTE_PROMPT_PRIORITY_DECISION_CHANGE_KEYS = Object.freeze([
  'executionCandidates', 'leaveAliveBenefit', 'misexecutionCost', 'selectionDifference',
]);

export function buildVoteDecisionPatchGuidanceRows(displayedKeys = []) {
  const normalizedDisplayedKeys = [...new Set((displayedKeys ?? []).map(String).filter(Boolean))];
  const priorityKeys = VOTE_PROMPT_PRIORITY_DECISION_CHANGE_KEYS
    .filter((key) => normalizedDisplayedKeys.includes(key));
  const rows = [
    `投票先はactionAnswer、投票理由はrationaleだけに記録します。decisionPatchはmode/changesで包まず直下形式で、今回JSON例に表示された子項目から必要なものだけ任意で使用します。表示項目: ${normalizedDisplayedKeys.join(' / ') || 'なし'}。各子項目は未回答でもエラーになりません。${priorityKeys.length ? `処刑判断では ${priorityKeys.join(' / ')} が比較候補です。` : ''}`,
  ];
  if (priorityKeys.some((key) => ['leaveAliveBenefit', 'misexecutionCost', 'selectionDifference'].includes(key))) {
    rows.push('leaveAliveBenefitとmisexecutionCostはactionAnswerの投票対象だけを基準にし、leaveAliveBenefitにはその対象を残す利益、misexecutionCostにはその対象を誤処刑した場合の主要損失を記録します。selectionDifferenceにはactionAnswerの投票対象と最有力の別候補との今日の処刑価値の差を記録します。');
  }
  if (normalizedDisplayedKeys.includes('assessmentLevel')) {
    rows.push(`decisionPatch.assessmentLevelは ${DECISION_ASSESSMENT_LEVELS.join(' / ')} のいずれかです。`);
  }
  if (normalizedDisplayedKeys.includes('correctedSpeechRefs') || normalizedDisplayedKeys.includes('evidenceRefs')) {
    rows.push('decisionPatch.correctedSpeechRefsは自分の過去public-speechだけ、evidenceRefsは本人に見えているpublic-speech / vote-finalized / execution / dawnの#公開ログ番号だけを正整数で指定します。');
  }
  return rows;
}

export function renderVoteDecisionPatchGuidance(allowedKeys = []) {
  return buildVoteDecisionPatchGuidanceRows(allowedKeys).join('\n');
}
