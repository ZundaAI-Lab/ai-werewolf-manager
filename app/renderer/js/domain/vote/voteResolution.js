/**
 * 責務: 投票集計と決選投票上限から、処刑・決選投票・処刑なしを純粋計算する。
 * 変更ルール:
 * - 状態更新、イベント生成、DOM操作を行わない。
 * - 未対応の同票処理を暗黙補完しない。
 * - ランダム処刑は同票候補だけから選択し、選択根拠を結果へ残す。
 */

import { VOTE_TIE_RESOLUTIONS } from '../../config/constants.js';

export const VOTE_RESULT_RESOLUTIONS = Object.freeze([
  'single-max',
  'runoff',
  'random-tie-break',
  'tie-no-execution',
  'no-valid-votes',
]);

function assertVoteResolutionInput({ round, runoffLimit, tieResolution }) {
  if (!Number.isInteger(round) || round < 1) throw new RangeError(`投票ラウンドが不正です: ${round}`);
  if (!Number.isInteger(runoffLimit) || runoffLimit < 0) throw new RangeError(`決選投票上限が不正です: ${runoffLimit}`);
  if (!VOTE_TIE_RESOLUTIONS.includes(tieResolution)) throw new RangeError(`同票処理が不正です: ${tieResolution}`);
}

function pickRandom(values, random) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('乱数生成結果は0以上1未満である必要があります。');
  return values[Math.floor(value * values.length)];
}

export function getTopTiedCandidateIds(tally) {
  const max = Math.max(0, ...(tally ?? []).map((item) => Number(item?.count) || 0));
  if (max <= 0) return [];
  return tally.filter((item) => item.count === max).map((item) => item.targetId);
}

export function resolveVoteResult({ tally, round, runoffLimit, tieResolution, random = Math.random }) {
  assertVoteResolutionInput({ round, runoffLimit, tieResolution });
  const tiedCandidateIds = getTopTiedCandidateIds(tally);

  if (!tiedCandidateIds.length) {
    return {
      type: 'no-execution',
      targetId: null,
      tiedCandidateIds: [],
      resolution: 'no-valid-votes',
    };
  }

  if (tiedCandidateIds.length === 1) {
    return {
      type: 'execution',
      targetId: tiedCandidateIds[0],
      tiedCandidateIds: [],
      resolution: 'single-max',
    };
  }

  if (round <= runoffLimit) {
    return {
      type: 'runoff',
      targetId: null,
      tiedCandidateIds,
      resolution: 'runoff',
    };
  }

  if (tieResolution === 'random-execution') {
    return {
      type: 'execution',
      targetId: pickRandom(tiedCandidateIds, random),
      tiedCandidateIds,
      resolution: 'random-tie-break',
    };
  }

  return {
    type: 'no-execution',
    targetId: null,
    tiedCandidateIds,
    resolution: 'tie-no-execution',
  };
}
