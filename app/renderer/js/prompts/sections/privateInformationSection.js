/**
 * 責務: 本人限定情報、正式本人履歴、最新判断、ゲーム状態、公開確定時系列、人口・勝利条件をプロンプト用データへ変換する。
 * 変更ルール: promptContext.jsが許可した可視情報だけを使用し、他人の秘密情報や推定役職を混入させない。AIターン履歴・継続アンカー・当日カプセルを参照せず、現在の正式状態を正本とする。公開会話のdeltaとは独立して、処刑・夜明けの確定時系列と本人夜行動直後の公開結果を短く保持する。公開CO・公開能力結果・処刑履歴は自然文へ潰さず、判断時に直接比較できる構造化要約として出力する。
 */

import {
  PHASE_LABELS,
  ROLE_DEFINITIONS,
} from '../../config/constants.js';
import { publicAbilityResultLabel } from '../../domain/policies/publicAbilityClaimPolicy.js';
import {
  lines,
  playerName,
  formatPromptEventText,
} from './promptFormatters.js';

function publicEvents(context) {
  return Object.values(context.board.publicTimeline ?? {})
    .flatMap((items) => Array.isArray(items) ? items : []);
}

function publicSequenceByEventId(context, eventId) {
  if (!eventId) return null;
  const event = publicEvents(context).find((item) => [
    item.id,
    ...(item.correctionLineageIds ?? []),
    item.payload?.correctsEventId,
  ].filter(Boolean).includes(eventId));
  return Number.isInteger(Number(event?.sequence)) ? Number(event.sequence) : null;
}


function publicDeadNames(context, event) {
  const ids = event?.payload?.deadPlayerIds ?? event?.targetIds ?? [];
  return [...new Set(ids.map((id) => playerName(context, id, '')).filter(Boolean))];
}

function publicOutcomeHistory(context) {
  return publicEvents(context)
    .filter((event) => ['execution', 'dawn'].includes(event.type))
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
    .map((event) => {
      const day = Number(event.day ?? 0);
      const deaths = publicDeadNames(context, event);
      if (event.type === 'execution') {
        return {
          ref: `#${event.sequence}`,
          timing: `D${day}処刑`,
          phase: 'execution',
          deaths,
        };
      }
      return {
        ref: `#${event.sequence}`,
        timing: `D${Math.max(0, day - 1)}夜→D${day}朝`,
        phase: 'dawn',
        deaths,
        noDeaths: deaths.length === 0,
      };
    });
}

function followingDawnOutcome(context, nightDay) {
  if (!Number.isInteger(nightDay) || nightDay < 0) return null;
  const dawn = (context.board.publicTimeline?.dawns ?? [])
    .find((event) => Number(event.day) === nightDay + 1);
  if (!dawn) return null;
  const deaths = publicDeadNames(context, dawn);
  return {
    ref: `#${dawn.sequence}`,
    timing: `D${nightDay}夜→D${nightDay + 1}朝`,
    deaths,
    noDeaths: deaths.length === 0,
  };
}

function actionTiming(event, taskType) {
  if (event.type === 'vote-cast' || taskType === 'vote') return `D${Number(event.day)}昼・投票`;
  const nightDay = Number(event.payload?.nightDay ?? event.day);
  if (Number.isInteger(nightDay)) return nightDay === 0 ? 'D0初夜' : `D${nightDay}夜`;
  return `D${Number(event.day)}`;
}

function actionLabel(taskType) {
  return {
    vote: '投票',
    inspect: '占い',
    guard: '護衛',
    visit: '訪問',
    freeze: '凍結',
    'choose-owner': '家主選択',
    'wolf-attack': '襲撃',
  }[taskType] ?? taskType;
}

function rationaleForEvent(context, event) {
  const rationales = context.ownHistory.actionRationales ?? [];
  return rationales.find((item) => item.active !== false && item.sourceEventId === event.id)
    ?? [...rationales].reverse().find((item) => item.active !== false
      && item.taskType === (event.type === 'vote-cast' ? 'vote' : event.payload?.actionType)
      && Number(item.day) === Number(event.day)
      && item.targetId === (event.payload?.targetId ?? event.targetIds?.[0] ?? null))
    ?? null;
}

