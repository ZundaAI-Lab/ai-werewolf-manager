/**
 * 責務: AI本人の前回正常回答登録位置と現在タスクから公開履歴の提示範囲を決定し、本番プロンプトと生成工程で共用する履歴選択を提供する。
 * 変更ルール: 差分境界の正本は既存decisionDeltaだけとし、本モジュールで独自カーソルを作成・更新しない。既定はdeltaとし、前回正常回答登録後に増えた公開履歴だけを基本送信する。Day 2以降の昼議論第1巡だけは、deltaで失われる前日の投票直前最終巡発言と前日投票結果を比較材料として補完し、第2巡以降へ持ち越さない。fullは明示選択時だけ全件・全文、compactは境界以前の公開発言だけを構造的に選別して境界後は全件・全文を維持する。今回の非公開参考視点が公開イベント番号を参照する場合は、その参照先だけをcompactの保持対象およびdeltaの追加同梱対象として扱い、参考視点だけが送信履歴からぶら下がる状態を作らない。通常の夜タスクでは当日最終巡の公開発言と投票・処刑・夜明けなどの確定履歴を渡し、それ以前の通常発言は重複送信しない。墓場会話だけは死亡時点で凍結済みの公開履歴全体を継続記憶として渡すためfullを使用する。
 */

import { compactPriorPublicHistoryTimeline } from './priorPublicHistoryCompactor.js';

const NIGHT_HISTORY_MODES = new Set(['night', 'night-delta']);
const PUBLIC_HISTORY_TRANSMISSION_MODES = new Set(['full', 'compact', 'delta']);

export function normalizePublicHistoryTransmissionMode(value) {
  const mode = String(value ?? 'delta');
  return PUBLIC_HISTORY_TRANSMISSION_MODES.has(mode) ? mode : 'delta';
}

export function resolvePublicHistoryMode(situation, {
  transmissionMode = 'delta',
  hasHistoryCursor = false,
  forceFull = false,
} = {}) {
  if (situation.isBriefing || situation.isMemo || situation.isResultImpression) return 'none';
  if (situation.taskType === 'graveyard-conversation') return 'full';
  const normalizedTransmissionMode = normalizePublicHistoryTransmissionMode(transmissionMode);
  const cursorAvailable = hasHistoryCursor && !forceFull;
  if (situation.isNightTask) {
    return normalizedTransmissionMode === 'delta' && cursorAvailable ? 'night-delta' : 'night';
  }
  if (normalizedTransmissionMode === 'delta' && cursorAvailable) return 'delta';
  if (normalizedTransmissionMode === 'compact' && cursorAvailable) return 'compact';
  return 'full';
}

function emptyTimeline() {
  return {
    speeches: [],
    voteResults: [],
    executions: [],
    dawns: [],
    corrections: [],
    gameResults: [],
    other: [],
  };
}

function classifyEvent(timeline, event) {
  if (event.type === 'public-speech') timeline.speeches.push(event);
  else if (event.type === 'vote-finalized') timeline.voteResults.push(event);
  else if (event.type === 'execution') timeline.executions.push(event);
  else if (event.type === 'dawn') timeline.dawns.push(event);
  else if (event.type === 'correction') timeline.corrections.push(event);
  else if (event.type === 'game-result') timeline.gameResults.push(event);
  else timeline.other.push(event);
}

function selectFinalRoundSpeeches(timeline, currentDay) {
  const speeches = [...(timeline?.speeches ?? [])]
    .filter((event) => Number(event?.day) === Number(currentDay));
  if (!speeches.length) return [];
  const roundNumbers = speeches
    .map((event) => Number(event?.payload?.round))
    .filter(Number.isFinite);
  if (roundNumbers.length) {
    const finalRound = Math.max(...roundNumbers);
    return speeches.filter((event) => Number(event?.payload?.round) === finalRound);
  }
  return speeches.slice(-8);
}

function selectNightHistory(timeline, currentDay) {
  return {
    speeches: selectFinalRoundSpeeches(timeline, currentDay),
    voteResults: [...(timeline?.voteResults ?? [])],
    executions: [...(timeline?.executions ?? [])],
    dawns: [...(timeline?.dawns ?? [])],
    corrections: [...(timeline?.corrections ?? [])],
    gameResults: [...(timeline?.gameResults ?? [])],
    other: [],
  };
}

function appendPreviousDayFirstRoundContext(selected, fullTimeline, context) {
  const currentDay = Number(context?.game?.day);
  const currentRound = Number(context?.game?.discussion?.round);
  if (context?.game?.phase !== 'discussion' || currentDay <= 1 || currentRound !== 1) return;

  const previousDay = currentDay - 1;
  const previousVotes = [...(fullTimeline?.voteResults ?? [])]
    .filter((event) => Number(event?.day) === previousDay)
    .sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0));
  if (!previousVotes.length) return;

  const firstVoteSequence = Number(previousVotes[0]?.sequence);
  const speechesBeforeVote = [...(fullTimeline?.speeches ?? [])]
    .filter((event) => Number(event?.day) === previousDay)
    .filter((event) => !Number.isFinite(firstVoteSequence) || Number(event?.sequence) < firstVoteSequence);
  const finalRoundSpeeches = selectFinalRoundSpeeches({ speeches: speechesBeforeVote }, previousDay);
  const selectedSequences = new Set(Object.values(selected)
    .flatMap((events) => Array.isArray(events) ? events : [])
    .map((event) => Number(event?.sequence))
    .filter(Number.isInteger));

  [...finalRoundSpeeches, ...previousVotes]
    .sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0))
    .forEach((event) => {
      const sequence = Number(event?.sequence);
      if (!Number.isInteger(sequence) || selectedSequences.has(sequence)) return;
      classifyEvent(selected, event);
      selectedSequences.add(sequence);
    });
  Object.values(selected).forEach((events) => {
    if (Array.isArray(events)) events.sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0));
  });
}

