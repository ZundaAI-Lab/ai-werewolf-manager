/**
 * 責務: 勝敗公開後の感想順序と、各キャラクター向けに勝敗・全員の確定役職・CO・能力結果・処刑・夜結果だけを、訂正後の論理時系列で重複なく導出する。
 * 変更ルール: 状態を更新しない。通常会話、疑い、信用、投票先、投票理由を感想用経過へ混在させない。公開事実は訂正後の正式イベント、本人の実能力結果と夜行動は本人可視イベントを正本とする。同一能力結果の再発表は意味単位で統合し、離脱後の出来事は結果を知った時点で区画単位に分ける。感想本文の生成・保存・表示は担当しない。
 */

import {
  PHASE_LABELS,
  ROLE_DEFINITIONS,
  TEAM_LABELS,
} from '../../config/constants.js';
import {
  collectCorrectionLineageIds,
  getCorrectionRootEvent,
} from '../events/correctionLineage.js';
import { publicAbilityResultLabel } from '../policies/publicAbilityClaimPolicy.js';
import { buildAbilityClaimTiming, formatAbilityClaimTiming } from '../policies/abilityClaimTimingPolicy.js';
import { getPlayerTeam } from '../roles/roleAttributes.js';

const ACTION_LABELS = Object.freeze({
  inspect: '占い',
  medium: '霊能',
  guard: '護衛',
  visit: '訪問',
  freeze: '凍結',
  'choose-owner': '家主選択',
});

const PHASE_ORDER = Object.freeze({
  briefing: 0,
  dawn: 1,
  discussion: 2,
  vote: 3,
  runoff: 4,
  execution: 5,
  night: 6,
  result: 7,
  ended: 8,
});

const DEATH_CAUSE_LABELS = Object.freeze({
  execution: '処刑',
  'wolf-attack': '人狼襲撃',
  'fox-divination': '占い',
  'cat-revenge': '猫又の道連れ',
  'owner-follow': '家主の死亡による後追い',
});

function bySequence(left, right) {
  return Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}

function logicalPublicEvent(state, event) {
  if (event.type !== 'public-speech') {
    return {
      ...event,
      correctionLineageIds: [event.id].filter(Boolean),
    };
  }
  const root = getCorrectionRootEvent(state.events, event) ?? event;
  return {
    ...event,
    sequence: Number(root.sequence ?? event.sequence ?? 0),
    day: Number(root.day ?? event.day ?? 0),
    phase: String(root.phase ?? event.phase ?? ''),
    correctionLineageIds: collectCorrectionLineageIds(state.events, event),
  };
}

function activePublishedPublicEvents(state, type = null) {
  return (state.events ?? [])
    .filter((event) => event.status === 'published'
      && event.audience?.type === 'public'
      && (!type || event.type === type))
    .map((event) => logicalPublicEvent(state, event))
    .sort(bySequence);
}

export function getPublishedResultImpressions(state) {
  return activePublishedPublicEvents(state, 'result-impression');
}

export function getPendingResultImpressionPlayerId(state) {
  const completed = new Set(getPublishedResultImpressions(state).map((event) => event.actorId));
  return (state.players ?? []).find((player) => !completed.has(player.id))?.id ?? null;
}

export function areResultImpressionsComplete(state) {
  return Boolean((state.players ?? []).length)
    && getPendingResultImpressionPlayerId(state) === null;
}

function playerName(state, playerId) {
  const player = (state.players ?? []).find((item) => String(item.id) === String(playerId));
  return String(player?.name ?? playerId ?? '不明');
}

function roleName(roleId) {
  return String((ROLE_DEFINITIONS[roleId]?.name ?? roleId) || '不明');
}

function publicAbilityRoleIdForActionType(actionType) {
  const normalized = String(actionType ?? '');
  return Object.values(ROLE_DEFINITIONS).find((role) => (
    role.publicAbilityClaim?.actionType === normalized
  ))?.id ?? null;
}

