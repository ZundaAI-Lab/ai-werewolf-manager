/**
 * 責務: 雪女の本人限定推定ID配列を生存者・自己除外・役職条件へ合わせて補正する。
 * 変更ルール: 推定対象を追加生成せず、入力済みIDの重複除去と不正参照除去だけを行う。
 */

import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';
import {
  deepEqual,
  repairExactKeys,
  uniqueBy,
} from './repairUtilities.js';

function repairFreezeEstimates(state, playerId, payload, operations) {
  if (!Object.hasOwn(payload, 'estimate')) return;
  if (!isPlainObject(payload.estimate)) {
    delete payload.estimate;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'estimate', 'オブジェクトでないestimateを省略しました。');
    return;
  }
  const estimate = repairExactKeys(payload.estimate, 'estimate', ['wolfCandidateIds', 'predictedAttackTargetIds'], operations);
  for (const key of ['wolfCandidateIds', 'predictedAttackTargetIds']) {
    if (!Object.hasOwn(estimate, key)) continue;
    if (typeof estimate[key] === 'string') {
      estimate[key] = [estimate[key]];
      operation(operations, 'SINGLE_VALUE_WRAPPED', `estimate.${key}`, `estimate.${key}の単一IDを配列へ変換しました。`);
    }
    if (!Array.isArray(estimate[key])) continue;
    const valid = uniqueBy(estimate[key].map(String), (id) => id).filter((id) => {
      const player = state.players.find((item) => item.id === id);
      return Boolean(player?.alive && player.id !== playerId);
    });
    if (!deepEqual(valid, estimate[key])) {
      estimate[key] = valid;
      operation(operations, 'INVALID_ESTIMATE_IDS_REMOVED', `estimate.${key}`, `estimate.${key}から死亡者・本人・重複IDを除外しました。`);
    }
  }
  if (!Object.keys(estimate).length) delete payload.estimate;
}


export { repairFreezeEstimates };
