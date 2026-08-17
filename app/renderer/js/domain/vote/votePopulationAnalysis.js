/**
 * 責務: 投票時に本人へ提示可能な人数情報から、処刑直後と次夜の襲撃成功後における人狼数・生存数・基本勝利条件の分岐を純粋計算する。
 * 変更ルール: 実配役、GM専用情報、候補評価、文章生成、状態更新を参照・実行しない。生存人狼数や候補正体が本人に確定していない場合だけ仮定分岐を返し、既知の人狼本人には本人可視のknownWolfIdsと有効候補から候補別の確定分岐だけを返す。通常投票と決選投票は必ず本モジュールの同一計算を使用する。
 */

import { evaluateWolfPopulation, getStrictMajorityCount } from '../game/standardRules.js';

function normalizedCount(value) {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function populationOutcome(wolfCount, aliveCount) {
  return evaluateWolfPopulation(wolfCount, Math.max(0, aliveCount - wolfCount));
}

function buildPopulationBranch(aliveCount, assumedAliveWolfCount, candidateAlignment, targetId = null) {
  const afterExecutionAliveCount = Math.max(0, aliveCount - 1);
  const afterExecutionWolfCount = candidateAlignment === 'wolf'
    ? Math.max(0, assumedAliveWolfCount - 1)
    : assumedAliveWolfCount;
  const executionOutcome = populationOutcome(afterExecutionWolfCount, afterExecutionAliveCount);
  const nightOccurs = executionOutcome === 'continue';
  const afterSuccessfulAttackAliveCount = nightOccurs
    ? Math.max(0, afterExecutionAliveCount - 1)
    : afterExecutionAliveCount;
  const successfulAttackOutcome = nightOccurs
    ? populationOutcome(afterExecutionWolfCount, afterSuccessfulAttackAliveCount)
    : executionOutcome;
  return {
    targetId,
    assumedAliveWolfCount,
    candidateAlignment,
    afterExecutionAliveCount,
    afterExecutionWolfCount,
    afterExecutionMajorityThreshold: getStrictMajorityCount(afterExecutionAliveCount),
    executionOutcome,
    nightOccurs,
    afterSuccessfulAttackAliveCount,
    afterSuccessfulAttackMajorityThreshold: getStrictMajorityCount(afterSuccessfulAttackAliveCount),
    successfulAttackOutcome,
  };
}

export function buildVotePopulationBranches({
  aliveCount,
  configuredWolfCount,
  exactKnownAliveWolfCount = null,
  candidateIds = [],
  knownWolfIds = [],
} = {}) {
  const alive = normalizedCount(aliveCount);
  const configured = normalizedCount(configuredWolfCount);
  const exactKnown = Number.isInteger(exactKnownAliveWolfCount)
    ? Math.max(0, Number(exactKnownAliveWolfCount))
    : null;

  if (exactKnown !== null) {
    const knownWolfSet = new Set((knownWolfIds ?? []).map(String));
    return [...new Set((candidateIds ?? []).map(String).filter(Boolean))]
      .map((targetId) => buildPopulationBranch(
        alive,
        exactKnown,
        knownWolfSet.has(targetId) ? 'wolf' : 'non-wolf',
        targetId,
      ));
  }

  const maxPossibleAliveWolfCount = Math.min(
    configured,
    Math.floor(Math.max(0, alive - 1) / 2),
  );
  const possibleAliveWolfCounts = Array.from({ length: maxPossibleAliveWolfCount }, (_value, index) => index + 1);
  return possibleAliveWolfCounts.flatMap((count) => [
    buildPopulationBranch(alive, count, 'wolf'),
    buildPopulationBranch(alive, count, 'non-wolf'),
  ]);
}
