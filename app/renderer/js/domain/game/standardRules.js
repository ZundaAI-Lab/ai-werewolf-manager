/**
 * 責務: 標準人狼の配役整合性、対象候補、能力結果、勝敗判定を純粋関数として提供する。
 * 変更ルール: 状態更新・DOM操作・保存処理を行わない。特殊ルールは状態ルールから明示的に判定する。個人夜行動の所属はpersonalNightActionTasks.jsを正本とし、未定義種別を候補0件として偽装しない。
 */

import { MAX_PLAYER_COUNT, MIN_PLAYER_COUNT, ROLE_DEFINITIONS, ROLE_IDS } from '../../config/constants.js';
import { isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import { validatePlayerAlias, validatePlayerDisplayName } from '../policies/playerIdentityPolicy.js';
import { countsAsWolf, getMediumResult, getPlayerTeam, getSeerResult, isActualFox, isFoxFactionMember } from '../roles/roleAttributes.js';
import { validateGameRules } from './gameRulePolicy.js';

export function getRole(roleId) {
  return ROLE_DEFINITIONS[roleId] ?? null;
}

export function getPlayer(state, playerId) {
  return state.players.find((player) => player.id === playerId) ?? null;
}

export function getAlivePlayers(state) {
  return state.players.filter((player) => player.alive);
}

export function getDeadPlayers(state) {
  return state.players.filter((player) => !player.alive);
}

export function getPlayersByRole(state, roleId, { aliveOnly = false } = {}) {
  return state.players.filter((player) => player.roleId === roleId && (!aliveOnly || player.alive));
}

export function getAliveWolfIds(state) {
  return getAlivePlayers(state).filter((player) => countsAsWolf(state, player)).map((player) => player.id);
}

export function validateComposition(state) {
  const errors = [];
  const warnings = [];
  const count = state.players.length;
  if (count < MIN_PLAYER_COUNT || count > MAX_PLAYER_COUNT) {
    errors.push(`参加人数は${MIN_PLAYER_COUNT}～${MAX_PLAYER_COUNT}人にしてください。`);
  }

  const ids = state.players.map((player) => player.id);
  if (new Set(ids).size !== ids.length) errors.push('プレイヤーIDが重複しています。');

  const names = state.players.map((player) => String(player.name ?? '').trim()).filter(Boolean);
  if (names.length !== state.players.length) errors.push('未入力のプレイヤー名があります。');
  if (new Set(names).size !== names.length) errors.push('プレイヤー名が重複しています。');

  state.players.forEach((player, index) => {
    const displayName = String(player.name ?? '').trim();
    const displayValidation = validatePlayerDisplayName(displayName);
    displayValidation.errors.forEach((message) => {
      errors.push(`参加者${index + 1}: ${message}`);
    });

    const aliases = Array.isArray(player.aliases) ? player.aliases : [];
    aliases.forEach((alias, aliasIndex) => {
      const aliasValidation = validatePlayerAlias(alias);
      aliasValidation.errors.forEach((message) => {
        errors.push(`${displayName || `参加者${index + 1}`}の別名${aliasIndex + 1}: ${message}`);
      });
    });
    if (new Set(aliases.map((alias) => String(alias).trim())).size !== aliases.length) {
      errors.push(`${displayName || `参加者${index + 1}`}の別名が重複しています。`);
    }
  });

  const characterCardIds = state.players.map((player) => player.characterCardId).filter(Boolean);
  if (new Set(characterCardIds).size !== characterCardIds.length) {
    errors.push('同じキャラクターカードが複数のプレイヤーへ設定されています。');
  }

  state.players.forEach((player) => {
    if (!ROLE_IDS.includes(player.roleId)) errors.push(`${player.name}の役職が不正です。`);
  });

  Object.values(ROLE_DEFINITIONS).forEach((role) => {
    if (!role.maxCount) return;
    const assigned = state.players.filter((player) => player.roleId === role.id).length;
    if (assigned > role.maxCount) errors.push(`${role.name}は最大${role.maxCount}人までです。`);
  });

  const wolfCount = state.players.filter((player) => countsAsWolf(state, player)).length;
  if (wolfCount < 1) errors.push('人狼を1人以上設定してください。');
  if (wolfCount >= count - wolfCount) errors.push('開始時点で人狼勝利条件を満たす配役です。');

  const rules = state.game.rules;
  errors.push(...validateGameRules(rules, { label: 'ゲームルール' }));
  if (rules.firstNight.seerMode === 'random-non-wolf' && !state.players.some((player) => player.roleId === 'seer')) {
    warnings.push('占い師がいないため、初日ランダム白占い設定は使用されません。');
  }
  if (count <= 6) warnings.push('少人数では1回の処刑または襲撃が勝敗へ強く影響します。');
  if (rules.wolfCommunication.enabled && rules.wolfCommunication.participantMode === 'wolves-and-madman') {
    warnings.push('狂人が人狼共有会話へ参加する特殊ルールです。人狼と狂人が互いを認識します。');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function getVoteCandidates(state, voterId, candidateIds = null) {
  const allowed = new Set(candidateIds ?? getAlivePlayers(state).map((player) => player.id));
  return getAlivePlayers(state).filter((player) => {
    if (!allowed.has(player.id)) return false;
    if (!state.game.rules.vote.selfVoteAllowed && player.id === voterId) return false;
    return true;
  });
}

export function isValidVoteTarget(state, voterId, targetId, candidateIds = null) {
  if (targetId === 'abstain') return Boolean(state.game.rules.vote.abstentionAllowed);
  return getVoteCandidates(state, voterId, candidateIds).some((player) => player.id === targetId);
}

export function getInspectCandidates(state, actorId) {
  const previousTargets = state.events
    .filter((event) => event.status !== 'voided' && event.type === 'night-action' && event.actorId === actorId && event.payload?.actionType === 'inspect')
    .map((event) => event.payload.targetId);
  return getAlivePlayers(state).filter((player) => {
    if (!state.game.rules.seer.selfTargetAllowed && player.id === actorId) return false;
    if (!state.game.rules.seer.repeatedTargetAllowed && previousTargets.includes(player.id)) return false;
    return true;
  });
}

export function getGuardCandidates(state, actorId) {
  const previousGuard = [...state.events]
    .reverse()
    .find((event) => event.status !== 'voided' && event.type === 'night-action' && event.actorId === actorId && event.payload?.actionType === 'guard');
  return getAlivePlayers(state).filter((player) => {
    if (!state.game.rules.guard.selfGuardAllowed && player.id === actorId) return false;
    if (!state.game.rules.guard.consecutiveGuardAllowed && previousGuard?.payload?.targetId === player.id) return false;
    return true;
  });
}

export function getAttackCandidates(state) {
  return getAlivePlayers(state).filter((player) => !countsAsWolf(state, player));
}

export function getVisitCandidates(state, actorId) {
  const actor = getPlayer(state, actorId);
  return getAlivePlayers(state).filter((player) => player.id !== actorId && player.id !== actor?.roleState?.lastTargetId);
}

export function getFreezeCandidates(state, actorId) {
  const actor = getPlayer(state, actorId);
  return getAlivePlayers(state).filter((player) => player.id !== actorId && player.id !== actor?.roleState?.lastTargetId);
}

export function getOwnerCandidates(state, actorId) {
  return getAlivePlayers(state).filter((player) => player.id !== actorId);
}

export function getNightActionCandidates(state, actionType, actorId) {
  const normalized = String(actionType ?? '').trim();
  if (!isPersonalNightActionTask(normalized)) {
    throw new RangeError(`個人夜行動ではないタスクの候補は算出できません: ${normalized || '(empty)'}`);
  }
  if (normalized === 'inspect') return getInspectCandidates(state, actorId);
  if (normalized === 'guard') return getGuardCandidates(state, actorId);
  if (normalized === 'visit') return getVisitCandidates(state, actorId);
  if (normalized === 'freeze') return getFreezeCandidates(state, actorId);
  if (normalized === 'choose-owner') return getOwnerCandidates(state, actorId);
  throw new Error(`個人夜行動の候補算出が未実装です: ${normalized}`);
}

export function inspectResult(state, targetId) {
  return getSeerResult(state, targetId);
}

export function mediumResult(state, targetId) {
  return getMediumResult(state, targetId);
}


export function getStrictMajorityCount(aliveCount) {
  return Math.floor(Math.max(0, Number(aliveCount) || 0) / 2) + 1;
}

export function evaluateWolfPopulation(aliveWolfCount, aliveNonWolfCount) {
  const wolves = Math.max(0, Number(aliveWolfCount) || 0);
  const nonWolves = Math.max(0, Number(aliveNonWolfCount) || 0);
  if (wolves === 0) return 'village-win';
  if (wolves >= nonWolves) return 'wolf-win';
  return 'continue';
}

export function detectWinner(state, aliveOverride = null) {
  const alivePlayers = aliveOverride ?? getAlivePlayers(state);
  const aliveWolves = alivePlayers.filter((player) => countsAsWolf(state, player)).length;
  const aliveFoxFaction = alivePlayers.filter((player) => isFoxFactionMember(state, player)).length;
  const aliveNonWolves = alivePlayers.length - aliveWolves;
  const outcome = evaluateWolfPopulation(aliveWolves, aliveNonWolves);
  if (outcome === 'continue') return null;
  if (aliveFoxFaction > 0) {
    return { winner: 'fox', reason: '村人陣営または人狼陣営の勝利条件成立時に妖狐が生存していました。' };
  }
  if (outcome === 'village-win') {
    return { winner: 'village', reason: '生存している人狼が0人になりました。' };
  }
  return { winner: 'wolf', reason: '生存人狼数がその他の生存者数以上になりました。' };
}

export function roleSummary(state) {
  const counts = new Map();
  state.players.forEach((player) => counts.set(player.roleId, (counts.get(player.roleId) ?? 0) + 1));
  return [...counts.entries()]
    .map(([roleId, count]) => `${getRole(roleId)?.name ?? roleId}×${count}`)
    .join('、');
}
