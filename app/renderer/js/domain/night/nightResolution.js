/**
 * 責務: 状態付与・行動開始判定・護衛・襲撃・凍結・占い・後追いを定められた順序で調停し、夜の確定結果を生成する。
 * 変更ルール: 状態を変更しない。恐怖は共通の行動開始判定へ委譲し、行動阻害と実行後の効果不成立を別項目で保持する。襲撃は全生存人狼が恐怖の時だけ阻害する。
 */

import { resolveNightDeaths, resolveFollowUpDeaths } from '../game/deathResolution.js';
import { getFearActionParticipantIds } from '../roles/roleAttributes.js';
import {
  buildFearStatusApplications,
  resolveActionExecution,
} from './actionExecutionPolicy.js';

export function resolveNightActions(state, {
  attackedTargetId = null,
  guardSlots = [],
  inspectSlots = [],
  visitSlots = [],
  freezeSlots = [],
  random = Math.random,
} = {}) {
  const submittedVisits = visitSlots.filter((slot) => slot.targetId);
  const submittedFreezes = freezeSlots.filter((slot) => slot.targetId);
  const guardedTargetIds = [...new Set(guardSlots.map((slot) => slot.targetId).filter(Boolean))];
  const statusApplications = buildFearStatusApplications(state, submittedVisits);

  const attackExecution = resolveActionExecution(state, {
    actionType: 'wolf-attack',
    actorIds: getFearActionParticipantIds(state, 'wolf-attack'),
    statusApplications,
    required: Boolean(attackedTargetId),
  });
  const executedAttackedTargetId = attackExecution.executionState === 'executed'
    ? attackedTargetId
    : null;

  const freezeSlot = submittedFreezes[0] ?? null;
  const freezeExecution = resolveActionExecution(state, {
    actionType: 'freeze',
    actorIds: freezeSlot ? [freezeSlot.actorId] : [],
    statusApplications,
    required: Boolean(freezeSlot),
  });
  const executedFreezeTargetId = freezeExecution.executionState === 'executed'
    ? freezeSlot?.targetId ?? null
    : null;

  const baseDeaths = resolveNightDeaths(state, {
    attackedTargetId: executedAttackedTargetId,
    guardedTargetIds,
    inspections: inspectSlots.map((slot) => ({ actorId: slot.actorId, targetId: slot.targetId })),
    random,
  });
  if (attackExecution.executionState === 'blocked') baseDeaths.attackOutcome = 'not-executed';

  const deaths = resolveFollowUpDeaths(state, baseDeaths.deaths);
  const deadIds = new Set(deaths.map((death) => death.playerId));

  let freezeOutcome = 'not-required';
  let frozenPlayerId = null;
  if (freezeSlot) {
    if (freezeExecution.executionState === 'blocked') freezeOutcome = 'not-executed';
    else if (guardedTargetIds.includes(executedFreezeTargetId)) freezeOutcome = 'guarded';
    else if (deadIds.has(executedFreezeTargetId)) freezeOutcome = 'target-dead';
    else {
      freezeOutcome = 'applied';
      frozenPlayerId = executedFreezeTargetId;
    }
  }

  const gmNotes = [...baseDeaths.gmNotes];
  if (attackExecution.executionState === 'blocked') gmNotes.push('生存人狼全員が恐怖状態のため、襲撃行動は実行されませんでした。');
  if (freezeExecution.executionState === 'blocked') gmNotes.push('雪女が恐怖状態のため、凍結行動は実行されませんでした。');
  else if (freezeOutcome === 'guarded') gmNotes.push('凍結は実行されましたが、対象が護衛されていたため効果が発生しませんでした。');
  else if (freezeOutcome === 'target-dead') gmNotes.push('凍結は実行されましたが、対象が同じ夜に死亡したため翌日の凍結状態は付与されません。');

  return {
    ...baseDeaths,
    deaths,
    guardedTargetIds,
    successfulGuardActorIds: baseDeaths.attackOutcome === 'guarded'
      ? guardSlots.filter((slot) => slot.targetId === executedAttackedTargetId).map((slot) => slot.actorId)
      : [],
    statusApplications,
    actionExecutions: [attackExecution, freezeExecution],
    attackedTargetId: executedAttackedTargetId,
    freezeActorId: freezeSlot?.actorId ?? null,
    freezeTargetId: executedFreezeTargetId,
    freezeOutcome,
    frozenPlayerId,
    gmNotes,
  };
}
