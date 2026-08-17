/**
 * 責務: 指名制の一巡一回保証と、未発言者への指名による順番前倒しだけを決定する。
 * 変更ルール: 発言権の追加・削除を行わず、既発言者への指名は無効として基本順を維持する。
 */

export function normalizeDesignatedSpeakerPreference(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function applyDesignatedSpeakerPreference(discussion, preferredPlayerId) {
  const targetId = normalizeDesignatedSpeakerPreference(preferredPlayerId);
  if (!targetId || !Array.isArray(discussion?.queue)) return false;
  if ((discussion.spokenInCurrentRound ?? []).includes(targetId)) return false;
  const currentIndex = Math.max(0, Number(discussion.currentIndex ?? 0));
  const targetIndex = discussion.queue.indexOf(targetId);
  if (targetIndex <= currentIndex) return false;
  discussion.queue.splice(targetIndex, 1);
  discussion.queue.splice(currentIndex + 1, 0, targetId);
  return true;
}