function allRoles(players) {
  return Object.freeze((players ?? []).map((player) => Object.freeze({
    playerName: String(player?.name ?? player?.id ?? '不明'),
    roleName: roleName(player?.roleId),
  })));
}

function eventSourceIds(event) {
  return [...new Set([
    ...(event?.correctionLineageIds ?? []),
    event?.id,
  ].filter(Boolean).map(String))];
}

function eventDeadPlayerIds(event) {
  return new Set([
    ...(event?.targetIds ?? []),
    ...(event?.payload?.deadPlayerIds ?? []),
  ].map(String));
}

function findExitEvent(publicEvents, player) {
  if (!player?.death) return null;
  return publicEvents.find((event) => (
    ['execution', 'dawn'].includes(event.type)
    && eventDeadPlayerIds(event).has(String(player.id))
  )) ?? null;
}

function knowledgeTiming(sequence, exitEvent) {
  if (!exitEvent) return 'experienced';
  return Number(sequence ?? 0) > Number(exitEvent.sequence ?? 0)
    ? 'after-exit'
    : 'experienced';
}

function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? String(phase ?? '');
}

function createFact({
  sequence,
  knowledgeSequence = sequence,
  order = 0,
  day,
  phase,
  type,
  text,
  factKey,
  sourceEventIds = [],
  abilityIdentity = null,
}) {
  return {
    sequence: Number(sequence ?? 0),
    knowledgeSequence: Number(knowledgeSequence ?? sequence ?? 0),
    order: Number(order ?? 0),
    day: Number(day ?? 0),
    phaseKey: String(phase ?? ''),
    phase: phaseLabel(phase),
    type,
    text: String(text ?? '').trim(),
    factKey: String(factKey ?? ''),
    sourceEventIds: [...new Set(sourceEventIds.filter(Boolean).map(String))],
    abilityIdentity: abilityIdentity ? { ...abilityIdentity } : null,
  };
}

function roleClaimFacts(state, publicEvents) {
  const activeRoleByActor = new Map();
  const actorIdsByRole = new Map();
  const facts = [];

  const removeActorClaim = (actorId) => {
    const previousRoleId = activeRoleByActor.get(actorId);
    if (!previousRoleId) return;
    const actors = actorIdsByRole.get(previousRoleId) ?? new Set();
    actors.delete(actorId);
    if (actors.size) actorIdsByRole.set(previousRoleId, actors);
    else actorIdsByRole.delete(previousRoleId);
    activeRoleByActor.delete(actorId);
  };

  publicEvents
    .filter((event) => event.type === 'public-speech')
    .forEach((event) => {
      const operation = event?.payload?.structured?.coOperation ?? null;
      if (!operation || operation.action === 'none') return;
      const actorId = String(event.actorId ?? '');
      const actor = playerName(state, actorId);
      const previousRoleId = activeRoleByActor.get(actorId) ?? null;

      if (operation.action === 'withdraw') {
        removeActorClaim(actorId);
        facts.push(createFact({
          sequence: event.sequence,
          day: event.day,
          phase: event.phase,
          type: 'role-claim',
          text: previousRoleId
            ? `${actor}が${roleName(previousRoleId)}COを撤回した。`
            : `${actor}が役職COを撤回した。`,
          factKey: `role-claim:${actorId}:withdraw:${previousRoleId ?? 'none'}:${event.sequence}`,
          sourceEventIds: eventSourceIds(event),
        }));
        return;
      }

      if (!['declare', 'change'].includes(operation.action)) return;
      const claimedRoleId = String(operation.roleId ?? '');
      if (!claimedRoleId || claimedRoleId === 'none') return;
      if (previousRoleId === claimedRoleId) return;

      removeActorClaim(actorId);
      const existingActors = actorIdsByRole.get(claimedRoleId) ?? new Set();
      const isCounter = [...existingActors].some((id) => id !== actorId);
      existingActors.add(actorId);
      actorIdsByRole.set(claimedRoleId, existingActors);
      activeRoleByActor.set(actorId, claimedRoleId);

      let text = `${actor}が${roleName(claimedRoleId)}をCOした。`;
      if (operation.action === 'change') {
        text = `${actor}がCOを${roleName(claimedRoleId)}へ変更した。`;
      } else if (isCounter) {
        text = `${actor}が対抗して${roleName(claimedRoleId)}をCOした。`;
      }
      facts.push(createFact({
        sequence: event.sequence,
        day: event.day,
        phase: event.phase,
        type: 'role-claim',
        text,
        factKey: `role-claim:${actorId}:${operation.action}:${previousRoleId ?? 'none'}:${claimedRoleId}:${event.sequence}`,
        sourceEventIds: eventSourceIds(event),
      }));
    });

  return facts;
}

