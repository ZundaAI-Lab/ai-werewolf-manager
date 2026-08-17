/**
 * 責務: 新しい公開Feedの種類と観戦反応頻度から、観戦者AIへ追加する自動リアクション数を決める。
 * 変更ルール: ゲームState・秘密情報・AI通信を参照しない。同じ公開revisionと設定では同じ件数を返し、通常発言だけで過剰な観戦ログを生成しない。質問回答ターンの生成数はこのPolicyで扱わない。
 */

function deterministicBit(value) {
  let hash = 2166136261;
  const source = String(value ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) & 1;
}

function eventWeight(type) {
  if (['game-result', 'execution', 'dawn'].includes(type)) return 3;
  if (['vote-finalized'].includes(type)) return 2;
  if (['correction', 'system'].includes(type)) return 2;
  if (['public-speech', 'result-impression'].includes(type)) return 1;
  return 1;
}

export function resolveSpectatorReactionCount({ feed, reactionLevel = 'standard', factsChanged = false, participantCount = 0, initial = false } = {}) {
  const participants = Math.max(0, Number(participantCount ?? 0) || 0);
  if (!participants) return 0;
  if (initial) {
    const desired = reactionLevel === 'quiet' ? 1 : reactionLevel === 'lively' ? 3 : 2;
    return Math.min(participants, desired);
  }
  const maxWeight = (feed?.events ?? []).reduce((max, event) => Math.max(max, eventWeight(event.type)), factsChanged ? 2 : 0);
  if (!maxWeight) return 0;
  let desired = 0;
  if (reactionLevel === 'quiet') desired = maxWeight >= 3 ? 2 : maxWeight >= 2 ? 1 : 0;
  else if (reactionLevel === 'lively') desired = maxWeight >= 3 ? 3 : maxWeight >= 2 ? 2 : 1;
  else if (maxWeight >= 3) desired = 3;
  else if (maxWeight >= 2) desired = 2;
  else desired = deterministicBit(`${feed?.publicRevision ?? 0}:${feed?.latestEventSequence ?? 0}`);
  return Math.min(participants, desired);
}