function formalAction(context, event) {
  const taskType = event.type === 'vote-cast' ? 'vote' : String(event.payload?.actionType ?? 'night-action');
  const targetId = event.payload?.targetId ?? event.targetIds?.[0] ?? null;
  const rationale = rationaleForEvent(context, event);
  const nightDay = event.type === 'night-action'
    ? Number(event.payload?.nightDay ?? event.day)
    : null;
  return {
    ref: `P#${event.sequence} ${actionTiming(event, taskType)}`,
    day: Number(event.day),
    taskType,
    action: actionLabel(taskType),
    target: targetId === 'abstain' ? '棄権' : targetId ? playerName(context, targetId) : null,
    rationale: String(rationale?.rationale ?? event.payload?.rationale ?? '').trim() || null,
    followingDawn: event.type === 'night-action' ? followingDawnOutcome(context, nightDay) : null,
  };
}

function actionPromptLine(item) {
  const target = item.target ? `→${item.target}` : '';
  const rationale = item.rationale ? ` / 理由: ${item.rationale}` : '';
  const dawn = item.followingDawn
    ? ` / 直後の公開結果: ${item.followingDawn.ref} ${item.followingDawn.timing} ${item.followingDawn.noDeaths ? '死亡者なし' : `死亡=${item.followingDawn.deaths.join('、')}`}`
    : '';
  return `${item.ref} ${item.action}${target}${rationale}${dawn}`;
}

function standaloneRationaleActions(context) {
  const sourceEventIds = new Set([
    ...(context.ownHistory.votes ?? []),
    ...(context.ownHistory.nightActions ?? []),
  ].map((event) => event.id));
  return (context.ownHistory.actionRationales ?? [])
    .filter((item) => item.active !== false && !sourceEventIds.has(item.sourceEventId))
    .map((item) => ({
      ref: item.sourceEventId
        ? `D${Number(item.day)} ${PHASE_LABELS[item.phase] ?? item.phase ?? '行動'}`
        : `D${Number(item.day)} ${actionLabel(item.taskType)}`,
      day: Number(item.day),
      taskType: item.taskType,
      action: actionLabel(item.taskType),
      target: item.targetId === 'abstain' ? '棄権' : item.targetId ? playerName(context, item.targetId) : null,
      rationale: String(item.rationale ?? '').trim() || null,
    }));
}

function ownFormalActions(context) {
  return [
    ...(context.ownHistory.votes ?? []).map((event) => formalAction(context, event)),
    ...(context.ownHistory.nightActions ?? []).map((event) => formalAction(context, event)),
    ...standaloneRationaleActions(context),
  ].sort((left, right) => Number(left.day) - Number(right.day)
    || String(left.ref).localeCompare(String(right.ref)));
}

function publishedAbilityClaim(context, claim) {
  return {
    publicRef: publicSequenceByEventId(context, claim.sourceEventId)
      ? `#${publicSequenceByEventId(context, claim.sourceEventId)} D${claim.announcedDay}`
      : null,
    role: ROLE_DEFINITIONS[claim.claimedRoleId]?.name ?? claim.claimedRoleId,
    resultDay: Number(claim.observedDay),
    target: playerName(context, claim.targetId),
    result: publicAbilityResultLabel(claim.result, claim.claimedRoleId),
    selectionBasis: claim.selectionBasis ?? null,
    evidenceEventSequences: (claim.evidenceEventIds ?? [])
      .map((eventId) => publicSequenceByEventId(context, eventId))
      .filter(Number.isInteger),
    selectionReasonAtTime: String(claim.selectionReasonAtTime ?? '').trim() || null,
  };
}