function abilityBaseKey(identity) {
  return [
    identity?.actorId ?? '',
    identity?.actionType ?? '',
    identity?.targetId ?? '',
    Number(identity?.actionDay ?? 0),
  ].join('\u0000');
}

function abilitySemanticKey(identity) {
  return `${abilityBaseKey(identity)}\u0000${identity?.result ?? ''}`;
}

function publicAbilityClaimFacts(state, publicEvents) {
  return publicEvents
    .filter((event) => event.type === 'public-speech')
    .flatMap((event) => (event?.payload?.structured?.abilityClaims ?? [])
      .filter((claim) => claim?.action === 'publish')
      .map((claim, index) => {
        const actorId = String(event.actorId ?? '');
        const actor = playerName(state, actorId);
        const claimedRoleId = String(claim.claimedRoleId ?? claim.roleId ?? '');
        const actionType = String(ROLE_DEFINITIONS[claimedRoleId]?.publicAbilityClaim?.actionType ?? '');
        const targetId = String(claim.targetId ?? '');
        const result = String(claim.result ?? 'unknown');
        const actionDay = Number(claim.actionDay ?? 0);
        const identity = {
          actorId,
          actionType,
          claimedRoleId,
          targetId,
          result,
          actionDay,
          actionPhase: String(claim.actionPhase ?? ''),
          availableDay: Number(claim.availableDay ?? 0),
          availablePhase: String(claim.availablePhase ?? ''),
        };
        return createFact({
          sequence: event.sequence,
          order: 20 + index,
          day: event.day,
          phase: event.phase,
          type: 'ability-result',
          text: `${actor}が${roleName(claimedRoleId)}として、${formatAbilityClaimTiming(claim)}の${playerName(state, targetId)}を「${publicAbilityResultLabel(result, claimedRoleId)}」と発表した。`,
          factKey: `ability-public:${abilitySemanticKey(identity)}`,
          sourceEventIds: eventSourceIds(event),
          abilityIdentity: identity,
        });
      }));
}

function privateResultText(state, event) {
  const payload = event.payload ?? {};
  const actionType = String(payload.actionType ?? '');
  const actor = playerName(state, event.actorId);
  const targetId = String(payload.targetId ?? event.targetIds?.[0] ?? '');
  const target = playerName(state, targetId);
  const abilityRoleId = publicAbilityRoleIdForActionType(actionType);
  if (['wolf', 'not-wolf', 'unknown'].includes(payload.result)) {
    if (actionType === 'medium') return `${actor}の霊能結果は、${target}が「${publicAbilityResultLabel(payload.result, abilityRoleId)}」だった。`;
    return `${actor}の${ACTION_LABELS[actionType] ?? '能力'}結果は、${target}が「${publicAbilityResultLabel(payload.result, abilityRoleId)}」だった。`;
  }
  if (actionType === 'choose-owner') {
    const ownerRole = roleName(payload.ownerRoleId);
    const team = TEAM_LABELS[payload.resolvedTeam] ?? String(payload.resolvedTeam ?? '不明');
    return `${actor}が${target}を家主に選び、家主の役職が${ownerRole}、自身の最終所属が${team}に確定した。`;
  }
  return `${actor}が${target}へ${ACTION_LABELS[actionType] ?? '能力'}を行った。`;
}

