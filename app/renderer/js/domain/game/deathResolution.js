/**
 * 責務: 夜・処刑の一次死亡と猫又道連れを生成し、共通の後続死亡解決で座敷わらしの後追いを一度だけ追加する。
 * 変更ルール: プレイヤー状態・イベント・フェーズを変更しない。乱数は引数から受け取り、各進行パイプラインは一次死亡をresolveFollowUpDeathsへ必ず一度渡す。道連れ死亡による猫又能力の連鎖は発生させない。
 */
import { getPlayer } from './standardRules.js';
import { countsAsWolf, isActualFox } from '../roles/roleAttributes.js';

function chooseRandom(values, random) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))] ?? null;
}

function uniqueDeaths(deaths) {
  const byId = new Map();
  deaths.forEach((death) => {
    if (!death?.playerId || byId.has(death.playerId)) return;
    byId.set(death.playerId, {
      playerId: death.playerId,
      cause: death.cause,
      triggerPlayerId: death.triggerPlayerId ?? null,
      sourcePlayerIds: [...(death.sourcePlayerIds ?? [])],
      selectedBy: death.selectedBy ?? null,
    });
  });
  return [...byId.values()];
}

export function resolveNightDeaths(state, {
  attackedTargetId = null,
  guardedTargetIds = [],
  inspections = [],
  random = Math.random,
} = {}) {
  const deaths = [];
  const gmNotes = [];
  const foxInspectionSources = new Map();
  inspections.forEach((inspection) => {
    const target = getPlayer(state, inspection?.targetId);
    if (!target?.alive || !isActualFox(state, target)) return;
    const sources = foxInspectionSources.get(target.id) ?? [];
    if (inspection?.actorId && !sources.includes(inspection.actorId)) sources.push(inspection.actorId);
    foxInspectionSources.set(target.id, sources);
  });
  const inspectedFoxIds = [...foxInspectionSources.keys()];
  inspectedFoxIds.forEach((foxId) => {
    deaths.push({
      playerId: foxId,
      cause: 'fox-divination',
      triggerPlayerId: null,
      sourcePlayerIds: [...(foxInspectionSources.get(foxId) ?? [])],
      selectedBy: 'rule',
    });
  });

  const attacked = getPlayer(state, attackedTargetId);
  const guarded = attackedTargetId && guardedTargetIds.includes(attackedTargetId);
  let attackOutcome = 'not-required';
  let catCollateralWolfId = null;
  if (attacked?.alive) {
    if (isActualFox(state, attacked)) {
      attackOutcome = 'fox-immune';
      gmNotes.push('襲撃対象は妖狐だったため死亡しませんでした。');
    } else if (guarded) {
      attackOutcome = 'guarded';
      gmNotes.push('襲撃は実行されましたが、護衛により効果が発生しませんでした。');
    } else {
      attackOutcome = 'killed';
      deaths.push({
        playerId: attacked.id,
        cause: 'wolf-attack',
        triggerPlayerId: null,
        sourcePlayerIds: state.players.filter((player) => player.alive && countsAsWolf(state, player)).map((player) => player.id),
        selectedBy: 'rule',
      });
      if (attacked.roleId === 'cat') {
        const aliveWolves = state.players.filter((player) => player.alive && countsAsWolf(state, player));
        const selectedWolf = chooseRandom(aliveWolves, random);
        if (selectedWolf) {
          catCollateralWolfId = selectedWolf.id;
          deaths.push({
            playerId: selectedWolf.id,
            cause: 'cat-revenge',
            triggerPlayerId: attacked.id,
            sourcePlayerIds: [attacked.id],
            selectedBy: 'random',
          });
        }
      }
    }
  }

  return {
    deaths: uniqueDeaths(deaths),
    attackOutcome,
    inspectedFoxIds,
    catCollateralWolfId,
    gmNotes,
  };
}



export function resolveFollowUpDeaths(state, deaths) {
  const resolved = uniqueDeaths(deaths);
  const deadIds = new Set(resolved.map((death) => death.playerId));
  state.players
    .filter((player) => player.alive && player.roleId === 'zashikiWarashi' && player.roleState?.ownerId)
    .forEach((player) => {
      if (!deadIds.has(player.roleState.ownerId) || deadIds.has(player.id)) return;
      resolved.push({
        playerId: player.id,
        cause: 'owner-follow',
        triggerPlayerId: player.roleState.ownerId,
        sourcePlayerIds: [player.roleState.ownerId],
        selectedBy: 'rule',
      });
      deadIds.add(player.id);
    });
  return uniqueDeaths(resolved);
}

export function resolveExecutionDeaths(state, executedPlayerId, random = Math.random) {
  const executed = getPlayer(state, executedPlayerId);
  if (!executed?.alive) return { deaths: [], collateralPlayerId: null };
  const deaths = [{
    playerId: executed.id,
    cause: 'execution',
    triggerPlayerId: null,
    sourcePlayerIds: [],
    selectedBy: 'vote',
  }];
  let collateralPlayerId = null;
  if (executed.roleId === 'cat') {
    const candidates = state.players.filter((player) => player.alive && player.id !== executed.id);
    const selected = chooseRandom(candidates, random);
    if (selected) {
      collateralPlayerId = selected.id;
      deaths.push({
        playerId: selected.id,
        cause: 'cat-revenge',
        triggerPlayerId: executed.id,
        sourcePlayerIds: [executed.id],
        selectedBy: 'random',
      });
    }
  }
  return { deaths: uniqueDeaths(deaths), collateralPlayerId };
}
