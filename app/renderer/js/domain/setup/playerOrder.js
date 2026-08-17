/**
 * 責務: ゲーム準備中の参加者配列の並び順だけを変更する。
 * 変更ルール:
 * - プレイヤーのID・設定・役職・キャラクターを変更しない。
 * - ゲーム進行中の可否判定やDOM操作を行わない。
 * - シャッフル後も同じプレイヤーオブジェクトを一度ずつ保持する。
 */

function replacePlayers(players, nextPlayers) {
  players.splice(0, players.length, ...nextPlayers);
}

export function moveSetupPlayer(players, playerId, direction) {
  const offset = Number(direction);
  if (![-1, 1].includes(offset)) {
    throw new RangeError(`未定義の参加者移動方向です: ${direction}`);
  }

  const currentIndex = players.findIndex((player) => player.id === playerId);
  if (currentIndex < 0) return { ok: false, message: '移動対象の参加者が見つかりません。' };

  const nextIndex = currentIndex + offset;
  if (nextIndex < 0 || nextIndex >= players.length) {
    return { ok: false, message: 'これ以上移動できません。' };
  }

  [players[currentIndex], players[nextIndex]] = [players[nextIndex], players[currentIndex]];
  return { ok: true, message: '参加者の並び順を変更しました。' };
}

export function shuffleSetupPlayers(players, random = Math.random) {
  if (players.length < 2) {
    return { ok: false, message: '並べ替える参加者が不足しています。' };
  }

  const originalIds = players.map((player) => player.id);
  const shuffled = [...players];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const bounded = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.9999999999999999) : 0;
    const swapIndex = Math.floor(bounded * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  if (shuffled.every((player, index) => player.id === originalIds[index])) {
    shuffled.push(shuffled.shift());
  }

  replacePlayers(players, shuffled);
  return { ok: true, message: '参加者の並び順をシャッフルしました。' };
}