function ownPrivateResultFacts(state, playerId) {
  return (state.events ?? [])
    .filter((event) => event.type === 'private-result'
      && String(event.actorId ?? '') === String(playerId ?? '')
      && ['confirmed', 'published'].includes(event.status))
    .sort(bySequence)
    .map((event) => {
      const payload = event.payload ?? {};
      const actionType = String(payload.actionType ?? '');
      const targetId = String(payload.targetId ?? event.targetIds?.[0] ?? '');
      const actionDay = actionType === 'medium'
        ? Math.max(0, Number(payload.availableFromDay ?? event.day ?? 1) - 1)
        : Number(payload.nightDay ?? event.day ?? 0);
      const timing = buildAbilityClaimTiming(publicAbilityRoleIdForActionType(actionType), actionDay);
      const identity = {
        actorId: String(event.actorId ?? ''),
        actionType,
        roleId: publicAbilityRoleIdForActionType(actionType),
        targetId,
        result: String(payload.result ?? ''),
        actionDay,
        actionPhase: timing?.actionPhase ?? (actionType === 'medium' ? 'execution' : 'night'),
        availableDay: timing?.availableDay ?? actionDay + 1,
        availablePhase: timing?.availablePhase ?? 'day',
      };
      return createFact({
        sequence: event.sequence,
        order: 40,
        day: actionDay,
        phase: payload.nightDay !== undefined || actionType === 'choose-owner' ? 'night' : event.phase,
        type: 'ability-result',
        text: privateResultText(state, event),
        factKey: `ability-private:${abilitySemanticKey(identity)}`,
        sourceEventIds: [event.id],
        abilityIdentity: identity,
      });
    });
}

function abilityComparisonText(state, publicFact, privateFact) {
  const publicIdentity = publicFact.abilityIdentity ?? {};
  const privateIdentity = privateFact.abilityIdentity ?? {};
  const actor = playerName(state, publicIdentity.actorId);
  const target = playerName(state, publicIdentity.targetId);
  const actionLabel = ACTION_LABELS[privateIdentity.actionType || publicIdentity.actionType] ?? '能力';
  const publicLabel = publicAbilityResultLabel(publicIdentity.result, publicIdentity.claimedRoleId ?? publicAbilityRoleIdForActionType(publicIdentity.actionType));
  const privateLabel = publicAbilityResultLabel(privateIdentity.result, privateIdentity.roleId ?? publicAbilityRoleIdForActionType(privateIdentity.actionType));
  const timingText = formatAbilityClaimTiming(publicIdentity) || formatAbilityClaimTiming(privateIdentity);
  if (publicIdentity.result === privateIdentity.result) {
    return `${actor}の${timingText}の${target}への${actionLabel}結果は「${privateLabel}」で、公開した内容と一致していた。`;
  }
  return `${actor}は${timingText}の${target}を「${publicLabel}」と発表したが、実際の${actionLabel}結果は「${privateLabel}」だった。`;
}

function mergePublicAndPrivateAbilityFacts(state, publicFacts, privateFacts) {
  const privateByBase = new Map();
  privateFacts.forEach((fact) => {
    const base = abilityBaseKey(fact.abilityIdentity);
    if (base && !privateByBase.has(base)) privateByBase.set(base, fact);
  });

  const consumedPrivateBases = new Set();
  const seenPublicSemantics = new Set();
  const merged = [];

  [...publicFacts].sort((left, right) => left.sequence - right.sequence || left.order - right.order)
    .forEach((fact) => {
      const identity = fact.abilityIdentity ?? {};
      const semantic = abilitySemanticKey(identity);
      if (seenPublicSemantics.has(semantic)) return;
      seenPublicSemantics.add(semantic);
      const base = abilityBaseKey(identity);
      const privateFact = privateByBase.get(base) ?? null;
      if (!privateFact) {
        merged.push(fact);
        return;
      }
      consumedPrivateBases.add(base);
      merged.push({
        ...fact,
        text: abilityComparisonText(state, fact, privateFact),
        factKey: `ability-combined:${semantic}:${privateFact.abilityIdentity?.result ?? ''}`,
        sourceEventIds: [...new Set([...fact.sourceEventIds, ...privateFact.sourceEventIds])],
      });
    });

  privateFacts.forEach((fact) => {
    if (!consumedPrivateBases.has(abilityBaseKey(fact.abilityIdentity))) merged.push(fact);
  });
  return merged;
}

