/**
 * 責務: 昼議論方式ごとのAIタスク種別と、発言希望制の非公開進行希望の列挙値を一元管理する。
 * 変更ルール: orderedは既存speechを正本として維持し、指名制・発言希望制専用キーをorderedへ流入させない。
 */

export const ORDERED_SPEECH_TASK = 'speech';
export const DESIGNATED_SPEECH_TASK = 'speech-designated';
export const FREE_SPEECH_TASK = 'speech-free';
export const DISCUSSION_OPENING_PREFERENCE_TASK = 'discussion-opening-preference';

export const NORMAL_SPEECH_TASK_TYPES = Object.freeze([
  ORDERED_SPEECH_TASK,
  DESIGNATED_SPEECH_TASK,
  FREE_SPEECH_TASK,
]);

export const FREE_DISCUSSION_PREFERENCES = Object.freeze(['EARLY', 'NORMAL', 'WAIT_CO', 'DONE']);
export const FREE_DISCUSSION_OPENING_PREFERENCES = Object.freeze(['EARLY', 'NORMAL', 'WAIT_CO']);

export function isNormalSpeechTask(taskType) {
  return NORMAL_SPEECH_TASK_TYPES.includes(String(taskType ?? ''));
}


export function speechTaskTypeForDiscussionMode(mode) {
  if (mode === 'ordered') return ORDERED_SPEECH_TASK;
  if (mode === 'designated') return DESIGNATED_SPEECH_TASK;
  if (mode === 'free') return FREE_SPEECH_TASK;
  throw new RangeError(`未定義の昼議論方式です: ${String(mode ?? '') || '(empty)'}`);
}
