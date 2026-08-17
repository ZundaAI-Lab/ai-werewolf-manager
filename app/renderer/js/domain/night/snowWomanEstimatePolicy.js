/**
 * 責務: 雪女の推定人狼・予想襲撃先の必要件数を、その夜の有効な凍結候補数から決定する。
 * 変更ルール: 推理補助の二系統は維持し、両方から外れた正式な凍結対象を最低一人残す。候補名解決やゲーム状態更新は行わない。
 */

export function resolveSnowWomanEstimateLimit(validTargetCount) {
  const count = Math.max(0, Number(validTargetCount) || 0);
  const max = Math.min(3, Math.max(0, count - 1));
  return Object.freeze({ min: max > 0 ? 1 : 0, max });
}
