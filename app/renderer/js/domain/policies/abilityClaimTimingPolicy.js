/**
 * 責務: 公開能力履歴の「能力が成立した時点」と「結果が本人に利用可能になった時点」を役職ごとに正規化する。
 * 変更ルール:
 * - 能力成立時点と結果取得時点をactionDay/actionPhase・availableDay/availablePhaseとして常に分離する。
 * - 役職ごとの時間関係だけを扱い、対象・結果・真偽・公開可否は判定しない。
 * - 霊能は処刑を能力成立時点、その他の公開可能な夜能力は夜行動を能力成立時点として扱う。
 */

const ROLE_ACTION_PHASE = Object.freeze({
  seer: 'night',
  medium: 'execution',
  guard: 'night',
  namahage: 'night',
  snowWoman: 'night',
});


export function abilityActionPhase(roleId) {
  return ROLE_ACTION_PHASE[String(roleId ?? '')] ?? null;
}

export function buildAbilityClaimTiming(roleId, actionDay) {
  const day = Number(actionDay);
  const actionPhase = abilityActionPhase(roleId);
  if (!actionPhase || !Number.isInteger(day) || day < 0) return null;
  return {
    actionDay: day,
    actionPhase,
    availableDay: day + 1,
    availablePhase: 'day',
  };
}

export function normalizeAbilityClaimTiming(claim) {
  if (!claim || typeof claim !== 'object') return null;
  const actionDay = Number(claim.actionDay);
  const availableDay = Number(claim.availableDay);
  const actionPhase = String(claim.actionPhase ?? '');
  const availablePhase = String(claim.availablePhase ?? '');
  if (!Number.isInteger(actionDay) || !Number.isInteger(availableDay)) return null;
  return { actionDay, actionPhase, availableDay, availablePhase };
}

export function validateAbilityClaimTiming(roleId, claim, { announcedDay = null } = {}) {
  const errors = [];
  const timing = normalizeAbilityClaimTiming(claim);
  const expectedPhase = abilityActionPhase(roleId);
  if (!timing) return ['能力結果主張の実行時点・取得時点が不正です。'];
  if (timing.actionDay < 0) errors.push('能力結果主張のactionDayは0以上の整数で指定してください。');
  if (timing.availableDay < 1) errors.push('能力結果主張のavailableDayは1以上の整数で指定してください。');
  if (!expectedPhase || timing.actionPhase !== expectedPhase) {
    errors.push(`能力結果主張のactionPhaseは${expectedPhase ?? '対応役職の所定値'}で指定してください。`);
  }
  if (timing.availablePhase !== 'day') errors.push('能力結果主張のavailablePhaseはdayで指定してください。');
  if (timing.availableDay !== timing.actionDay + 1) {
    errors.push('能力結果主張のavailableDayはactionDayの翌日で指定してください。');
  }
  if (announcedDay !== null && timing.availableDay > Number(announcedDay)) {
    errors.push('まだ取得していない未来の能力結果は公開できません。');
  }
  return errors;
}

export function formatAbilityClaimTiming(claim) {
  const timing = normalizeAbilityClaimTiming(claim);
  if (!timing) return '';
  const action = timing.actionPhase === 'execution'
    ? `D${timing.actionDay}処刑`
    : timing.actionDay === 0
      ? 'D0初夜'
      : `D${timing.actionDay}夜`;
  const available = `D${timing.availableDay}朝`;
  return `${action}→${available}`;
}
