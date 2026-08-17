/**
 * 責務: 前回の正常回答登録位置以前の公開発言だけを、保存済み構造情報に基づいて重要発言へ選別する。
 * 変更ルール: 差分境界の決定・更新、公開イベント本文の要約・切断、非公開情報の参照を行わない。境界後の履歴と発言以外の確定公開イベントは必ずそのまま維持する。
 */

function normalizedSequence(event) {
  const sequence = Number(event?.sequence);
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
}

function hasStructuredPublicAction(event) {
  const structured = event?.payload?.structured ?? {};
  const coAction = String(structured.coOperation?.action ?? 'none');
  const interaction = structured.interaction ?? {};
  return ['declare', 'change', 'withdraw'].includes(coAction)
    || (structured.abilityClaims ?? []).length > 0
    || (interaction.questionTargetIds ?? []).length > 0
    || (interaction.answersEventIds ?? []).length > 0;
}

function hasCorrectionLineage(event) {
  return Boolean(
    (event?.correctionLineageIds ?? []).length
    || event?.payload?.correctsEventId,
  );
}

function retainedPriorSpeechSequences(priorSpeeches, preserveSpeechSequences) {
  const retained = new Set(
    [...(preserveSpeechSequences ?? [])]
      .map(Number)
      .filter(Number.isInteger),
  );
  const latestByActor = new Map();

  priorSpeeches.forEach((event) => {
    const sequence = normalizedSequence(event);
    if (sequence === null) return;
    if (hasStructuredPublicAction(event) || hasCorrectionLineage(event)) retained.add(sequence);
    const actorId = String(event?.actorId ?? '');
    if (!actorId) return;
    const previous = latestByActor.get(actorId);
    if (!previous || sequence > previous) latestByActor.set(actorId, sequence);
  });

  latestByActor.forEach((sequence) => retained.add(sequence));
  return retained;
}

export function compactPriorPublicHistoryTimeline(timeline, {
  historyCursorSequence,
  preserveSpeechSequences = new Set(),
} = {}) {
  const cursor = Number(historyCursorSequence);
  if (!Number.isInteger(cursor) || cursor < 0) return timeline;

  const speeches = [...(timeline?.speeches ?? [])]
    .filter(Boolean)
    .sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0));
  const priorSpeeches = speeches.filter((event) => Number(event?.sequence ?? 0) <= cursor);
  const recentSpeeches = speeches.filter((event) => Number(event?.sequence ?? 0) > cursor);
  const retainedSequences = retainedPriorSpeechSequences(priorSpeeches, preserveSpeechSequences);

  return {
    speeches: [
      ...priorSpeeches.filter((event) => retainedSequences.has(Number(event?.sequence))),
      ...recentSpeeches,
    ],
    voteResults: [...(timeline?.voteResults ?? [])],
    executions: [...(timeline?.executions ?? [])],
    dawns: [...(timeline?.dawns ?? [])],
    corrections: [...(timeline?.corrections ?? [])],
    gameResults: [...(timeline?.gameResults ?? [])],
    other: [...(timeline?.other ?? [])],
  };
}
