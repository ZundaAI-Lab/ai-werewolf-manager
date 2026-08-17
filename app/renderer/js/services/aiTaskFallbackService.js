/**
 * 責務: AI候補の正常項目を保持したまま、ゲーム進行に必須なトップレベル項目だけへ代替値を注入できるかを判定し、代替候補JSONを生成する。
 * 変更ルール: ゲーム状態を更新せず、任意項目を補完しない。公開発言本文・勝敗後感想・内部メモ本文は創作せず、対象選択は現行候補からだけ行う。投票は本人の有効な投票予定、処刑価値候補、最後に現行候補からのランダム選択の順で既存判断を優先する。発言フォールバックや回答スキップなど行単位代替はUI／ドメインコマンドへ委譲する。
 */

import { getPlayer } from '../domain/game/standardRules.js';
import { getRequiredResponseTopLevelKeys } from '../prompts/response/responseContract.js';

function chooseCandidateId(validTargetIds, random = Math.random) {
  const ids = [...new Set((validTargetIds ?? []).map(String).filter(Boolean))];
  if (!ids.length) return null;
  const raw = Number(random?.() ?? 0);
  const ratio = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;
  return ids[Math.floor(ratio * ids.length)] ?? ids[0];
}

function cloneCandidateObject(evaluation) {
  const candidate = evaluation?.candidateObject;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? structuredClone(candidate)
    : {};
}

function resolveVoteFallbackTarget(state, taskArtifact, random) {
  const validIds = [...new Set((taskArtifact?.validTargetIds ?? []).map(String).filter(Boolean))];
  const valid = new Set(validIds);
  const actor = getPlayer(state, taskArtifact?.playerId);
  const intendedVoteId = String(actor?.decisionState?.intendedVoteId ?? '');
  if (intendedVoteId === 'abstain' && state?.game?.rules?.vote?.abstentionAllowed) {
    return { id: 'abstain', name: '棄権', strategy: 'decision-intended-vote' };
  }
  if (valid.has(intendedVoteId)) {
    const target = getPlayer(state, intendedVoteId);
    if (target) return { id: target.id, name: target.name, strategy: 'decision-intended-vote' };
  }
  const executionCandidateId = (actor?.decisionState?.executionCandidateIds ?? [])
    .map(String)
    .find((candidateId) => valid.has(candidateId));
  if (executionCandidateId) {
    const target = getPlayer(state, executionCandidateId);
    if (target) return { id: target.id, name: target.name, strategy: 'decision-execution-candidate' };
  }
  const randomTargetId = chooseCandidateId(validIds, random);
  const randomTarget = randomTargetId ? getPlayer(state, randomTargetId) : null;
  return randomTarget
    ? { id: randomTarget.id, name: randomTarget.name, strategy: 'random-valid-target' }
    : null;
}

export function buildRequiredFieldFallbackCandidate(state, taskArtifact, evaluation, { random = Math.random } = {}) {
  const requiredKeys = getRequiredResponseTopLevelKeys(taskArtifact?.mode);
  const candidateObject = cloneCandidateObject(evaluation);
  const missingKeys = requiredKeys.filter((key) => {
    const value = candidateObject[key];
    return value === null || value === undefined || (typeof value === 'string' && !value.trim());
  });
  const invalidRequiredPaths = new Set((evaluation?.issues ?? [])
    .map((issue) => String(issue?.path ?? '').replace(/^response\./u, ''))
    .filter((path) => requiredKeys.some((key) => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[`))));
  const fallbackKeys = [...new Set([...missingKeys, ...invalidRequiredPaths])];
  if (!fallbackKeys.length) {
    return { ok: false, reason: 'NO_REQUIRED_FIELD_FAILURE', candidateObject, fallbackFields: [] };
  }
  if (fallbackKeys.some((key) => key !== 'actionAnswer' && key !== 'wolfMessage' && key !== 'masonMessage' && key !== 'graveyardMessage')) {
    return { ok: false, reason: 'ROW_FALLBACK_REQUIRED', candidateObject, fallbackFields: fallbackKeys };
  }

  const fallbackFields = [];
  for (const key of fallbackKeys) {
    if (key === 'wolfMessage' || key === 'masonMessage' || key === 'graveyardMessage') {
      candidateObject[key] = 'なし';
      fallbackFields.push({ key, strategy: 'conversation-pass', value: 'なし' });
      continue;
    }
    const target = taskArtifact?.taskType === 'vote'
      ? resolveVoteFallbackTarget(state, taskArtifact, random)
      : (() => {
        const targetId = chooseCandidateId(taskArtifact.validTargetIds, random);
        const player = targetId ? getPlayer(state, targetId) : null;
        return player ? { id: player.id, name: player.name, strategy: 'random-valid-target' } : null;
      })();
    if (!target) {
      return { ok: false, reason: 'NO_VALID_FALLBACK_TARGET', candidateObject, fallbackFields };
    }
    candidateObject.actionAnswer = target.name;
    fallbackFields.push({ key: 'actionAnswer', strategy: target.strategy, targetId: target.id, value: target.name });
  }
  return {
    ok: true,
    reason: 'REQUIRED_FIELDS_FALLBACK_APPLIED',
    candidateObject,
    rawResponse: JSON.stringify(candidateObject),
    fallbackFields,
  };
}