export function privateInformation(context, { mode = 'full' } = {}) {
  const { player } = context;
  const shared = {
    owner: player.knowledge.knownOwnerId
      ? {
        name: playerName(context, player.knowledge.knownOwnerId),
        role: ROLE_DEFINITIONS[player.knowledge.knownOwnerRoleId]?.name ?? player.knowledge.knownOwnerRoleId ?? '不明',
      }
      : null,
    abilityResults: context.private.abilityResults
      .map((event) => `P#${event.sequence} D${event.day} ${formatPromptEventText(context, event)}`),
    personalNotifications: context.private.personalNotifications
      .map((event) => `P#${event.sequence} D${event.day} ${formatPromptEventText(context, event)}`),
  };

  if (mode === 'night-action') return shared;
  if (mode !== 'full') throw new RangeError(`未定義の本人限定情報形式です: ${mode}`);

  return {
    ...shared,
    privateInfo: player.privateInfo || null,
    knownWolves: player.knowledge.knownWolfIds
      .filter((id) => id !== player.id)
      .map((id) => playerName(context, id)),
    knownMadmen: player.knowledge.knownMadmanIds.map((id) => playerName(context, id)),
    knownMasons: player.knowledge.knownMasonIds
      .filter((id) => id !== player.id)
      .map((id) => playerName(context, id)),
  };
}

export function ownHistory(context, { mode = 'full' } = {}) {
  const allActions = ownFormalActions(context);
  const freezeJudgment = context.ownHistory.latestFreezeJudgment;
  if (mode === 'night-actions-only') {
    const taskType = context.task.type;
    return {
      actions: allActions.filter((item) => item.taskType === taskType).slice(-4).map(actionPromptLine),
    };
  }
  if (mode === 'wolf-strategy') {
    return {
      actions: allActions.filter((item) => item.taskType === 'wolf-attack').slice(-4).map(actionPromptLine),
    };
  }
  if (mode !== 'full') throw new RangeError(`未定義の本人履歴形式です: ${mode}`);
  return {
    actions: allActions.slice(-12).map(actionPromptLine),
    roleClaims: context.ownHistory.roleClaims.map((claim) => ({
      role: ROLE_DEFINITIONS[claim.roleId]?.name ?? claim.roleId,
      status: claim.status,
    })),
    publishedAbilityClaims: (context.ownHistory.publishedAbilityClaims ?? []).map((claim) => publishedAbilityClaim(context, claim)),
    latestFreezeJudgment: freezeJudgment ? {
      nightDay: freezeJudgment.nightDay,
      frozenTarget: freezeJudgment.targetId ? playerName(context, freezeJudgment.targetId) : null,
      actionRationale: freezeJudgment.actionRationale || null,
    } : null,
  };
}

export function gameStateData(context, { mode = 'full' } = {}) {
  const aliveIds = new Set(context.board.alive.map((item) => item.id));
  const shared = {
    day: context.game.day,
    phase: PHASE_LABELS[context.game.phase] ?? context.game.phase,
    alive: context.board.alive.map((item) => item.name),
    publicOutcomes: publicOutcomeHistory(context),
    publicClaims: context.board.claims.map((claim) => ({
      player: playerName(context, claim.actorId),
      role: ROLE_DEFINITIONS[claim.roleId]?.name ?? claim.roleId,
      ...(Number.isInteger(Number(claim.day)) ? { claimDay: Number(claim.day) } : {}),
      alive: aliveIds.has(claim.actorId),
    })),
    publishedResults: context.board.publicAbilityClaims.map((claim) => ({
      reporter: playerName(context, claim.actorId),
      role: ROLE_DEFINITIONS[claim.claimedRoleId]?.name ?? claim.claimedRoleId,
      target: playerName(context, claim.targetId),
      result: publicAbilityResultLabel(claim.result, claim.claimedRoleId),
      resultDay: Number(claim.observedDay),
      ...(Number.isInteger(Number(claim.announcedDay)) ? { announcedDay: Number(claim.announcedDay) } : {}),
    })),
  };
  if (mode === 'night-compact' || mode === 'full') return shared;
  throw new RangeError(`未定義のゲーム状態形式です: ${mode}`);
}