function executionFacts(state, publicEvents) {
  const facts = [];
  publicEvents.forEach((event) => {
    if (event.type === 'vote-finalized') {
      const result = event.payload?.result ?? {};
      if (result.type !== 'no-execution') return;
      const text = result.resolution === 'tie-no-execution'
        ? '同票のため、この日の処刑者はいなかった。'
        : '有効票がないため、この日の処刑者はいなかった。';
      facts.push(createFact({
        sequence: event.sequence,
        day: event.day,
        phase: event.phase,
        type: 'execution-result',
        text,
        factKey: `execution:none:${event.day}:${result.resolution ?? 'none'}`,
        sourceEventIds: eventSourceIds(event),
      }));
      return;
    }
    if (event.type !== 'execution') return;
    const targetId = String(event.payload?.targetId ?? event.targetIds?.[0] ?? '');
    const collateralIds = (event.payload?.collateralPlayerIds ?? [])
      .map(String)
      .filter((id) => id && id !== targetId);
    const collateralText = collateralIds.length
      ? `さらに${collateralIds.map((id) => playerName(state, id)).join('、')}が死亡した。`
      : '';
    facts.push(createFact({
      sequence: event.sequence,
      day: event.day,
      phase: event.phase,
      type: 'execution-result',
      text: `投票の結果、${playerName(state, targetId)}が処刑された。${collateralText}`,
      factKey: `execution:${event.day}:${targetId}:${collateralIds.join(',')}`,
      sourceEventIds: eventSourceIds(event),
    }));
  });
  return facts;
}

function dawnOutcomeParts(state, dawnEvent, excludedDeadIds = new Set(), excludedFrozenIds = new Set()) {
  const allDeadIds = [...eventDeadPlayerIds(dawnEvent)];
  const deadIds = allDeadIds.filter((id) => !excludedDeadIds.has(id));
  const frozenIds = (dawnEvent.payload?.frozenPlayerIds ?? []).map(String);
  const parts = deadIds.map((deadId) => {
    const player = (state.players ?? []).find((item) => String(item.id) === deadId);
    const cause = String(player?.death?.cause ?? '');
    const label = DEATH_CAUSE_LABELS[cause] ?? '夜行動';
    return `${label}により、${playerName(state, deadId)}が死亡した。`;
  });
  if (!allDeadIds.length) parts.push('夜行動の結果、死亡者はいなかった。');
  frozenIds
    .filter((id) => !excludedFrozenIds.has(id))
    .forEach((frozenId) => {
      parts.push(`${playerName(state, frozenId)}が凍結され、その日の昼会話と投票に参加できなくなった。`);
    });
  return parts;
}

function ownNightActionSentence(state, event, dawnEvent) {
  const payload = event.payload ?? {};
  const actionType = String(payload.actionType ?? '');
  const actor = playerName(state, event.actorId);
  const targetId = String(payload.targetId ?? event.targetIds?.[0] ?? '');
  const target = playerName(state, targetId);
  if (actionType === 'guard') {
    const targetDiedByAttack = eventDeadPlayerIds(dawnEvent).has(targetId)
      && String((state.players ?? []).find((item) => String(item.id) === targetId)?.death?.cause ?? '') === 'wolf-attack';
    return targetDiedByAttack
      ? `${actor}は${target}を護衛したが、人狼襲撃による死亡を防げなかった。`
      : `${actor}は${target}を護衛した。`;
  }
  if (actionType === 'visit') return `${actor}は${target}を訪問した。`;
  if (actionType === 'freeze') {
    const frozen = (dawnEvent?.payload?.frozenPlayerIds ?? []).map(String).includes(targetId);
    return frozen
      ? `${actor}は${target}を凍結し、翌日の昼会話と投票に参加できなくした。`
      : `${actor}は${target}の凍結を試みたが、効果は発生しなかった。`;
  }
  return `${actor}は${target}へ${ACTION_LABELS[actionType] ?? '夜行動'}を行った。`;
}

