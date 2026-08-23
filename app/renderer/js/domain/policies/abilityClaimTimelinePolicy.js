/**
 * 責務: 公開能力履歴が参照する公開証拠を能力決定時点の時間軸へ制限し、使用可能な公開イベント番号を列挙・解決する。
 * 変更ルール: 能力選択時点はactionDayを正本とし、同日の昼・処刑までに公開された情報を夜能力の選択根拠として利用できる。霊能は対象処刑イベントだけを参照できる。結果の真偽や自然文理由の意味は判定しない。ただし理由内の明示的な#公開番号は構造化根拠の範囲内であることを検査し、状態を書き換えない。
 */

export const ABILITY_SELECTION_BASES = Object.freeze([
  'no-public-information',
  'public-evidence',
  'rule-forced',
]);

function isEligibleAbilityEvidenceEvent(event, actionDay) {
  if (event.status !== 'published'
    || event.audience?.type !== 'public'
    || !Number.isInteger(Number(event.sequence))) return false;
  return Number(event.day) <= Number(actionDay);
}

export function getAbilityEvidenceWindow(state, actionDay) {
  const day = Number(actionDay);
  if (!Number.isInteger(day) || day < 0) return [];
  return (state.events ?? [])
    .filter((event) => isEligibleAbilityEvidenceEvent(event, day))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

export function getAbilityEvidenceCutoffs(state) {
  const currentDay = Math.max(0, Number(state.game?.day ?? 0));
  const cutoffs = {};
  for (let actionDay = 0; actionDay <= currentDay; actionDay += 1) {
    cutoffs[actionDay] = {
      eligibleEvidenceRefs: getAbilityEvidenceWindow(state, actionDay)
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

export function getUnlistedAbilityReasonSequences(selectionReasonAtTime, evidenceRefs) {
  const allowed = new Set((evidenceRefs ?? []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0));
  return extractPublicEventSequences(selectionReasonAtTime).filter((sequence) => !allowed.has(sequence));
}

export function resolveAbilityEvidenceRefs(state, evidenceRefs, actionDay) {
  const window = getAbilityEvidenceWindow(state, actionDay);
  const bySequence = new Map(window.map((event) => [Number(event.sequence), event]));
  const resolved = [];
  const errors = [];
  (evidenceRefs ?? []).forEach((value) => {
    const sequence = Number(value);
    const event = bySequence.get(sequence);
    if (!event) {
      errors.push(`#${value}はD${actionDay}の能力実行時点では利用できない公開情報です。`);
      return;
    }
    if (!resolved.some((item) => item.id === event.id)) resolved.push(event);
  });
  return { resolved, errors };
}
