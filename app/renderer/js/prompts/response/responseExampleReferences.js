/**
 * 責務: AI本人へ可視な公開コンテキストと質問解決状態から、応答契約例で実在参照として使用できる公開イベント番号を決定的に抽出する。
 * 変更ルール: 状態を書き換えず、非公開イベントを参照しない。回答例には現在Dayの未回答・未スキップ質問だけを使用し、例示には最新の有効番号を最大1件だけ渡す。有効番号がなければ空配列を返す。
 */

import { getUnresolvedPublicQuestionsForPlayer } from '../../domain/discussion/publicQuestionResolution.js';

const DECISION_EVIDENCE_EVENT_TYPES = new Set(['public-speech', 'vote-finalized', 'execution', 'dawn']);

function bySequence(left, right) {
  return Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}

function visiblePublicEvents(context) {
  const seen = new Set();
  return Object.values(context?.board?.publicTimeline ?? {})
    .flatMap((events) => Array.isArray(events) ? events : [])
    .filter((event) => {
      const sequence = Number(event?.sequence ?? 0);
      if (!Number.isInteger(sequence) || sequence < 1 || seen.has(sequence)) return false;
      seen.add(sequence);
      return true;
    })
    .sort(bySequence);
}

function latestSequence(events) {
  const sequence = Number(events.at(-1)?.sequence ?? 0);
  return Number.isInteger(sequence) && sequence > 0 ? [sequence] : [];
}

function abilityEvidenceSequences(context, resultDay) {
  const refs = context?.board?.abilityEvidenceCutoffs?.[resultDay]?.eligibleEvidenceEventSequences ?? [];
  const normalized = [...new Set(refs
    .map(Number)
    .filter((sequence) => Number.isInteger(sequence) && sequence > 0))]
    .sort((left, right) => left - right);
  return normalized.length ? [normalized.at(-1)] : [];
}

function resolveArguments(stateOrContext, maybeContext) {
  if (maybeContext !== undefined) return { state: stateOrContext, context: maybeContext };
  return { state: null, context: stateOrContext };
}

function unansweredQuestionSequences(state, context, visibleSequences) {
  const playerId = String(context?.player?.id ?? '');
  if (!state || !playerId) return [];
  return getUnresolvedPublicQuestionsForPlayer(state, playerId, { currentDayOnly: true })
    .filter((event) => visibleSequences.has(Number(event.sequence)))
    .sort(bySequence)
    .map((event) => Number(event.sequence));
}

export function buildResponseExampleReferences(stateOrContext, maybeContext) {
  const { state, context } = resolveArguments(stateOrContext, maybeContext);
  const playerId = String(context?.player?.id ?? '');
  const resultDay = Math.max(1, Number(context?.game?.day ?? 1));
  const publicEvents = visiblePublicEvents(context);
  const visibleSequences = new Set(publicEvents.map((event) => Number(event.sequence)));
  const publicSpeeches = publicEvents.filter((event) => event.type === 'public-speech');
  const pendingQuestionSequences = unansweredQuestionSequences(state, context, visibleSequences);
  return {
    answerEventSequences: pendingQuestionSequences.length ? [pendingQuestionSequences.at(-1)] : [],
    correctedSpeechSequences: latestSequence(publicSpeeches.filter((event) => String(event?.actorId ?? '') === playerId)),
    decisionEvidenceEventSequences: latestSequence(publicEvents.filter((event) => DECISION_EVIDENCE_EVENT_TYPES.has(event?.type))),
    abilityEvidenceEventSequences: abilityEvidenceSequences(context, resultDay),
    abilityResultDay: resultDay,
  };
}
