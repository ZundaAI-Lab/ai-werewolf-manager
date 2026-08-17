/**
 * 責務: 処刑対象に遺言機会が必要か、当日の状態異常によって自動スキップすべきかを純粋判定する。
 * 変更ルール: 遺言OFFはnot-required、凍結中の処刑対象はskippedを返す。墓場会話など死亡後の行動資格には影響させない。
 */

import { canLeaveTestamentDuringDay } from '../game/playerStatus.js';

export const FROZEN_TESTAMENT_SKIP_REASON = '凍結中のため遺言不可';

export function getTestamentAvailability(state, playerId, day = state?.game?.day) {
  if (state?.game?.rules?.testament?.enabled !== true) {
    return { status: 'not-required', skippedReason: '' };
  }
  if (!canLeaveTestamentDuringDay(state, playerId, day)) {
    return { status: 'skipped', skippedReason: FROZEN_TESTAMENT_SKIP_REASON };
  }
  return { status: 'pending', skippedReason: '' };
}
