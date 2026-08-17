/**
 * 責務: 夜行動の開始前に共通状態異常を評価し、行動を実行できるかと消費する状態を純粋に決定する。
 * 変更ルール: 効果解決・死亡・護衛・状態反映を行わない。共同アクションは構成員全員が阻害された場合だけ行動全体を阻害し、その場合だけ恐怖を消費する。
 */

import { getPlayer } from '../game/standardRules.js';
import { getFearActionGroup, isBadChild } from '../roles/roleAttributes.js';

export const FEAR_STATUS_TYPE = 'fear';

function uniqueIds(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

export function hasStatusEffect(player, statusType) {
  return Boolean(player?.statusEffects?.some((effect) => effect.type === statusType));
}

export function buildFearStatusApplications(state, visitSlots = []) {
  return visitSlots
    .filter((slot) => slot?.actorId && slot?.targetId)
    .map((slot) => ({
      type: FEAR_STATUS_TYPE,
      sourcePlayerId: slot.actorId,
      targetPlayerId: slot.targetId,
      appliedNightDay: Number(state?.night?.day ?? state?.game?.day ?? 0),
    }))
    .filter((application) => {
      const target = getPlayer(state, application.targetPlayerId);
      return Boolean(target?.alive && isBadChild(state, target));
    });
}

export function resolveActionExecution(state, {
  actionType,
  actorIds = [],
  statusApplications = [],
  required = true,
} = {}) {
  const normalizedActorIds = uniqueIds(actorIds).filter((actorId) => {
    const actor = getPlayer(state, actorId);
    return Boolean(actor?.alive && getFearActionGroup(state, actor) === actionType);
  });
  if (!required || !normalizedActorIds.length) {
    return {
      actionType,
      actorIds: [],
      fearfulActorIds: [],
      executionState: 'not-required',
      blockReason: null,
      consumedFearPlayerIds: [],
    };
  }

  const appliedFearIds = new Set(
    statusApplications
      .filter((application) => application?.type === FEAR_STATUS_TYPE)
      .map((application) => application.targetPlayerId),
  );
  const fearfulActorIds = normalizedActorIds.filter((actorId) => {
    const actor = getPlayer(state, actorId);
    return hasStatusEffect(actor, FEAR_STATUS_TYPE) || appliedFearIds.has(actorId);
  });
  const blocked = fearfulActorIds.length === normalizedActorIds.length;

  return {
    actionType,
    actorIds: normalizedActorIds,
    fearfulActorIds,
    executionState: blocked ? 'blocked' : 'executed',
    blockReason: blocked ? FEAR_STATUS_TYPE : null,
    consumedFearPlayerIds: blocked ? [...fearfulActorIds] : [],
  };
}

export function applyResolvedFearStatuses(state, resolution, deadPlayerIds = []) {
  const deadIds = new Set(deadPlayerIds);
  const applications = resolution?.statusApplications ?? [];
  const consumedIds = new Set(
    (resolution?.actionExecutions ?? [])
      .flatMap((execution) => execution?.consumedFearPlayerIds ?? []),
  );

  applications
    .filter((application) => application?.type === FEAR_STATUS_TYPE)
    .forEach((application) => {
      const target = getPlayer(state, application.targetPlayerId);
      if (!target?.alive || deadIds.has(target.id) || consumedIds.has(target.id)) return;
      target.statusEffects ??= [];
      if (hasStatusEffect(target, FEAR_STATUS_TYPE)) return;
      target.statusEffects.push({
        type: FEAR_STATUS_TYPE,
        day: Number(application.appliedNightDay),
        sourcePlayerId: application.sourcePlayerId,
      });
    });

  if (!consumedIds.size) return;
  state.players.forEach((player) => {
    if (!consumedIds.has(player.id)) return;
    player.statusEffects = (player.statusEffects ?? []).filter((effect) => effect.type !== FEAR_STATUS_TYPE);
  });
}
