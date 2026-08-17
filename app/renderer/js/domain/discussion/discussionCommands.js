/**
 * 責務: 昼議論の通常発言・無料の回答優先発言・GMパスを分離して公開し、話者指定、後回し、3巡目CO後の対象者追加発言を公開する。
 * 非責務: 投票入力や夜行動を担当しない。
 * 変更ルール: 発言機会と公開イベントの整合性を壊す独自更新を追加しない。
 */
export {
  designateDiscussionSpeaker,
  recordDiscussionOpeningPreference,
  recordAiDiscussionOpeningPreference,
  deferSpeech,
  finishDiscussion,
  grantTargetedDiscussionReconsideration,
  recordAiPriorityAnswer,
  recordAiSpeech,
  recordAiSpeechPass,
  recordHumanPriorityAnswer,
  recordHumanSpeech,
  recordSpeechPass,
  resolveAllDeferred,
  skipAiPriorityAnswer,
  skipPriorityAnswer,
} from '../game/gameRuntime.js';