export function preservedHistoricalSpeechSequences(context, preserveEventSequences = []) {
  const evidenceEventIds = new Set(context?.player?.decisionState?.keyPublicEvidenceEventIds ?? []);
  const preservedSequences = new Set(
    [...(preserveEventSequences ?? [])]
      .map(Number)
      .filter(Number.isInteger),
  );
  (context?.board?.publicTimeline?.speeches ?? [])
    .filter((event) => [
      event?.id,
      ...(event?.correctionLineageIds ?? []),
      event?.payload?.correctsEventId,
    ].filter(Boolean).some((eventId) => evidenceEventIds.has(eventId)))
    .map((event) => Number(event.sequence))
    .filter(Number.isInteger)
    .forEach((sequence) => preservedSequences.add(sequence));
  return preservedSequences;
}

function appendPreservedPublicEvents(selected, fullTimeline, preserveEventSequences) {
  const preservedSequences = new Set(
    [...(preserveEventSequences ?? [])]
      .map(Number)
      .filter(Number.isInteger),
  );
  if (!preservedSequences.size) return;
  const selectedSequences = new Set(Object.values(selected)
    .flatMap((events) => Array.isArray(events) ? events : [])
    .map((event) => Number(event?.sequence))
    .filter(Number.isInteger));
  Object.values(fullTimeline)
    .flatMap((events) => Array.isArray(events) ? events : [])
    .filter((event) => preservedSequences.has(Number(event?.sequence)))
    .sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0))
    .forEach((event) => {
      const sequence = Number(event?.sequence);
      if (!Number.isInteger(sequence) || selectedSequences.has(sequence)) return;
      classifyEvent(selected, event);
      selectedSequences.add(sequence);
    });
  Object.values(selected).forEach((events) => {
    if (Array.isArray(events)) events.sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0));
  });
}

export function selectPublicHistoryTimeline(context, decision, mode, {
  preserveEventSequences = [],
} = {}) {
  if (mode === 'none') return emptyTimeline();
  const fullTimeline = context?.board?.publicTimeline ?? emptyTimeline();
  if (mode === 'full') return fullTimeline;
  if (mode === 'compact') {
    return compactPriorPublicHistoryTimeline(fullTimeline, {
      historyCursorSequence: decision?.decisionDelta?.sourceSequence,
      preserveSpeechSequences: preservedHistoricalSpeechSequences(context, preserveEventSequences),
    });
  }
  if (mode === 'night') return selectNightHistory(fullTimeline, context?.game?.day);
  const selected = emptyTimeline();
  if (mode === 'delta' || mode === 'night-delta') {
    (decision?.decisionDelta?.newPublicEvents ?? []).forEach((event) => classifyEvent(selected, event));
    if (mode === 'delta') {
      appendPreservedPublicEvents(selected, fullTimeline, preserveEventSequences);
      appendPreviousDayFirstRoundContext(selected, fullTimeline, context);
    }
    return NIGHT_HISTORY_MODES.has(mode) ? selectNightHistory(selected, context?.game?.day) : selected;
  }
  const currentDay = Number(context?.game?.day);
  Object.values(fullTimeline).flat().forEach((event) => {
    if (Number(event.day) === currentDay) classifyEvent(selected, event);
  });
  return selected;
}


export function selectLatestOwnSpeechBeforeDelta(context, decision, mode, selectedTimeline = null) {
  if (!['delta', 'night-delta'].includes(mode)) return null;
  const cursor = Number(decision?.decisionDelta?.sourceSequence ?? 0);
  if (!Number.isInteger(cursor) || cursor <= 0) return null;
  const selectedIds = new Set(Object.values(selectedTimeline ?? emptyTimeline())
    .flatMap((events) => Array.isArray(events) ? events : [])
    .flatMap((event) => [event?.id, ...(event?.correctionLineageIds ?? [])])
    .filter(Boolean));
  const latestOwnSpeech = [...(context?.board?.publicTimeline?.speeches ?? [])]
    .filter((event) => event.actorId === context?.player?.id)
    .filter((event) => Number(event.sequence) <= cursor)
    .sort((left, right) => Number(right.sequence ?? 0) - Number(left.sequence ?? 0))[0] ?? null;
  if (!latestOwnSpeech) return null;
  return [latestOwnSpeech.id, ...(latestOwnSpeech.correctionLineageIds ?? [])].some((id) => selectedIds.has(id))
    ? null
    : latestOwnSpeech;
}

export function buildSelectedPublicHistoryEvents(context, decision, mode, options = {}) {
  const timeline = selectPublicHistoryTimeline(context, decision, mode, options);
  return Object.values(timeline)
    .flatMap((events) => Array.isArray(events) ? events : [])
    .filter(Boolean)
    .map((event) => structuredClone(event))
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
}
