/**
 * 責務: ROLE_DEFINITIONSを正本として公開能力履歴の役職・行動種別・結果・実行時点・取得時点・対象制約を一元検証する。
 * 変更ルール: 能力時刻はactionDay/actionPhaseとavailableDay/availablePhaseを分離して保持する。内部結果はwolf / not-wolf / unknownだけを保持し、日本語化は表示境界でのみ行う。役職を指定した表示ではunknownの意味を役職能力に合わせて明確化してよいが、内部値は変更しない。結果の真偽や陣営を判定せず、状態を書き換えない。能力対象の選定理由は思考・監査品質向上用の任意情報とし、意味内容は成立条件にしないが、理由中の#公開番号は構造化根拠の部分集合に限定する。未公開の霊能結果要件は、生存中かつ公開CO継続中の発言者本人へだけ導出する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import {
  ABILITY_SELECTION_BASES,
  getUnlistedAbilityReasonSequences,
  resolveAbilityEvidenceRefs,
} from './abilityClaimTimelinePolicy.js';
import {
  buildAbilityClaimTiming,
  validateAbilityClaimTiming,
} from './abilityClaimTimingPolicy.js';

const SELECTION_BASES = new Set(ABILITY_SELECTION_BASES);

export const PUBLIC_ABILITY_ROLE_IDS = Object.freeze(
  Object.values(ROLE_DEFINITIONS)
    .filter((role) => role.publicAbilityClaim)
    .map((role) => role.id),
);

export const PUBLIC_ABILITY_RESULTS = Object.freeze([
  ...new Set(PUBLIC_ABILITY_ROLE_IDS.flatMap((roleId) => (
    ROLE_DEFINITIONS[roleId].publicAbilityClaim.results
  ))),
]);

export function getPublicAbilityClaimDefinition(roleId) {
  return ROLE_DEFINITIONS[String(roleId ?? '')]?.publicAbilityClaim ?? null;
}

export function normalizePublicAbilityResult(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function publicAbilityResultLabel(value, roleId = null) {
  const normalized = normalizePublicAbilityResult(value);
  if (normalized === 'unknown' && roleId === 'guard') return '護衛発動の有無は不明';
  return {
    wolf: '人狼',
    'not-wolf': '人狼ではない',
    unknown: '成否不明',
  }[normalized] ?? String(value ?? '');
}

export function resolvePublicAbilityClaimRequirements(state, {
  roleId,
  actionDay,
  targetId,
} = {}) {
  if (roleId !== 'medium') {
    return {
      selectionBasis: null,
      requiredEvidenceEventIds: [],
      requiredEvidenceRefs: [],
      selectionReasonAtTime: null,
    };
  }

  const execution = (state.events ?? []).find((event) => event.status === 'published'
    && event.type === 'execution'
    && Number(event.day) === Number(actionDay)
    && (event.payload?.targetId === targetId || event.targetIds?.includes(targetId)));

  return {
    selectionBasis: 'rule-forced',
    requiredEvidenceEventIds: execution ? [execution.id] : [],
    requiredEvidenceRefs: execution ? [Number(execution.sequence)] : [],
    selectionReasonAtTime: null,
  };
}

export function listPendingMediumClaimRequirements(state, actorId) {
  const actor = (state.players ?? []).find((player) => player.id === actorId) ?? null;
  const activeClaimRoleId = (state.claims ?? []).find((claim) => (
    claim.actorId === actorId && claim.status === 'active'
  ))?.roleId ?? null;
  if (!actor?.alive || activeClaimRoleId !== 'medium') return [];

  const publishedActionDays = new Set(
    (state.publicAbilityClaims ?? [])
      .filter((claim) => claim.status !== 'voided'
        && claim.actorId === actorId
        && claim.claimedRoleId === 'medium')
      .map((claim) => Number(claim.actionDay)),
  );
  const currentDay = Number(state.game?.day ?? 0);
  return (state.events ?? [])
    .filter((event) => event.status === 'published'
      && event.type === 'execution'
      && Number.isInteger(Number(event.sequence)))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((event) => ({
      roleId: 'medium',
      ...buildAbilityClaimTiming('medium', Number(event.day)),
      targetId: event.payload?.targetId ?? event.targetIds?.[0] ?? null,
      selectionBasis: 'rule-forced',
      requiredEvidenceEventIds: [event.id],
      requiredEvidenceRefs: [Number(event.sequence)],
      selectionReasonAtTime: null,
    }))
    .filter((item) => item.targetId
      && item.availableDay <= currentDay
      && !publishedActionDays.has(item.actionDay));
}

function activeHistory(state, actorId, roleId, excludeSourceEventId = null, additionalClaims = []) {
  return [
    ...(state.publicAbilityClaims ?? []).filter((item) => item.status !== 'voided'
      && item.actorId === actorId
      && item.claimedRoleId === roleId
      && item.sourceEventId !== excludeSourceEventId),
    ...(additionalClaims ?? []).filter((item) => item.actorId === actorId
      && item.claimedRoleId === roleId),
  ];
}

function targetUnavailableAtNightAction(target, actionDay) {
  return Boolean(target?.death && Number(target.death.day) <= Number(actionDay));
}

function validateSelectionBasis(state, claim, actionDay) {
  const errors = [];
  const basis = String(claim.selectionBasis ?? '');
  const evidenceEventIds = Array.isArray(claim.evidenceEventIds) ? claim.evidenceEventIds : [];
  const selectionReasonAtTime = String(claim.selectionReasonAtTime ?? '').trim();
  if (!SELECTION_BASES.has(basis)) {
    errors.push('能力結果主張のselectionBasisが不正です。');
    return errors;
  }

  const evidenceRefs = evidenceEventIds.map((eventId) => {
    const event = (state.events ?? []).find((item) => item.id === eventId);
    return event?.sequence ?? NaN;
  });
  if (evidenceRefs.some((value) => !Number.isInteger(Number(value)))) {
    errors.push('能力結果主張の公開根拠イベント参照が不正です。');
    return errors;
  }
  const timeline = resolveAbilityEvidenceRefs(state, evidenceRefs, actionDay);
  errors.push(...timeline.errors);
  const unlistedReasonSequences = getUnlistedAbilityReasonSequences(selectionReasonAtTime, evidenceRefs);
  if (unlistedReasonSequences.length) {
    errors.push(`能力結果主張のselectionReasonAtTimeが構造化根拠にない公開番号を参照しています: ${unlistedReasonSequences.map((sequence) => `#${sequence}`).join('、')}`);
  }

  if (basis === 'no-public-information' && evidenceEventIds.length) errors.push('no-public-informationでは公開根拠イベントを指定できません。');
  if (basis === 'public-evidence' && !evidenceEventIds.length) errors.push('public-evidenceでは能力決定時点までに公開済みの根拠参照が必要です。');
  if (basis === 'rule-forced') {
    if (!evidenceEventIds.length) errors.push('rule-forcedでは対象を決めた公開履歴の参照が必要です。');
    if (selectionReasonAtTime) errors.push('rule-forcedでは追加の人物評価を過去理由として記載できません。');
  }
  return errors;
}

function validateUnknownResultRole(roleId, result, errors) {
  if (['guard', 'namahage', 'snowWoman'].includes(roleId) && result !== 'unknown') {
    errors.push(`${ROLE_DEFINITIONS[roleId].name}は能力成否を個別通知されないため、公開主張のresultはunknownです。`);
  }
}

export function validatePublicAbilityClaim(state, {
  actorId,
  claim,
  activeRoleId = null,
  announcedDay = state.game?.day,
  excludeSourceEventId = null,
  additionalClaims = [],
} = {}) {
  const errors = [];
  if (!claim) return errors;
  const roleId = claim.claimedRoleId ?? claim.roleId;
  const targetId = claim.targetId;
  const actionDay = Number(claim.actionDay);
  const result = normalizePublicAbilityResult(claim.result);
  const target = (state.players ?? []).find((player) => player.id === targetId);
  const definition = getPublicAbilityClaimDefinition(roleId);

  if (!definition) errors.push(`能力結果主張のroleIdは${PUBLIC_ABILITY_ROLE_IDS.join('、')}のいずれかです。`);
  if (!activeRoleId) errors.push('能力結果を公開する場合は、同じ発言までに対応する役職をCOしてください。');
  else if (roleId !== activeRoleId) errors.push('能力結果主張の役職と、発言後に有効となるCO役職が一致していません。');
  if (!target) errors.push('能力結果主張の対象が存在しません。');
  errors.push(...validateAbilityClaimTiming(roleId, claim, { announcedDay }));
  if (!PUBLIC_ABILITY_RESULTS.includes(result)) errors.push('能力結果主張のresultが不正です。');
  if (definition && !definition.results.includes(result)) {
    errors.push(`${ROLE_DEFINITIONS[roleId].name}のresultは${definition.results.join('または')}で指定してください。`);
  }
  if (definition && claim.actionType !== definition.actionType) {
    errors.push(`${ROLE_DEFINITIONS[roleId].name}のactionTypeは${definition.actionType}です。`);
  }
  const structuralErrorCount = errors.length;
  errors.push(...validateSelectionBasis(state, claim, actionDay));
  if (structuralErrorCount || !target) return errors;

  const history = activeHistory(state, actorId, roleId, excludeSourceEventId, additionalClaims);
  if (history.some((item) => Number(item.actionDay) === actionDay)) {
    errors.push('同じ役職・同じactionDayの能力結果主張がすでにあります。内容を変える場合は公開発言の訂正を使用してください。');
  }

  if (roleId === 'seer') {
    if (actionDay === 0 && state.game?.rules?.firstNight?.seerMode === 'disabled') errors.push('初日占いが無効な設定では初夜の占い結果を主張できません。');
    if (target.id === actorId && !state.game?.rules?.seer?.selfTargetAllowed) errors.push('公開ルール上、占い師は自分自身を占えません。');
    if (targetUnavailableAtNightAction(target, actionDay)) errors.push('その対象は能力を実行した夜の開始時点で生存していないため、占い履歴として成立しません。');
    if (!state.game?.rules?.seer?.repeatedTargetAllowed && history.some((item) => item.targetId === target.id)) {
      errors.push('公開ルール上、同じ対象を再度占えません。');
    }
  }

  if (roleId === 'medium') {
    if (actionDay < 1) errors.push('霊能結果はDay 1以降の処刑に対応する必要があります。');
    const requirements = resolvePublicAbilityClaimRequirements(state, { roleId, actionDay, targetId: target.id });
    if (!requirements.requiredEvidenceEventIds.length) {
      errors.push('霊能結果の対象とactionDayは、実際に公開された処刑履歴と一致している必要があります。');
    }
    if (claim.selectionBasis !== requirements.selectionBasis) errors.push('霊能結果のselectionBasisはrule-forcedです。');
    const submittedIds = [...new Set(claim.evidenceEventIds ?? [])].sort();
    const requiredIds = [...requirements.requiredEvidenceEventIds].sort();
    if (JSON.stringify(submittedIds) !== JSON.stringify(requiredIds)) {
      errors.push(`霊能結果のevidenceRefsは対象を決めた処刑イベント${requirements.requiredEvidenceRefs.map((ref) => `#${ref}`).join('、')}だけを指定してください。`);
    }
  }

  if (roleId === 'guard') {
    validateUnknownResultRole(roleId, result, errors);
    if (actionDay === 0 && !state.game?.rules?.firstNight?.guardEnabled) errors.push('初夜護衛が無効な設定では初夜の護衛履歴を主張できません。');
    if (target.id === actorId && !state.game?.rules?.guard?.selfGuardAllowed) errors.push('公開ルール上、狩人は自分自身を護衛できません。');
    if (targetUnavailableAtNightAction(target, actionDay)) errors.push('その対象は能力を実行した夜の開始時点で生存していないため、護衛履歴として成立しません。');
    if (!state.game?.rules?.guard?.consecutiveGuardAllowed) {
      const previous = [...history].filter((item) => Number(item.actionDay) < actionDay).sort((a, b) => Number(b.actionDay) - Number(a.actionDay))[0];
      if (previous && Number(previous.actionDay) === actionDay - 1 && previous.targetId === target.id) {
        errors.push('公開ルール上、同じ対象を連続して護衛できません。');
      }
    }
  }

  if (roleId === 'namahage') {
    validateUnknownResultRole(roleId, result, errors);
    if (actionDay < 1) errors.push('なまはげはDay 1夜から行動するため、最初の訪問履歴のactionDayは1です。');
    if (target.id === actorId) errors.push('公開ルール上、なまはげは自分自身を訪問できません。');
    if (targetUnavailableAtNightAction(target, actionDay)) errors.push('その対象は能力を実行した夜の開始時点で生存していないため、訪問履歴として成立しません。');
    const previous = [...history].filter((item) => Number(item.actionDay) < actionDay).sort((a, b) => Number(b.actionDay) - Number(a.actionDay))[0];
    if (previous && Number(previous.actionDay) === actionDay - 1 && previous.targetId === target.id) {
      errors.push('公開ルール上、なまはげは同じ対象を連続して訪問できません。');
    }
  }

  if (roleId === 'snowWoman') {
    validateUnknownResultRole(roleId, result, errors);
    if (actionDay < 1) errors.push('雪女はDay 1夜から行動するため、最初の凍結履歴のactionDayは1です。');
    if (target.id === actorId) errors.push('公開ルール上、雪女は自分自身を凍結できません。');
    if (targetUnavailableAtNightAction(target, actionDay)) errors.push('その対象は能力を実行した夜の開始時点で生存していないため、凍結履歴として成立しません。');
    const previous = [...history].filter((item) => Number(item.actionDay) < actionDay).sort((a, b) => Number(b.actionDay) - Number(a.actionDay))[0];
    if (previous && Number(previous.actionDay) === actionDay - 1 && previous.targetId === target.id) {
      errors.push('公開ルール上、雪女は同じ対象を連続して凍結できません。');
    }
  }

  return errors;
}
