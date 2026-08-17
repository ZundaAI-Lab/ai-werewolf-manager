/**
 * 責務: 投票開始、入力、確定、公開、処刑対象実行のコマンドを公開する。
 * 非責務: 議論中の発言機会やゲーム結果公開を担当しない。
 * 変更ルール: 投票集計規則をUIへ複製しない。
 */
export {
  beginVote,
  publishExecution,
  resolveExecution,
  finalizeVote,
  publishVoteResult,
  recordRandomVote,
  recordVote,
  reopenVoteInput,
  setVoteInputMode,
} from '../game/gameRuntime.js';
