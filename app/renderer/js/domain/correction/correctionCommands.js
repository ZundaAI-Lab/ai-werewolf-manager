/**
 * 責務: 訂正モード終了、公開前部分修正、公開済み内容訂正、役職訂正のコマンドと、訂正操作時に必要な訂正モードを自動開始するユースケースを公開する。
 * 非責務: 通常進行コマンド、復元スナップショット操作、DOM操作を扱わない。
 * 変更ルール: 利用者に事前の訂正モード開始を要求しない。公開訂正・役職訂正は実行時に必要なら自動開始し、失敗時だけこの操作で開始したモードを戻す。
 */

import {
  correctPublicEvent,
  correctPublicSpeech,
  correctRoleAssignment,
  editConfirmedEvent,
  enterCorrectionMode,
  exitCorrectionMode,
} from '../game/gameRuntime.js';

export {
  correctPublicEvent,
  correctPublicSpeech,
  correctRoleAssignment,
  editConfirmedEvent,
  exitCorrectionMode,
};

export function correctPublicEventWithMode(state, payload) {
  const startedHere = !state.game.correctionMode.enabled;
  if (startedHere) {
    const started = enterCorrectionMode(state, payload?.reason);
    if (!started.ok) return started;
  }
  const corrected = correctPublicEvent(state, payload);
  if (!corrected.ok && startedHere) exitCorrectionMode(state);
  return corrected;
}

export function correctRoleAssignmentWithMode(state, payload) {
  const startedHere = !state.game.correctionMode.enabled;
  if (startedHere) {
    const started = enterCorrectionMode(state, payload?.reason);
    if (!started.ok) return started;
  }
  const corrected = correctRoleAssignment(state, payload);
  if (!corrected.ok && startedHere) exitCorrectionMode(state);
  return corrected;
}

