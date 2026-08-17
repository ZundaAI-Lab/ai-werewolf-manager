/**
 * 責務: ゲーム準備時のキャラクターカード割り当てと役職並べ替えを提供する。
 * 変更ルール:
 * - ゲーム進行中の状態やDOMを扱わない。
 * - キャラクターカードは同一ゲーム内で重複させない。
 * - 役職のランダム配置では現在設定されている役職数を変更しない。
 */

import { createCharacterPlayerPreset } from './cards/characterCards.js';
import { getEnabledCharacterCards, isCharacterCardEnabled } from './catalog/characterCatalog.js';
import { shuffle } from '../shared/utils.js';
import { applySetupRoles } from '../domain/setup/setupRoles.js';

function applyPreset(player, preset, characterCardId) {
  player.characterCardId = characterCardId;
  player.name = preset.name;
  player.aliases = [...preset.aliases];
  player.character = { ...preset.character };
  player.callNameOverrides = {};
}

export function assignCharacterCard(players, playerId, characterCardId) {
  const player = players.find((item) => item.id === playerId);
  if (!player) return { ok: false, message: '対象プレイヤーが見つかりません。' };

  if (!characterCardId) {
    player.characterCardId = null;
    player.callNameOverrides = {};
    return { ok: true, message: 'キャラクターカードとの連携を解除しました。' };
  }

  const duplicate = players.find((item) => item.id !== playerId && item.characterCardId === characterCardId);
  if (duplicate) {
    return { ok: false, message: `${duplicate.name}に同じキャラクターカードが設定されています。` };
  }

  if (!isCharacterCardEnabled(characterCardId) && player.characterCardId !== characterCardId) {
    return { ok: false, message: '使用停止中のキャラクターカードは新しく割り当てできません。' };
  }

  const preset = createCharacterPlayerPreset(characterCardId);
  if (!preset) return { ok: false, message: '指定されたキャラクターカードが見つかりません。' };

  applyPreset(player, preset, characterCardId);
  return { ok: true, message: `${preset.name}のキャラクターカードを適用しました。` };
}

export function randomizeCharacterCards(players) {
  const availableCards = getEnabledCharacterCards();
  if (players.length > availableCards.length) {
    return { ok: false, message: '参加人数分の重複しないキャラクターカードを用意できません。' };
  }

  const selectedCards = shuffle(availableCards).slice(0, players.length);
  players.forEach((player, index) => {
    const card = selectedCards[index];
    const preset = createCharacterPlayerPreset(card.id);
    applyPreset(player, preset, card.id);
  });

  return {
    ok: true,
    message: `${players.length}人へ重複なしでキャラクターカードをランダム配置しました。`,
    assignedCardIds: selectedCards.map((card) => card.id),
  };
}

export function shuffleCurrentRoles(players) {
  const beforeCounts = players.reduce((counts, player) => {
    counts[player.roleId] = (counts[player.roleId] ?? 0) + 1;
    return counts;
  }, {});

  const shuffledRoles = shuffle(players.map((player) => player.roleId));
  applySetupRoles(players, shuffledRoles);

  const afterCounts = players.reduce((counts, player) => {
    counts[player.roleId] = (counts[player.roleId] ?? 0) + 1;
    return counts;
  }, {});

  const roleIds = [...new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)])];
  if (roleIds.some((roleId) => beforeCounts[roleId] !== afterCounts[roleId])) {
    throw new Error('役職数を維持したまま並べ替えることができませんでした。');
  }

  return { ok: true, message: '各役職の人数を維持したままランダム配置しました。' };
}
