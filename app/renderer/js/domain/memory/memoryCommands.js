/**
 * 責務: プレイヤー自由内部メモの整理と、AI整理失敗時に現在メモを維持するスキップコマンドを公開する。
 * 非責務: 記憶台帳の低水準更新処理をUIへ公開しない。
 * 変更ルール: UIからの内部メモ更新・AI整理スキップはこのコマンド群だけを経由し、失敗時に既存メモを上書きしない。
 */
export { consolidatePlayerInternalMemory, skipAiMemoConsolidation } from '../game/gameRuntime.js';
