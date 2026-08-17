/**
 * 責務: 実配役から役職構成を集計し、役職欠け適用後もプレイヤーへ公開する開始前配役構成を一元的に返し、保存された公開用構成の役職ID・人数・合計人数を検証する。
 * 変更ルール: プレイヤーごとの役職対応や欠けた役職を公開しない。公開用スナップショットが存在する進行中ゲームでは実配役を再集計せず、そのスナップショットを正本とする。保存値の意味検証は既知役職IDと正の整数人数に限定し、状態全体の参照整合性はStateValidatorへ委譲する。
 */

import { ROLE_IDS } from '../../config/constants.js';

export function countRoleComposition(players = []) {
  const counts = (players ?? []).reduce((result, player) => {
    const roleId = String(player?.roleId ?? '');
    if (!roleId) return result;
    result[roleId] = Number(result[roleId] ?? 0) + 1;
    return result;
  }, {});
  const knownRoleIds = ROLE_IDS.filter((roleId) => Number(counts[roleId] ?? 0) > 0);
  const unknownRoleIds = Object.keys(counts)
    .filter((roleId) => !ROLE_IDS.includes(roleId))
    .sort();
  return Object.fromEntries([...knownRoleIds, ...unknownRoleIds].map((roleId) => [roleId, counts[roleId]]));
}

export function getPublicRoleComposition(state) {
  const snapshot = state?.game?.publicRoleComposition;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) return { ...snapshot };
  return countRoleComposition(state?.players ?? []);
}


export function validateRoleComposition(composition, { playerCount, label = '役職構成' } = {}) {
  const errors = [];
  if (!composition || typeof composition !== 'object' || Array.isArray(composition)) {
    return [`${label}がオブジェクトではありません。`];
  }

  const entries = Object.entries(composition);
  if (!entries.length) errors.push(`${label}が空です。`);
  entries.forEach(([roleId, count]) => {
    if (!ROLE_IDS.includes(roleId)) errors.push(`${label}に未対応の役職IDがあります: ${roleId}`);
    if (!Number.isInteger(count) || count < 1) errors.push(`${label}.${roleId}の人数が正の整数ではありません。`);
  });

  if (Number.isInteger(playerCount)) {
    const total = entries.reduce((sum, [, count]) => sum + (Number.isInteger(count) ? count : 0), 0);
    if (total !== playerCount) errors.push(`${label}の合計人数が参加人数と一致しません: ${total} / ${playerCount}`);
  }
  return errors;
}
