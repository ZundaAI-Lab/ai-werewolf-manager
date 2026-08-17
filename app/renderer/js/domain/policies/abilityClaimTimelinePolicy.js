/**
 * 責務: 公開能力履歴が参照する公開証拠を能力決定時点の時間軸へ制限し、使用可能な公開イベント番号を列挙・解決する。
 * 変更ルール: resultDayは結果を得た昼を表す。夜能力はresultDayより前の日、霊能は対象処刑イベントだけを参照できる。結果の真偽や自然文理由の意味は判定しない。ただし理由内の明示的な#公開番号は構造化根拠の範囲内であることを検査し、状態を書き換えない。
 */

export const ABILITY_SELECTION_BASES = Object.freeze([
  'no-public-information',
  'public-evidence',
  'rule-forced',
]);

function isEligibleAbilityEvidenceEvent(event, observedDay) {
  if (event.status !== 'published'
    || event.audience?.type !== 'public'
    || !Number.isInteger(Number(event.sequence))) return false;
  const eventDay = Number(event.day);
  const resultDay = Number(observedDay);
  return eventDay < resultDay;
}

export function getAbilityEvidenceWindow(state, observedDay) {
  const day = Number(observedDay);
  if (!Number.isInteger(day) || day < 1) return [];
  return (state.events ?? [])
    .filter((event) => isEligibleAbilityEvidenceEvent(event, day))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

export function getAbilityEvidenceCutoffs(state) {
  const currentDay = Math.max(0, Number(state.game?.day ?? 0));
  const cutoffs = {};
  for (let day = 1; day <= currentDay; day += 1) {
    cutoffs[day] = {
      eligibleEvidenceEventSequences: getAbilityEvidenceWindow(state, day)
        .map((event) => Number(event.sequence)),
    };
  }
  return cutoffs;
}


export function extractPublicEventSequences(value) {
  const sequences = [];
  for (const match of String(value ?? '').matchAll(/[#＃](\d+)/gu)) {
    const sequence = Number(match[1]);
    if (Number.isSafeInteger(sequence) && sequence > 0 && !sequences.includes(sequence)) sequences.push(sequence);
  }
  return sequences;
}

export function getUnlistedAbilityReasonSequences(selectionReasonAtTime, evidenceEventSequences) {
  const allowed = new Set((evidenceEventSequences ?? []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0));
  return extractPublicEventSequences(selectionReasonAtTime).filter((sequence) => !allowed.has(sequence));
}

export function resolveAbilityEvidenceRefs(state, evidenceRefs, observedDay) {
  const window = getAbilityEvidenceWindow(state, observedDay);
  const bySequence = new Map(window.map((event) => [Number(event.sequence), event]));
  const resolved = [];
  const errors = [];
  (evidenceRefs ?? []).forEach((value) => {
    const sequence = Number(value);
    const event = bySequence.get(sequence);
    if (!event) {
      errors.push(`#${value}はDay ${observedDay}の能力使用時点では利用できない公開情報です。`);
      return;
    }
    if (!resolved.some((item) => item.id === event.id)) resolved.push(event);
  });
  return { resolved, errors };
}
