/**
 * 責務: 公開盤面、本人の恒常的な推理傾向、本人に過去割り当てた参考視点から、今回だけ使用する非公開の参考視点を一つ選ぶ。
 * 変更ルール:
 * - 公開発言本文を生成しない。
 * - AI回答が指示どおりかを検証しない。
 * - 他人の内部情報・AIプロンプトを参照しない。同一人物の過去ターンと公開イベントだけを使用する。
 * - 同じ状態では同じ選択を返し、乱数を使用しない。
 * - 直接質問と回答は明示構造化された公開interactionだけを正本とし、公開発言本文を補助判定にも使用しない。
 * - 推理モードの候補はevidenceFocusだけから決め、questionStyle / confrontationStyle / hypothesisBreadthは候補追加に使わない。
 * - hypothesisBreadthは選択済みレンズから得た材料を何候補まで保持するかという後段の内部修飾に限定する。
 * - 各推理モードは必要な構造化公開事実が揃う場合だけ選ぶ。ただしchallenge-consensusは盤面全体を確認する条件付きレンズとして対象者を事前判定せず、実際の集中がなければAI側で空振りできる。
 * - evaluate-responseは、本人が当日に以前構造登録した未消化の質問と、その質問IDをanswersEventIdsへ持つ回答が結ばれた専用経路だけで選ぶ。間に別ターンが入っても追跡し、通常の候補ランキングへ混ぜない。
 * - 公開発言本文は不透明文字列として扱い、人物関係・候補・判断条件を自由文から推定しない。整合性・立場の参考視点は構造化公開事実と公開イベント数だけで対象を選び、内容評価自体はAIへ委ねる。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { getReasoningModeCandidates } from '../../config/reasoningModePolicy.js';

import { hashText } from '../../shared/utils.js';


const MODE_DEFINITIONS = Object.freeze({
  'respond-directly': Object.freeze({ lens: 'response', targetCount: 1 }),
  'evaluate-response': Object.freeze({ lens: 'response', targetCount: 1 }),
  'probe-response': Object.freeze({ lens: 'response', targetCount: 1 }),
  'trace-change': Object.freeze({ lens: 'chronology', targetCount: 1 }),
  'check-consistency': Object.freeze({ lens: 'consistency', targetCount: 1 }),
  'compare-pair': Object.freeze({ lens: 'relationship', targetCount: 2 }),
  'challenge-consensus': Object.freeze({ lens: 'consensus', targetCount: 0 }),
  'inspect-commitment': Object.freeze({ lens: 'commitment', targetCount: 1 }),
  'evaluate-information-gain': Object.freeze({ lens: 'risk', targetCount: 2 }),
  'compare-candidates': Object.freeze({ lens: 'comparison', targetCount: 2 }),
  'synthesize-claims': Object.freeze({ lens: 'synthesis', targetCount: 1 }),
  'hold-judgment': Object.freeze({ lens: 'uncertainty', targetCount: 1 }),
});

function playerName(context, playerId) {
  return context.board.alive.find((item) => item.id === playerId)?.name
    ?? context.board.dead.find((item) => item.id === playerId)?.name
    ?? playerId;
}

function publicSpeeches(context) {
  return [...(context.board.publicTimeline?.speeches ?? [])]
    .filter((event) => Number(event.day) === Number(context.game.day))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function priorUsages(state, context) {
  return (state.aiTurns ?? [])
    .filter((turn) => isNormalSpeechTask(turn.taskType)
      && turn.playerId === context.player.id
      && Number(turn.day) === Number(context.game.day))
    .map((turn) => turn.resolvedInternalReasoningDirective)
    .filter(Boolean);
}

function countBy(values) {
  const result = {};
  values.forEach((value) => {
    if (!value) return;
    result[value] = Number(result[value] ?? 0) + 1;
  });
  return result;
}

function deriveReasoningIdentity(character = {}) {
  const profile = character.reasoningProfile ?? {};
  const evidenceFocus = profile.evidenceFocus ?? 'balanced';
  const inferenceMethod = {
    response: 'probe',
    chronology: 'chronology',
    consistency: 'consistency',
    commitment: 'commitment',
    'social-reaction': 'relationship',
    balanced: 'synthesis',
  }[evidenceFocus] ?? 'synthesis';
  const agendaPersistence = profile.updateTempo === 'conservative'
    ? 'persistent'
    : profile.updateTempo === 'rapid'
      ? 'opportunistic'
      : 'adaptive';
  return {
    ...profile,
    evidenceFocus,
    inferenceMethod,
    agendaPersistence,
  };
}

function latestOwnSpeechSequence(context) {
  return publicSpeeches(context)
    .filter((event) => event.actorId === context.player.id)
    .reduce((latest, event) => Math.max(latest, Number(event.sequence ?? 0)), 0);
}

function directQuestionEvent(context) {
  const ownLast = latestOwnSpeechSequence(context);
  return [...publicSpeeches(context)]
    .reverse()
    .find((event) => (
      event.actorId !== context.player.id
      && Number(event.sequence) > ownLast
      && (event.payload?.structured?.interaction?.questionTargetIds ?? []).includes(context.player.id)
    )) ?? null;
}

function correctionLineageIdsOf(event) {
  return new Set(event?.correctionLineageIds?.length
    ? event.correctionLineageIds
    : [event?.id, event?.payload?.correctsEventId].filter(Boolean));
}

function latestPreviousAgendaResponse(context, usages) {
  const speeches = publicSpeeches(context);
  const consumedResponseSequences = new Set(
    usages
      .filter((usage) => usage.modeId === 'evaluate-response')
      .flatMap((usage) => usage.anchorEventSequences ?? [])
      .filter(Number.isInteger),
  );

  for (let index = usages.length - 1; index >= 0; index -= 1) {
    const usage = usages[index];
    const focusId = usage?.focusPlayerIds?.[0] ?? null;
    if (!focusId || usage.modeId !== 'probe-response') continue;

    const nextUsageBoundary = Number(usages[index + 1]?.publicSequenceAtGeneration ?? Number.POSITIVE_INFINITY);
    const question = speeches.find((event) => (
      event.actorId === context.player.id
      && Number(event.sequence) > Number(usage.publicSequenceAtGeneration ?? 0)
      && Number(event.sequence) <= nextUsageBoundary
      && (event.payload?.structured?.interaction?.questionTargetIds ?? []).includes(focusId)
    ));
    if (!question) continue;

    const lineageIds = correctionLineageIdsOf(question);
    const response = [...speeches]
      .reverse()
      .find((event) => (
        event.actorId === focusId
        && Number(event.sequence) > Number(question.sequence ?? 0)
        && !consumedResponseSequences.has(Number(event.sequence))
        && (event.payload?.structured?.interaction?.answersEventIds ?? []).some((sourceId) => lineageIds.has(sourceId))
      ));
    if (response) return { focusId, response, previous: usage, question };
  }
  return null;
}

function candidateModes(identity) {
  return getReasoningModeCandidates(identity.evidenceFocus);
}

function speechCountsByActor(context) {
  return countBy(publicSpeeches(context).map((event) => event.actorId));
}

function recentSpeechByActor(context, actorId) {
  return publicSpeeches(context).filter((event) => event.actorId === actorId).at(-1) ?? null;
}

function allPublicSpeeches(context) {
  return [...(context.board.publicTimeline?.speeches ?? [])]
    .filter((event) => Number(event.day) <= Number(context.game.day))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function publishedVotes(context) {
  return [...(context.board.publicTimeline?.voteResults ?? [])]
    .filter((event) => Number(event.day) <= Number(context.game.day))
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
}

function questionAvailablePlayerIds(context) {
  const discussion = context.game.discussion ?? {};
  const answerPriorityEnabled = context.game.rules.discussion.answerPriorityEnabled === true;
  return context.board.alive
    .filter((player) => player.id !== context.player.id && !player.frozen)
    .filter((player) => answerPriorityEnabled || Number(discussion.remainingByPlayer?.[player.id] ?? 0) > 0)
    .map((player) => player.id);
}

function addEvidenceCount(counts, playerId) {
  if (!playerId) return;
  counts[playerId] = Number(counts[playerId] ?? 0) + 1;
}

function publicEvidenceCounts(context) {
  const counts = {};
  allPublicSpeeches(context).forEach((event) => addEvidenceCount(counts, event.actorId));
  (context.board.claims ?? []).forEach((claim) => addEvidenceCount(counts, claim.actorId));
  (context.board.publicAbilityClaims ?? []).forEach((claim) => {
    addEvidenceCount(counts, claim.actorId);
    addEvidenceCount(counts, claim.targetId);
  });
  publishedVotes(context).forEach((event) => {
    (event.payload?.ballots ?? []).forEach((ballot) => {
      addEvidenceCount(counts, ballot.voterId);
      if (ballot.targetId !== 'abstain') addEvidenceCount(counts, ballot.targetId);
    });
    (event.payload?.tally ?? []).forEach((item) => addEvidenceCount(counts, item.targetId));
  });
  return counts;
}

function actorOriginSequences(context, actorId) {
  const sequences = [
    ...allPublicSpeeches(context).filter((event) => event.actorId === actorId).map((event) => event.sequence),
    ...publishedVotes(context).filter((event) => (event.payload?.ballots ?? []).some((ballot) => ballot.voterId === actorId)).map((event) => event.sequence),
  ].filter(Number.isInteger);
  return [...new Set(sequences)].sort((left, right) => left - right);
}

function hasStructuredCommitment(event) {
  const structured = event?.payload?.structured ?? {};
  if (['declare', 'change', 'withdraw'].includes(structured.coOperation?.action)) return true;
  return (structured.abilityClaims ?? []).some((claim) => claim?.action === 'publish');
}

function commitmentSequences(context, actorId) {
  const sequences = [
    ...allPublicSpeeches(context)
      .filter((event) => event.actorId === actorId && hasStructuredCommitment(event))
      .map((event) => event.sequence),
    ...publishedVotes(context)
      .filter((event) => (event.payload?.ballots ?? []).some((ballot) => ballot.voterId === actorId))
      .map((event) => event.sequence),
  ].filter(Number.isInteger);
  return [...new Set(sequences)].sort((left, right) => left - right);
}

function publicMaterialPlayerIds(context, { minimumEvidenceCount = 1 } = {}) {
  const counts = publicEvidenceCounts(context);
  return context.board.alive
    .filter((player) => player.id !== context.player.id)
    .filter((player) => Number(counts[player.id] ?? 0) >= minimumEvidenceCount)
    .map((player) => player.id);
}

function publicCommitmentActorIds(context) {
  const result = new Set(
    allPublicSpeeches(context)
      .filter(hasStructuredCommitment)
      .map((event) => event.actorId),
  );
  publishedVotes(context).forEach((event) => {
    (event.payload?.ballots ?? []).forEach((ballot) => result.add(ballot.voterId));
  });
  return [...result].filter((id) => id && id !== context.player.id);
}

function decisionRelevantTargetIds(context) {
  const result = new Set([
    ...(context.player.decisionState?.suspicionCandidateIds ?? []),
    ...(context.player.decisionState?.executionCandidateIds ?? []),
    context.player.decisionState?.intendedVoteId,
  ].filter((id) => id && id !== 'abstain'));
  (context.board.publicAbilityClaims ?? []).forEach((claim) => result.add(claim.targetId));
  publishedVotes(context).forEach((event) => {
    (event.payload?.ballots ?? []).forEach((ballot) => {
      if (ballot.targetId !== 'abstain') result.add(ballot.targetId);
    });
    (event.payload?.tally ?? []).forEach((item) => result.add(item.targetId));
  });
  return [...result].filter((id) => id && id !== context.player.id);
}

export function canonicalRelationshipIds(leftId, rightId) {
  return [String(leftId), String(rightId)].sort((left, right) => left.localeCompare(right));
}

export function sameRelationshipPair(leftIds, rightIds) {
  const left = canonicalRelationshipIds(leftIds?.[0], leftIds?.[1]);
  const right = canonicalRelationshipIds(rightIds?.[0], rightIds?.[1]);
  return left[0] === right[0] && left[1] === right[1];
}

function structuredRelationshipPairs(context) {
  const eventsById = new Map();
  allPublicSpeeches(context).forEach((event) => {
    correctionLineageIdsOf(event).forEach((eventId) => eventsById.set(eventId, event));
  });
  const pairs = new Map();
  const addPair = (leftId, rightId, sequences) => {
    if (!leftId || !rightId || leftId === rightId || leftId === context.player.id || rightId === context.player.id) return;
    const ids = canonicalRelationshipIds(leftId, rightId);
    let rightMap = pairs.get(ids[0]);
    if (!rightMap) {
      rightMap = new Map();
      pairs.set(ids[0], rightMap);
    }
    const current = rightMap.get(ids[1]) ?? { ids, sequences: [] };
    current.sequences = [...new Set([...current.sequences, ...sequences.filter(Number.isInteger)])]
      .sort((left, right) => left - right);
    rightMap.set(ids[1], current);
  };

  allPublicSpeeches(context).forEach((event) => {
    const interaction = event.payload?.structured?.interaction ?? {};
    (interaction.questionTargetIds ?? []).forEach((targetId) => addPair(event.actorId, targetId, [event.sequence]));
    (interaction.answersEventIds ?? []).forEach((sourceEventId) => {
      const source = eventsById.get(sourceEventId);
      if (!source || !(source.payload?.structured?.interaction?.questionTargetIds ?? []).includes(event.actorId)) return;
      addPair(source.actorId, event.actorId, [source.sequence, event.sequence]);
    });
  });
  return [...pairs.values()].flatMap((rightMap) => [...rightMap.values()]);
}

function eligibleTargetIdsForMode(context, modeId) {
  // evaluate-responseはlatestPreviousAgendaResponse()の検証済み質問・回答専用であり、
  // 通常ランキングから対象を選ばせない。
  if (modeId === 'evaluate-response') return [];
  const base = context.board.alive.filter((player) => player.id !== context.player.id).map((player) => player.id);
  const counts = speechCountsByActor(context);
  if (modeId === 'probe-response') {
    const available = new Set(questionAvailablePlayerIds(context));
    return base.filter((id) => available.has(id) && Number(counts[id] ?? 0) >= 1);
  }
  if (modeId === 'check-consistency') return base.filter((id) => actorOriginSequences(context, id).length >= 2);
  if (modeId === 'inspect-commitment') {
    const committed = new Set(publicCommitmentActorIds(context));
    return base.filter((id) => committed.has(id));
  }
  if (modeId === 'trace-change') return base.filter((id) => Number(counts[id] ?? 0) >= 2);
  if (modeId === 'compare-pair') {
    const related = new Set(structuredRelationshipPairs(context).flatMap((pair) => pair.ids));
    return base.filter((id) => related.has(id));
  }
  if (modeId === 'evaluate-information-gain') {
    const candidates = new Set(decisionRelevantTargetIds(context));
    return base.filter((id) => candidates.has(id));
  }
  if (modeId === 'compare-candidates') {
    const candidates = new Set(publicMaterialPlayerIds(context));
    return base.filter((id) => candidates.has(id));
  }
  if (modeId === 'synthesize-claims') {
    const candidates = new Set(publicMaterialPlayerIds(context, { minimumEvidenceCount: 2 }));
    return base.filter((id) => candidates.has(id));
  }
  if (modeId === 'hold-judgment') {
    const candidates = new Set(publicMaterialPlayerIds(context));
    return base.filter((id) => candidates.has(id));
  }
  return base;
}

function targetScores(state, context, identity, usages, modeId, candidateIds = null) {
  const focusCounts = countBy(usages.flatMap((usage) => usage.focusPlayerIds ?? []));
  const speechCounts = speechCountsByActor(context);
  const decisionIds = new Set([
    ...(context.player.decisionState?.suspicionCandidateIds ?? []),
    ...(context.player.decisionState?.executionCandidateIds ?? []),
  ]);
  const previousOwnFocus = new Set(usages.at(-1)?.focusPlayerIds ?? []);
  const allowedIds = new Set(candidateIds ?? eligibleTargetIdsForMode(context, modeId));
  return context.board.alive
    .filter((player) => player.id !== context.player.id && allowedIds.has(player.id))
    .map((player) => {
      let score = 100;
      score += decisionIds.has(player.id) ? 18 : 0;
      score += recentSpeechByActor(context, player.id) ? 12 : -15;
      score += Math.min(12, Number(speechCounts[player.id] ?? 0) * 3);
      score -= Number(focusCounts[player.id] ?? 0) * 17;
      if (previousOwnFocus.has(player.id)) {
        score += identity.agendaPersistence === 'persistent' ? 28 : identity.agendaPersistence === 'adaptive' ? -6 : -30;
      }
      if (modeId === 'trace-change' && Number(speechCounts[player.id] ?? 0) < 2) score -= 80;
      if (modeId === 'probe-response' && Number(speechCounts[player.id] ?? 0) < 1) score -= 45;
      const tie = parseInt(hashText(`${context.game.id}:${context.game.day}:${context.player.id}:${modeId}:${player.id}`), 16) % 1000;
      return { playerId: player.id, score, tie };
    })
    .sort((left, right) => right.score - left.score || left.tie - right.tie);
}

function selectRelationshipPair(state, context, identity, usages) {
  const aliveIds = new Set(context.board.alive.map((player) => player.id));
  const pairs = structuredRelationshipPairs(context).filter((pair) => pair.ids.every((id) => aliveIds.has(id)));
  if (!pairs.length) return [];
  const eligibleIds = [...new Set(pairs.flatMap((pair) => pair.ids))];
  const scoreById = new Map(targetScores(state, context, identity, usages, 'compare-pair', eligibleIds)
    .map((item) => [item.playerId, item.score]));
  return pairs
    .map((pair) => ({
      ...pair,
      score: pair.ids.reduce((total, id) => total + Number(scoreById.get(id) ?? 0), 0)
        + Number(pair.sequences.at(-1) ?? 0),
      tie: parseInt(hashText(`${context.game.id}:${context.game.day}:${context.player.id}:compare-pair:${pair.ids.join(':')}`), 16) % 1000,
    }))
    .sort((left, right) => right.score - left.score || left.tie - right.tie)
    .at(0)?.ids ?? [];
}

function selectTargets(state, context, identity, usages, modeId) {
  const definition = MODE_DEFINITIONS[modeId];
  if (definition.targetCount === 0) return [];
  const eligibleIds = eligibleTargetIdsForMode(context, modeId);
  if (modeId === 'compare-pair') return selectRelationshipPair(state, context, identity, usages);
  const ranked = targetScores(state, context, identity, usages, modeId, eligibleIds);
  return ranked.slice(0, definition.targetCount).map((item) => item.playerId);
}

function modePreconditionsSatisfied(context, modeId, focusPlayerIds) {
  // 専用追跡経路以外からevaluate-responseが成立する余地を閉じる。
  if (modeId === 'evaluate-response') return false;
  const definition = MODE_DEFINITIONS[modeId];
  if (focusPlayerIds.length !== definition.targetCount) return false;
  if (definition.targetCount === 0) return true;
  if (['compare-pair', 'compare-candidates', 'evaluate-information-gain'].includes(modeId)) {
    if (new Set(focusPlayerIds).size !== 2) return false;
  }
  const eligibleIds = new Set(eligibleTargetIdsForMode(context, modeId));
  if (!focusPlayerIds.every((id) => eligibleIds.has(id))) return false;
  if (modeId === 'compare-pair') {
    return structuredRelationshipPairs(context).some((pair) => sameRelationshipPair(pair.ids, focusPlayerIds));
  }
  return true;
}

function modeScore(state, context, identity, usages, modeId) {
  const ownModeCounts = countBy(usages.map((usage) => usage.modeId));
  const preference = candidateModes(identity).indexOf(modeId);
  const distributionBias = parseInt(hashText(`${context.game.id}:${context.game.day}:${context.discussion?.round ?? 0}:${context.player.id}:${modeId}`), 16) % 61;
  let score = 140 - Math.max(0, preference) * 18 + distributionBias;
  score -= Number(ownModeCounts[modeId] ?? 0) * 35;
  if (usages.at(-1)?.modeId === modeId) score -= 55;
  const tie = parseInt(hashText(`${context.game.id}:${context.game.day}:${context.player.id}:${usages.length}:${modeId}`), 16) % 1000;
  return { modeId, score, tie };
}

function anchorEvents(context, focusPlayerIds, modeId) {
  const speeches = publicSpeeches(context);
  if (modeId === 'trace-change') {
    const target = focusPlayerIds[0];
    return speeches.filter((event) => event.actorId === target).slice(-2).map((event) => event.sequence);
  }
  if (modeId === 'check-consistency') return actorOriginSequences(context, focusPlayerIds[0]).slice(-3);
  if (modeId === 'inspect-commitment') return commitmentSequences(context, focusPlayerIds[0]).slice(-3);
  if (modeId === 'compare-pair') {
    return structuredRelationshipPairs(context)
      .find((pair) => sameRelationshipPair(pair.ids, focusPlayerIds))
      ?.sequences.slice(-2) ?? [];
  }
  if (modeId === 'synthesize-claims') {
    return allPublicSpeeches(context)
      .filter((event) => event.actorId === focusPlayerIds[0])
      .slice(-2)
      .map((event) => event.sequence);
  }
  return focusPlayerIds
    .map((id) => recentSpeechByActor(context, id)?.sequence ?? null)
    .filter(Number.isInteger);
}

function buildDirective(context, identity, modeId, focusPlayerIds, anchorEventSequences, extra = {}) {
  return Object.freeze({
    modeId,
    lens: MODE_DEFINITIONS[modeId].lens,
    focusPlayerIds: Object.freeze([...focusPlayerIds]),
    focusPlayerNames: Object.freeze(focusPlayerIds.map((id) => playerName(context, id))),
    anchorEventSequences: Object.freeze([...anchorEventSequences]),
    publicSequenceAtGeneration: publicSpeeches(context).at(-1)?.sequence ?? 0,
    identity: Object.freeze({
      inferenceMethod: identity.inferenceMethod,
      agendaPersistence: identity.agendaPersistence,
      hypothesisBreadth: identity.hypothesisBreadth,
      questionStyle: identity.questionStyle,
      confrontationStyle: identity.confrontationStyle,
      uncertaintyStyle: identity.uncertaintyStyle,
    }),
    factionOverlay: context.player.roleId === 'whiteWolf'
      ? 'whiteWolf'
      : context.player.strategyProfile ?? null,
    ...extra,
  });
}

export function resolveInternalReasoningDirective(state, context, { conversationMode = 'normal' } = {}) {
  if (!isNormalSpeechTask(context.task.type) || conversationMode === 'first-speaker') return null;
  const identity = deriveReasoningIdentity(context.player.character);
  const usages = priorUsages(state, context);

  const direct = directQuestionEvent(context);
  if (direct) {
    return buildDirective(context, identity, 'respond-directly', [direct.actorId], [direct.sequence]);
  }

  const agendaResponse = latestPreviousAgendaResponse(context, usages);
  if (agendaResponse) {
    return buildDirective(
      context,
      identity,
      'evaluate-response',
      [agendaResponse.focusId],
      [agendaResponse.response.sequence],
      { previousModeId: agendaResponse.previous.modeId },
    );
  }

  const modes = candidateModes(identity);
  const rankedModes = modes
    .map((modeId) => modeScore(state, context, identity, usages, modeId))
    .sort((left, right) => right.score - left.score || left.tie - right.tie);
  for (const { modeId } of rankedModes) {
    const focusPlayerIds = selectTargets(state, context, identity, usages, modeId);
    if (!modePreconditionsSatisfied(context, modeId, focusPlayerIds)) continue;
    return buildDirective(context, identity, modeId, focusPlayerIds, anchorEvents(context, focusPlayerIds, modeId));
  }
  const fallbackTargets = selectTargets(state, context, identity, usages, 'hold-judgment');
  if (!fallbackTargets.length) return null;
  return buildDirective(context, identity, 'hold-judgment', fallbackTargets, anchorEvents(context, fallbackTargets, 'hold-judgment'));
}