function nightResultFacts(state, publicEvents, playerId, privateFacts) {
  const privateActionKeys = new Set(privateFacts.map((fact) => abilityBaseKey(fact.abilityIdentity)));
  const ownActionsByNight = new Map();
  (state.events ?? [])
    .filter((event) => event.type === 'night-action'
      && String(event.actorId ?? '') === String(playerId ?? '')
      && ['confirmed', 'published'].includes(event.status))
    .sort(bySequence)
    .forEach((event) => {
      const payload = event.payload ?? {};
      const actionType = String(payload.actionType ?? '');
      const targetId = String(payload.targetId ?? event.targetIds?.[0] ?? '');
      const nightDay = Number(payload.nightDay ?? event.day ?? 0);
      const base = abilityBaseKey({ actorId: event.actorId, actionType, targetId, actionDay: nightDay });
      if (actionType === 'choose-owner' || privateActionKeys.has(base)) return;
      const events = ownActionsByNight.get(nightDay) ?? [];
      events.push(event);
      ownActionsByNight.set(nightDay, events);
    });

  const dawnByNight = new Map();
  publicEvents
    .filter((event) => event.type === 'dawn')
    .forEach((event) => dawnByNight.set(Math.max(0, Number(event.day ?? 0) - 1), event));

  const nightDays = [...new Set([...ownActionsByNight.keys(), ...dawnByNight.keys()])].sort((a, b) => a - b);
  return nightDays.map((nightDay) => {
    const actions = ownActionsByNight.get(nightDay) ?? [];
    const dawnEvent = dawnByNight.get(nightDay) ?? null;
    const deathsCoveredByOwnAction = new Set();
    const frozenByOwnAction = new Set();
    const actionParts = actions.map((event) => {
      const actionType = String(event.payload?.actionType ?? '');
      const targetId = String(event.payload?.targetId ?? event.targetIds?.[0] ?? '');
      if (actionType === 'guard') {
        const targetDiedByAttack = eventDeadPlayerIds(dawnEvent).has(targetId)
          && String((state.players ?? []).find((item) => String(item.id) === targetId)?.death?.cause ?? '') === 'wolf-attack';
        if (targetDiedByAttack) deathsCoveredByOwnAction.add(targetId);
      }
      if (actionType === 'freeze' && (dawnEvent?.payload?.frozenPlayerIds ?? []).map(String).includes(targetId)) {
        frozenByOwnAction.add(targetId);
      }
      return ownNightActionSentence(state, event, dawnEvent);
    });
    const outcomeParts = dawnEvent ? dawnOutcomeParts(state, dawnEvent, deathsCoveredByOwnAction, frozenByOwnAction) : [];
    const sequence = Number(dawnEvent?.sequence ?? actions.at(-1)?.sequence ?? 0);
    const sourceEventIds = [
      ...actions.flatMap((event) => [event.id]),
      ...(dawnEvent ? eventSourceIds(dawnEvent) : []),
    ];
    const actionSemantic = actions.map((event) => [
      event.actorId,
      event.payload?.actionType,
      event.payload?.targetId ?? event.targetIds?.[0] ?? '',
    ].join(':')).join('|');
    const outcomeSemantic = dawnEvent
      ? `${[...eventDeadPlayerIds(dawnEvent)].sort().join(',')}:${(dawnEvent.payload?.frozenPlayerIds ?? []).map(String).sort().join(',')}`
      : 'no-dawn';
    return createFact({
      sequence,
      knowledgeSequence: Number(dawnEvent?.sequence ?? sequence),
      order: 80,
      day: nightDay,
      phase: 'night',
      type: 'night-result',
      text: [...actionParts, ...outcomeParts].join(''),
      factKey: `night-result:${nightDay}:${actionSemantic}:${outcomeSemantic}`,
      sourceEventIds,
    });
  });
}

