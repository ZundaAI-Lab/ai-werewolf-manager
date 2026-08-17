/**
 * 責務: 墓場・共有者・人狼の夜間会話、襲撃投票、能力行動、夜解決、夜明け公開のコマンドを公開する。
 * 非責務: 昼議論と通常投票を操作しない。
 * 変更ルール: 夜フェーズのUI操作はこの窓口だけを経由する。襲撃対象は生存人狼ごとの秘密投票を集計し、最多同率時だけ抽選して決定する。
 */
export {
  closeGraveyardConversation,
  closeMasonConversation,
  closeWolfConversation,
  finalizeWolfAttackVote,
  forceWolfAttackVote,
  publishDawn,
  recordGraveyardMessage,
  recordMasonMessage,
  recordNightAction,
  recordRandomNightAction,
  recordRandomWolfAttackVote,
  recordWolfAttackVote,
  recordWolfMessage,
  reopenWolfConversation,
  resolveNight,
} from '../game/gameRuntime.js';
