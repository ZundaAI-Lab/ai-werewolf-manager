/**
 * 責務: 昼会話の進行、CO機会、能力結果主張、役職別戦術機会をプロンプトへ構成する。
 * 変更ルール: 局面判定と候補抽出は既存ポリシーを正本とし、本文から質問・CO・能力結果を推定しない。昼の発言順はdiscussion.queueを正本として表示し、別順序を再構成しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import {
  renderTwoSeerExecutionInstruction,
  renderWolfBlackResultCrisisInstruction,
  renderWolfDayStrategyInstruction,
  renderWhiteWolfDayStrategyInstruction,
  renderMadmanDayStrategyInstruction,
  renderMadmanClaimBranchInstruction,
  renderEndgameFactionTacticsInstruction,
  renderCounterClaimOpportunityInstruction,
  renderOwnerClaimCorroborationInstruction,
  renderWolfInitialClaimDecisionInstruction,
  renderMadmanInitialClaimDecisionInstruction,
} from '../templates/promptTemplates.js';

import { renderPromptDataBlock } from '../serialization/promptDataSerializer.js';
import {
  OPENING_CONVERSATION_MODES,
  isInitialClaimDecisionSituation,
} from '../policies/openingSpeechPolicy.js';

import {
  playerName,
  formatAbilityClaim,
} from './promptFormatters.js';

function compressSequenceRanges(values) {
  const numbers = [...new Set((values ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
  const ranges = [];
  let start = null;
  let end = null;
  for (const value of numbers) {
    if (start === null) {
      start = value;
      end = value;
      continue;
    }
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = value;
    end = value;
  }
  if (start !== null) ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges;
}

function displayAbilityEvidenceCutoffs(cutoffs) {
  return Object.fromEntries(Object.entries(cutoffs ?? {}).map(([day, value]) => [day, {
    eligibleEvidenceEventSequenceRanges: compressSequenceRanges(value?.eligibleEvidenceRefs),
  }]));
}
export function claimTimingSection(context) {
  const facts = context.board.claimTimingFacts ?? [];
  if (!facts.length) return '';
  const rows = facts.map((fact) => {
    const timing = fact.opportunityContext ?? {};
    const opportunity = timing.hadPriorRecordedOpportunity
      ? `以前の本人発言${Number(timing.priorSpeechCountToday ?? 0)}回・後回し${Number(timing.priorDeferralCountToday ?? 0)}回` 
      : '当日最初の本人発言で、以前にCOを保留した記録なし';
    const prior = (fact.priorStructuredEventSequences ?? []).length
      ? `公開前に閲覧可能なCO・能力結果: ${(fact.priorStructuredEventSequences ?? []).map((sequence) => `#${sequence}`).join('、')}`
      : '公開前に閲覧可能なCO・能力結果なし';
    return `#${fact.sequence} ${playerName(context, fact.actorId)}: ${opportunity}。${prior}`;
  });
  return `## 公開順序と発言機会
${renderPromptDataBlock('claim-timing', rows)}`;
}

export function responseOpportunityData(context, conversationMode = 'normal') {
  if (!context.game.discussion || conversationMode === OPENING_CONVERSATION_MODES.FIRST_SPEAKER) return null;
  const discussion = context.game.discussion;
  const answerPriorityEnabled = context.game.rules.discussion.answerPriorityEnabled === true;
  const canReply = context.board.alive
    .filter((player) => player.id !== context.player.id && !player.frozen)
    .filter((player) => {
      if (answerPriorityEnabled) return true;
      const remaining = discussion.remainingByPlayer?.[player.id];
      return Number(remaining ?? 0) > 0;
    })
    .map((player) => player.name);
  const allOtherAlive = context.board.alive
    .filter((player) => player.id !== context.player.id && !player.frozen)
    .map((player) => player.name);
  return {
    canReply: canReply.length === allOtherAlive.length && canReply.every((name) => allOtherAlive.includes(name))
      ? 'all-other-alive'
      : canReply,
  };
}

export function dayConversationStatusSection(context, taskType, { conversationMode = 'normal' } = {}) {
  if (!isNormalSpeechTask(taskType)) return '';
  const currentDay = Number(context.game.day);
  const spokenIds = new Set(
    (context.board.publicTimeline?.speeches ?? [])
      .filter((event) => Number(event.day) === currentDay && event.payload?.speechKind === 'normal')
      .map((event) => event.actorId)
      .filter(Boolean),
  );
  const otherPlayersNotYetSpoken = context.board.alive
    .filter((player) => player.id !== context.player.id && !spokenIds.has(player.id))
    .map((player) => player.name);
  const discussion = context.game.discussion ?? {};
  const speakingOrder = (discussion.queue ?? [])
    .map((id) => playerName(context, id, ''))
    .filter(Boolean);
  const opportunities = responseOpportunityData(context, conversationMode);
  const replyScope = opportunities?.canReply ?? null;
  const instruction = !opportunities
    ? '他者発言なし。laterSpeakersの反応を作らないでください。'
    : replyScope === 'all-other-alive'
      ? 'laterSpeakersの反応を作らず、質問は本人以外の生存者へ行えます。'
      : 'laterSpeakersの反応を作らず、質問先はcanReplyだけです。';
  return `## 昼の会話状況
${renderPromptDataBlock('day-conversation-status', {
    order: speakingOrder,
    laterSpeakers: otherPlayersNotYetSpoken,
    ...(Array.isArray(replyScope) ? { canReply: replyScope } : {}),
  })}

${instruction}`;
}

export function orderedFutureTurn(context) {
  const discussion = context.game.discussion;
  if (!discussion || discussion.mode !== 'ordered') return null;
  const selfId = context.player.id;
  const remaining = { ...(discussion.remainingByPlayer ?? {}) };
  const includingCurrent = Math.max(0, Number(remaining[selfId] ?? 0));
  if (includingCurrent <= 1) return { futureOpportunities: 0, speakersBeforeNext: [] };
  remaining[selfId] = includingCurrent - 1;
  const queue = [...(discussion.queue ?? [])];
  const currentIndex = queue[discussion.currentIndex] === selfId
    ? discussion.currentIndex
    : queue.indexOf(selfId);
  const laterThisRound = currentIndex >= 0
    ? queue.slice(currentIndex + 1).filter((id) => Number(remaining[id] ?? 0) > 0)
    : [];
  const nextRound = context.board.alive.map((item) => item.id).filter((id) => Number(remaining[id] ?? 0) > 0);
  const selfNextIndex = nextRound.indexOf(selfId);
  const beforeSelfNextRound = selfNextIndex > 0 ? nextRound.slice(0, selfNextIndex) : [];
  return {
    futureOpportunities: includingCurrent - 1,
    speakersBeforeNext: [...laterThisRound, ...beforeSelfNextRound],
  };
}

export function currentSpeakerPosition(context) {
  const queue = context.game.discussion?.queue ?? [];
  const index = queue.indexOf(context.player.id);
  if (index < 0 || !queue.length) return '不明';
  return `${index + 1}番目 / ${queue.length}人`;
}

export function latestWolfClaimPlan(context) {
  const current = String(context.wolfCommunication.current?.sharedStrategy?.claimPlan ?? '').trim();
  if (current) return current;
  const past = [...(context.wolfCommunication.past ?? [])].reverse()
    .map((item) => String(item.sharedStrategy?.claimPlan ?? '').trim())
    .find(Boolean);
  return past || '共有作戦に明示なし';
}

export function initialClaimDecisionSection(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || taskType === 'priority-answer') || !isInitialClaimDecisionSituation(context)) return '';
  if (context.player.roleId === 'whiteWolf') return '';
  if (context.player.strategyProfile === 'wolf') {
    return renderWolfInitialClaimDecisionInstruction({
      sharedClaimPlan: latestWolfClaimPlan(context),
      speakerPosition: currentSpeakerPosition(context),
    });
  }
  if (context.player.strategyProfile === 'madman') {
    return renderMadmanInitialClaimDecisionInstruction({
      speakerPosition: currentSpeakerPosition(context),
    });
  }
  return '';
}

export function wolfBlackResultCrisisSection(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || taskType === 'priority-answer')
    || context.player.strategyProfile !== 'wolf'
    || context.player.roleId === 'whiteWolf') return '';
  if (!context.board.alive.some((player) => player.id === context.player.id)) return '';
  const accuserIds = context.board.publicAbilityClaims
    .filter((claim) => claim.targetId === context.player.id && claim.result === 'wolf')
    .map((claim) => claim.actorId);
  const uniqueAccuserNames = [...new Set(accuserIds)].map((id) => playerName(context, id));
  if (!uniqueAccuserNames.length) return '';
  return renderWolfBlackResultCrisisInstruction({ accuserNames: uniqueAccuserNames });
}

export function guardClaimTimingSection(context, taskType, { mode = 'none' } = {}) {
  if (mode === 'none' || !(isNormalSpeechTask(taskType) || taskType === 'priority-answer') || context.player.roleId !== 'guard') return '';
  const ownActiveClaim = context.board.claims.find((claim) => claim.actorId === context.player.id);
  if (ownActiveClaim?.roleId === 'guard') return '';
  const discussion = context.game.discussion;
  const remainingNormalSpeeches = Math.max(0, Number(discussion?.remainingByPlayer?.[context.player.id] ?? 0));
  const futureTurn = isNormalSpeechTask(taskType) ? orderedFutureTurn(context) : null;
  const guardClaims = context.board.claims.filter((claim) => claim.roleId === 'guard');
  const revealExecutedRole = Boolean(context.game.rules.vote.revealExecutedRole);
  const rows = [
    `現在の発言巡: ${discussion?.round ?? '不明'}巡目`,
    isNormalSpeechTask(taskType)
      ? `今回を含む自分の残り通常発言回数: ${remainingNormalSpeeches}回`
      : `この回答後に残る自分の通常発言回数: ${remainingNormalSpeeches}回（回答フェーズ自体は通常発言数を消費しない）`,
  ];
  if (isNormalSpeechTask(taskType) && futureTurn) {
    rows.push(`今回の後に残る自分の発言機会: ${futureTurn.futureOpportunities}回`);
  } else if (taskType === 'priority-answer' && discussion?.mode === 'ordered') {
    rows.push(remainingNormalSpeeches > 0
      ? `回答後にも通常発言機会が${remainingNormalSpeeches}回残ります。今すぐCOする利益と、次の通常発言まで公開情報を待つ利益を比較してください。`
      : '回答後に予定された通常発言機会はありません。CO・能力結果を公開する必要があるなら、この回答が最後の公開機会になる可能性を考慮してください。');
  } else if (discussion?.mode === 'designated' || discussion?.mode === 'free') {
    rows.push('次の通常発言機会は指名または発言希望制の進行で変化します。');
  }
  rows.push(`現在公開中の狩人CO: ${guardClaims.length ? guardClaims.map((claim) => playerName(context, claim.actorId)).join('、') : 'なし'}`);
  rows.push(`処刑時の役職公開: ${revealExecutedRole ? '公開される' : '公開されない'}`);
  rows.push('即時CO、後の発言機会までの保留、潜伏継続を、当日の処刑危険、今夜の護衛機会、狼へ与える狩人位置情報、後日のCO判別で比較してください。');
  rows.push(`潜伏継続では護衛能力と狩人候補の不確実性を残します。処刑された場合は能力を失い、役職が${revealExecutedRole ? '公開されるため狩人生存の不確実性は残りません' : '公開されないため、狼側には狩人が生存している可能性が残ります'}。`);
  rows.push('潜伏またはCO保留を選ぶ場合、公開発言へ自分の護衛対象、護衛履歴、護衛を外したこと、護衛成否、自分が護衛能力を持つことを含めてはいけません。');
  rows.push('「昨夜○○を護衛した」と公開した時点で、同じ発言内に「狩人COはしない」と書いても狩人COです。同じ応答でCO操作をguardのdeclareまたはchangeとし、能力結果主張へ公開する全履歴を連番で記載してください。');

  if (mode === 'detailed') {
    if (isNormalSpeechTask(taskType) && futureTurn?.futureOpportunities > 0) {
      const names = futureTurn.speakersBeforeNext.map((id) => playerName(context, id));
      rows.push(`次の自分の発言までに入る予定の発言: 延べ${names.length}人分${names.length ? `（${names.join('、')}）` : ''}`);
    } else if (isNormalSpeechTask(taskType) && futureTurn) {
      rows.push('順番制では今回が自分の最後の予定発言です。');
    }
    rows.push('現在COした場合は票・対抗情報を動かし、今夜一度の護衛機会を得る可能性がある一方、狼が狩人位置を把握して本人を襲撃候補にできます。');
    rows.push('COを後の発言機会まで保留した場合は票の動きを観察できますが、その間に処刑候補が固定し、公開機会を失う可能性があります。');
  }

  return `## 狩人COの時期によって変化する情報
${renderPromptDataBlock('role-decision', rows)}`;
}

export function twoSeerExecutionDecisionSection(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType))) return '';
  const aliveIds = new Set(context.board.alive.map((player) => player.id));
  const seerClaims = (context.board.claims ?? [])
    .filter((claim) => claim.roleId === 'seer' && aliveIds.has(claim.actorId));
  if (seerClaims.length !== 2) return '';
  return renderTwoSeerExecutionInstruction({
    seerNames: seerClaims.map((claim) => playerName(context, claim.actorId)),
  });
}

export function endgameFactionTacticsSection(context, taskType, { enabled = false } = {}) {
  if (!enabled || !(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType))) return '';
  return renderEndgameFactionTacticsInstruction({
    strategyProfile: context.player.strategyProfile,
    team: context.player.team,
    taskType,
  });
}

export function wolfPartnerPublicPositionSection(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType)) || context.player.strategyProfile !== 'wolf') return '';
  const positions = context.wolfPartnerPublicPositions ?? [];
  if (!positions.length) return '';
  return `## 生存仲間の現在の公開位置
${renderPromptDataBlock('wolf-partner-public-positions', positions)}`;
}

export function wolfDayStrategySection(context, taskType, partnerDispositionPolicy) {
  if (!(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType)) || context.player.strategyProfile !== 'wolf') return '';
  if (context.player.roleId === 'whiteWolf') {
    return renderWhiteWolfDayStrategyInstruction({ voteRequired: taskType === 'vote' });
  }
  const alivePartnerNames = (partnerDispositionPolicy?.alivePartnerIds ?? [])
    .map((id) => playerName(context, id));
  return renderWolfDayStrategyInstruction({
    alivePartnerNames,
    allowedPartnerDispositions: partnerDispositionPolicy?.allowedValues ?? [],
    voteRequired: taskType === 'vote',
  });
}

export function madmanDayStrategySection(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType)) || context.player.strategyProfile !== 'madman') return '';
  const activeClaim = context.board.claims.find((claim) => claim.actorId === context.player.id);
  return renderMadmanDayStrategyInstruction({
    ownActiveClaimRoleName: activeClaim ? (ROLE_DEFINITIONS[activeClaim.roleId]?.name ?? activeClaim.roleId) : 'なし',
    voteRequired: taskType === 'vote',
  });
}

export function madmanClaimBranchSection(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType)) || context.player.strategyProfile !== 'madman') return '';
  const activeClaim = context.board.claims.find((claim) => claim.actorId === context.player.id);
  if (!activeClaim) return '';
  const ownClaims = context.board.publicAbilityClaims
    .filter((claim) => claim.actorId === context.player.id)
    .map((claim) => formatAbilityClaim(context, claim));
  return renderMadmanClaimBranchInstruction({
    claimedRoleName: ROLE_DEFINITIONS[activeClaim.roleId]?.name ?? activeClaim.roleId,
    ownClaimSummary: ownClaims.length ? ownClaims.join(' / ') : '能力結果主張なし',
  });
}

export function shouldShowAbilityClaimTimeline(context, situation, claimRolePolicy, {
  counterClaimOpportunity = null,
  ownerClaimCorroborationOpportunity = null,
} = {}) {
  if (!(isNormalSpeechTask(situation.taskType) || situation.taskType === 'priority-answer')) return false;
  const abilityRoleIds = new Set(claimRolePolicy?.abilityClaimRoleIds ?? []);
  const ownActiveClaim = context.board.claims.find((claim) => claim.actorId === context.player.id) ?? null;
  const hasOwnAbilityClaim = Boolean(ownActiveClaim && abilityRoleIds.has(ownActiveClaim.roleId));
  const hasOwnPublishedAbilityResult = context.board.publicAbilityClaims.some((claim) => claim.actorId === context.player.id);
  const hasOwnPrivateAbilityResult = (context.private.abilityResults ?? []).length > 0
    && abilityRoleIds.has(context.player.roleId);
  const hasPendingMediumRequirement = (context.board.pendingMediumClaimRequirements ?? []).length > 0;
  const canConsiderInitialAbilityClaim = situation.isInitialClaimDecision && (
    abilityRoleIds.has(context.player.roleId)
    || ['wolf', 'madman', 'fox'].includes(context.player.strategyProfile)
  );
  const canPrepareStrategicAbilityClaim = abilityRoleIds.size > 0
    && ['wolf', 'madman', 'fox'].includes(context.player.strategyProfile);
  return hasOwnAbilityClaim
    || hasOwnPublishedAbilityResult
    || hasOwnPrivateAbilityResult
    || hasPendingMediumRequirement
    || Boolean(counterClaimOpportunity)
    || Boolean(ownerClaimCorroborationOpportunity)
    || canConsiderInitialAbilityClaim
    || canPrepareStrategicAbilityClaim;
}

export function abilityClaimTimelineSection(context, situation, claimRolePolicy, opportunities = {}) {
  if (!shouldShowAbilityClaimTimeline(context, situation, claimRolePolicy, opportunities)) return '';
  const cutoffs = displayAbilityEvidenceCutoffs(context.board.abilityEvidenceCutoffs ?? {});
  const pendingMediumRequirements = (context.board.pendingMediumClaimRequirements ?? []).map((item) => ({
    roleId: item.roleId,
    actionDay: item.actionDay,
    actionPhase: item.actionPhase,
    availableDay: item.availableDay,
    availablePhase: item.availablePhase,
    target: playerName(context, item.targetId),
  }));
  if (!(claimRolePolicy?.abilityClaimRoleIds ?? []).length && !pendingMediumRequirements.length) return '';
  const forcedBlock = pendingMediumRequirements.length
    ? `
${renderPromptDataBlock('pending-medium-claim-requirements', pendingMediumRequirements)}

あなたが霊能者COを継続しているため、未公開の霊能結果だけを示しています。対象・処刑時点・結果取得時点を対応する行へ一致させてください。selectionBasis・evidenceRefs・selectionReasonAtTimeは処刑履歴からシステムが補完します。`
    : '';
  return `## 能力履歴
${renderPromptDataBlock('ability-claim-evidence-windows', cutoffs)}${forcedBlock}

actionDay/actionPhaseは能力を実行・成立させた時点、availableDay/availablePhaseは結果を取得した時点です。夜能力は実行した翌朝に取得し、霊能は処刑の翌朝に取得します。public-evidenceはactionDayの能力実行時点までの指定範囲内の個別番号だけを使い、根拠なしはselectionBasis=no-public-information / evidenceRefs=[]です。selectionReasonAtTimeは選択時点の理由とし、後発情報で書き換えません。`;
}

export function tacticalOpportunitySection({ counterClaimOpportunity = null, ownerClaimCorroborationOpportunity = null } = {}) {
  return [
    renderCounterClaimOpportunityInstruction(counterClaimOpportunity),
    renderOwnerClaimCorroborationInstruction(ownerClaimCorroborationOpportunity),
  ].filter(Boolean).join('\n\n');
}

export function roleDecisionSection(context, taskType, {
  sectionPolicy,
  partnerDispositionPolicy,
  counterClaimOpportunity = null,
  ownerClaimCorroborationOpportunity = null,
} = {}) {
  return [
    initialClaimDecisionSection(context, taskType),
    endgameFactionTacticsSection(context, taskType, { enabled: sectionPolicy?.showEndgameFactionTactics }),
    tacticalOpportunitySection({ counterClaimOpportunity, ownerClaimCorroborationOpportunity }),
    sectionPolicy?.showPartnerPublicPositions ? wolfPartnerPublicPositionSection(context, taskType) : '',
    twoSeerExecutionDecisionSection(context, taskType),
    sectionPolicy?.showWolfTacticalDetail ? wolfDayStrategySection(context, taskType, partnerDispositionPolicy) : '',
    madmanDayStrategySection(context, taskType),
    wolfBlackResultCrisisSection(context, taskType),
    guardClaimTimingSection(context, taskType, { mode: sectionPolicy?.guardClaimDecisionMode ?? 'none' }),
  ].filter(Boolean).join('\n\n');
}
