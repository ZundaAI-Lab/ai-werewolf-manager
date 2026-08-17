/**
 * 責務: ゲーム全体の開始・手動終了コマンドを公開する。
 * 非責務: 夜・議論・投票・結果確認・訂正の個別操作を公開しない。
 * 変更ルール: UIはgameRuntimeを直接参照せず、機能領域ごとのコマンド窓口を使用する。
 */
export {
  addEvent,
  manualFinish,
  startGame,
} from './gameRuntime.js';
