/**
 * 責務: 任意判断差分の対象者名・列挙値・参照配列の構文を現在の候補集合へ正規化する。
 * 変更ルール: 判断内容を新規生成しない。decisionPatch.correctedSpeechRefs / evidenceRefs の公開可視性・イベント種別は意味を持つ根拠なので黙って削除せず、responseValidator.jsへ渡して再生成対象として検証する。
 */

import { buildDecisionTargetPolicy } from '../../../domain/game/decisionTargetPolicy.js';
import { getDecisionPatchKeys } from '../responseContract.js';
import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';
import {
  canonicalizePlayerNames,
  normalizeEnumField,
  normalizePositiveIntegerRefs,
  normalizeStringArray,
  repairExactKeys,
  resolvePlayer,
} from './repairUtilities.js';

function repairDecisionUpdate(state, playerId, taskType, candidateIds, payload, operations) {
  if (!Object.hasOwn(payload, 'decisionPatch')) return;
  if (!isPlainObject(payload.decisionPatch)) {
    delete payload.decisionPatch;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'decisionPatch', 'オブジェクトでないdecisionPatchを省略しました。');
    return;
  }
  const responseMode = taskType === 'mason-conversation' ? 'mason' : taskType;
  const allowedKeys = getDecisionPatchKeys(responseMode);
  const patch = repairExactKeys(payload.decisionPatch, 'decisionPatch', allowedKeys, operations);
  const targetPolicy = buildDecisionTargetPolicy(state, playerId, { taskType, candidateIds });
  for (const [key, allowedIds] of [
    ['suspects', targetPolicy.suspicionCandidateIds],
    ['executionCandidates', targetPolicy.executionCandidateIds],
  ]) {
    if (!Object.hasOwn(patch, key)) continue;
    const values = normalizeStringArray(patch, key, 'decisionPatch', operations);
    patch[key] = canonicalizePlayerNames(state, values, allowedIds, `decisionPatch.${key}`, operations);
  }
  if (Object.hasOwn(patch, 'intendedVote')) {
    if (patch.intendedVote === null) {
      // nullは暫定投票予定の明示解除なので保持する。
    } else if (typeof patch.intendedVote === 'string') {
      const player = resolvePlayer(state, patch.intendedVote, targetPolicy.intendedVoteCandidateIds);
      if (player) {
        if (player.name !== patch.intendedVote) {
          patch.intendedVote = player.name;
          operation(operations, 'PLAYER_REFERENCE_CANONICALIZED', 'decisionPatch.intendedVote', '暫定投票予定を正式表示名へ修正しました。');
        }
      } else {
        delete patch.intendedVote;
        operation(operations, 'INVALID_OPTIONAL_TARGET_REMOVED', 'decisionPatch.intendedVote', '無効な暫定投票予定を除外しました。');
      }
    } else {
      delete patch.intendedVote;
      operation(operations, 'INVALID_OPTIONAL_TARGET_REMOVED', 'decisionPatch.intendedVote', '文字列またはnullでない暫定投票予定を除外しました。');
    }
  }
  normalizeEnumField(patch, 'assessmentLevel', 'decisionPatch', operations);
  for (const key of Object.keys(patch)) {
    if (['correctedSpeechRefs', 'evidenceRefs'].includes(key)) continue;
    if (typeof patch[key] === 'string') {
      if (!patch[key].trim()) {
        delete patch[key];
        operation(operations, 'EMPTY_OPTIONAL_VALUE_REMOVED', `decisionPatch.${key}`, `空のdecisionPatch.${key}を省略しました。`);
      } else patch[key] = patch[key].trim();
    }
  }
  normalizePositiveIntegerRefs(patch, 'correctedSpeechRefs', 'decisionPatch', operations);
  normalizePositiveIntegerRefs(patch, 'evidenceRefs', 'decisionPatch', operations);
  if (!Object.keys(patch).length) {
    delete payload.decisionPatch;
    operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'decisionPatch', '有効な判断変更がないdecisionPatchを省略しました。');
  }
}


export { repairDecisionUpdate };
