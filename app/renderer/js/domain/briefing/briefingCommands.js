/**
 * 責務: 人間・AIの役職通知状態更新に関するコマンドだけを公開する。
 * 非責務: ゲーム開始や夜処理を担当しない。
 * 変更ルール: 通知状態の更新規則はgameRuntime側へ集約し、この窓口へ複製しない。
 */
export {
  acknowledgeRole,
  forceAcknowledgeRole,
  markBriefingShown,
} from '../game/gameRuntime.js';
