/**
 * 責務: 日単位の状態異常と、昼会話・投票・遺言への参加資格を純粋関数として判定する。
 * 変更ルール: 生死やフェーズを変更しない。凍結中の遺言禁止もここを正本とし、状態異常の付与は夜解決側で行う。
 */

export function isFrozenOnDay(state, playerId, day = state?.game?.day) {
  const player = state?.players?.find((item) => item.id === playerId);
  return Boolean(player?.statusEffects?.some((effect) => effect.type === 'frozen' && Number(effect.day) === Number(day)));
}

export function canSpeakDuringDay(state, playerId, day = state?.game?.day) {
  const player = state?.players?.find((item) => item.id === playerId);
  return Boolean(player?.alive && !isFrozenOnDay(state, playerId, day));
}

export function canVoteDuringDay(state, playerId, day = state?.game?.day) {
  const player = state?.players?.find((item) => item.id === playerId);
  return Boolean(player?.alive && !isFrozenOnDay(state, playerId, day));
}

export function canLeaveTestamentDuringDay(state, playerId, day = state?.game?.day) {
  const player = state?.players?.find((item) => item.id === playerId);
  return Boolean(player?.alive && !isFrozenOnDay(state, playerId, day));
}

export function getDiscussionEligiblePlayerIds(state, day = state?.game?.day) {
  return state.players.filter((player) => canSpeakDuringDay(state, player.id, day)).map((player) => player.id);
}

export function getVoteEligiblePlayerIds(state, day = state?.game?.day) {
  return state.players.filter((player) => canVoteDuringDay(state, player.id, day)).map((player) => player.id);
}