export function latestDecisionState(context, decision, { taskType = context.task.type } = {}) {
  const originalState = context.player.decisionState ?? {};
  if (!originalState.updatedAt || context.player.decisionInvalidation?.usablePreviousDecision === false) return null;
  const state = originalState;
  const isVoteTask = taskType === 'vote';
  return {
    suspicionCandidateNames: (state.suspicionCandidateIds ?? []).map((id) => playerName(context, id)),
    executionCandidateNames: (state.executionCandidateIds ?? []).map((id) => playerName(context, id)),
    ...(!isVoteTask ? {
      intendedVote: state.intendedVoteId === 'abstain'
        ? '棄権'
        : state.intendedVoteId
          ? playerName(context, state.intendedVoteId)
          : null,
    } : {}),
    assessmentLevel: state.assessmentLevel ?? 'unresolved',
    evidenceEventSequences: (state.keyPublicEvidenceEventIds ?? []).map((eventId) => {
      const event = Object.values(context.board.publicTimeline ?? {})
        .flatMap((items) => Array.isArray(items) ? items : [])
        .find((item) => item.id === eventId);
      return event?.sequence ? Number(event.sequence) : null;
    }).filter(Boolean),
    leaveAliveBenefit: state.leaveAliveBenefit || null,
    misexecutionCost: state.misexecutionCost || null,
    selectionDifference: state.selectionDifference || null,
    uncertainty: state.uncertainty || null,
    nextDiscriminatingInformation: state.nextDiscriminatingInformation || null,
    ...(!isVoteTask ? { decisionReason: state.decisionReason || null } : {}),
    newPublicEventSequences: (decision?.decisionDelta?.newPublicEvents ?? [])
      .map((event) => Number(event.sequence ?? 0))
      .filter((sequence) => Number.isInteger(sequence) && sequence > 0),
  };
}

export function decisionInvalidationState(context) {
  const invalidation = context.player.decisionInvalidation ?? {};
  if (invalidation.invalidationReason !== 'target-unavailable') return null;
  return {
    reason: invalidation.invalidationReason ?? 'context-changed',
    removedTargets: (invalidation.removedTargetIds ?? []).map((id) => playerName(context, id)),
    remainingCandidates: (invalidation.remainingCandidateIds ?? []).map((id) => playerName(context, id)),
    invalidatedSemanticFields: [...(invalidation.invalidatedSemanticFields ?? [])],
    requiresReevaluation: true,
  };
}

export function roleInspectionFacts(context) {
  const composition = context.game.roleComposition ?? {};
  const countRows = [];
  const resultRows = [];
  const wolfCount = Number(composition.wolf ?? 0);
  const whiteWolfCount = Number(composition.whiteWolf ?? 0);
  if (whiteWolfCount > 0) {
    if (wolfCount > 0) countRows.push(`開始時の通常人狼数: ${wolfCount}`);
    countRows.push(`開始時の白狼数: ${whiteWolfCount}`);
    if (wolfCount > 0) resultRows.push('- 人狼: 人狼');
    resultRows.push('- 白狼: 人狼ではない');
  }
  if (!countRows.length) return '';
  return resultRows.length
    ? `${countRows.join('\n')}\n\n占い判定:\n${resultRows.join('\n')}`
    : countRows.join('\n');
}

export function populationSection(context, decision) {
  const wolfState = decision.population.knownAliveWolfCount !== null
    ? `把握している生存人狼: ${decision.population.knownAliveWolfCount}人`
    : '生存人狼: 未確定（人数ごとに結果分岐）';
  const rows = [
    `生存者: ${decision.population.aliveCount}人 / 単独過半数: ${decision.population.majorityThreshold}票`,
    `開始時人狼: ${decision.population.configuredWolfCount}人 / ${wolfState}`,
  ];
  const inspectionFacts = roleInspectionFacts(context);
  return `${lines(rows)}${inspectionFacts ? `

${inspectionFacts}` : ''}`;
}