function deduplicateFacts(facts) {
  const byKey = new Map();
  facts
    .filter((fact) => fact.text && fact.factKey)
    .sort((left, right) => left.sequence - right.sequence || left.order - right.order)
    .forEach((fact) => {
      const existing = byKey.get(fact.factKey);
      if (!existing) {
        byKey.set(fact.factKey, { ...fact, sourceEventIds: [...fact.sourceEventIds] });
        return;
      }
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...fact.sourceEventIds])];
      existing.knowledgeSequence = Math.max(existing.knowledgeSequence, fact.knowledgeSequence);
    });
  return [...byKey.values()].sort((left, right) => left.sequence - right.sequence || left.order - right.order);
}

function groupedGameFlow(facts, exitEvent) {
  const grouped = new Map();
  deduplicateFacts(facts).forEach((fact) => {
    const timing = knowledgeTiming(fact.knowledgeSequence, exitEvent);
    const key = `${fact.day}\u0000${fact.phaseKey}\u0000${timing}`;
    const group = grouped.get(key) ?? {
      day: fact.day,
      phaseKey: fact.phaseKey,
      phase: fact.phase,
      knowledgeTiming: timing,
      firstSequence: fact.sequence,
      firstOrder: fact.order,
      events: [],
    };
    if (fact.sequence < group.firstSequence || (fact.sequence === group.firstSequence && fact.order < group.firstOrder)) {
      group.firstSequence = fact.sequence;
      group.firstOrder = fact.order;
    }
    group.events.push(Object.freeze({
      type: fact.type,
      text: fact.text,
      sourceEventIds: Object.freeze([...fact.sourceEventIds]),
    }));
    grouped.set(key, group);
  });

  return Object.freeze([...grouped.values()]
    .sort((left, right) => (left.day - right.day)
      || ((PHASE_ORDER[left.phaseKey] ?? 99) - (PHASE_ORDER[right.phaseKey] ?? 99))
      || (left.firstSequence - right.firstSequence)
      || (left.firstOrder - right.firstOrder))
    .map(({ firstSequence, firstOrder, phaseKey, ...group }) => Object.freeze({
      ...group,
      events: Object.freeze(group.events),
    })));
}

export function buildResultImpressionContext(state, playerId) {
  const player = (state.players ?? []).find((item) => item.id === playerId) ?? null;
  const publicEvents = activePublishedPublicEvents(state)
    .filter((event) => !['game-result', 'result-impression', 'correction'].includes(event.type));
  const exitEvent = findExitEvent(publicEvents, player);
  const winner = String(state.result?.winner ?? state.game?.winner ?? 'draw');
  const playerTeam = getPlayerTeam(state, player);
  const personalResult = winner === 'draw'
    ? '引き分け'
    : playerTeam === winner
      ? '勝利'
      : '敗北';

  const privateAbilityFacts = ownPrivateResultFacts(state, playerId);
  const abilityFacts = mergePublicAndPrivateAbilityFacts(
    state,
    publicAbilityClaimFacts(state, publicEvents),
    privateAbilityFacts,
  );
  const facts = [
    ...roleClaimFacts(state, publicEvents),
    ...abilityFacts,
    ...executionFacts(state, publicEvents),
    ...nightResultFacts(state, publicEvents, playerId, privateAbilityFacts),
  ];

  return Object.freeze({
    gameResult: Object.freeze({
      winner: TEAM_LABELS[winner] ?? '引き分け',
      reason: String(state.result?.reason ?? state.game?.winnerReason ?? '').trim(),
    }),
    yourResult: Object.freeze({
      finalTeam: TEAM_LABELS[playerTeam] ?? String(playerTeam ?? '不明'),
      result: personalResult,
    }),
    allRoles: allRoles(state.players),
    gameFlow: groupedGameFlow(facts, exitEvent),
  });
}
