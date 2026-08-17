/**
 * 責務: 非公開結果確認、勝敗確定、ゲーム結果公開、勝敗後感想のコマンドを公開する。
 * 非責務: 投票や訂正処理を担当しない。
 * 変更ルール: 勝敗判定を表示層で再実装しない。
 */
export {
  acknowledgePrivateResults,
  confirmGameResult,
  publishGameResult,
  recordResultImpression,
  skipResultImpression,
} from '../game/gameRuntime.js';
