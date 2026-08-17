/**
 * 責務: ゲーム操作の公開APIを機能領域別Runtimeから再公開する。
 * 変更ルール: 実装を追加せず、公開コマンドの所属変更時だけ再公開先を更新する。旧一体実装や互換分岐を残さない。
 */

export {
  addEvent,
} from './gameRuntimeShared.js';
export {
  startGame,
  markBriefingShown,
  acknowledgeRole,
  forceAcknowledgeRole,
} from './gameLifecycleRuntime.js';
export {
  recordGraveyardMessage,
  closeGraveyardConversation,
  recordMasonMessage,
  closeMasonConversation,
  recordWolfMessage,
  closeWolfConversation,
  reopenWolfConversation,
  finalizeWolfAttackVote,
  recordWolfAttackVote,
  forceWolfAttackVote,
  recordRandomWolfAttackVote,
  recordNightAction,
  recordRandomNightAction,
  resolveNight,
  publishDawn,
} from '../night/nightRuntime.js';
export {
  designateDiscussionSpeaker,
  recordDiscussionOpeningPreference,
  recordAiDiscussionOpeningPreference,
  recordHumanSpeech,
  recordAiSpeech,
  recordAiSpeechPass,
  recordHumanPriorityAnswer,
  recordAiPriorityAnswer,
  skipAiPriorityAnswer,
  recordSpeechPass,
  deferSpeech,
  resolveAllDeferred,
  grantTargetedDiscussionReconsideration,
  skipPriorityAnswer,
  finishDiscussion,
} from '../discussion/discussionRuntime.js';
export {
  beginVote,
  recordVote,
  recordRandomVote,
  setVoteInputMode,
  reopenVoteInput,
  finalizeVote,
  publishVoteResult,
  resolveExecution,
  publishExecution,
} from '../vote/voteRuntime.js';
export {
  recordHumanTestament,
  recordAiTestament,
  skipTestament,
} from '../execution/testamentRuntime.js';
export {
  acknowledgePrivateResults,
  confirmGameResult,
  publishGameResult,
  recordResultImpression,
  skipResultImpression,
} from '../result/resultRuntime.js';
export {
  enterCorrectionMode,
  exitCorrectionMode,
  correctPublicSpeech,
  correctPublicEvent,
  editConfirmedEvent,
  correctRoleAssignment,
} from '../correction/correctionRuntime.js';
export {
  skipAiMemoConsolidation,
  consolidatePlayerInternalMemory,
  manualFinish,
} from '../memory/memoryRuntime.js';
