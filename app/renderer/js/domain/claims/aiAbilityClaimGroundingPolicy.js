/**
 * 責務: AIがtruthfulとして公開する能力主張を、本人に実在する非公開の正式記録へ結び付け、対象・結果・実行時点・取得時点・役職を正本から解決する。
 * 変更ルール: 公開能力履歴の一般検証や騙り内容の妥当性は扱わない。truthfulではAI入力の対象・結果・時刻を受け取らず、本人可視のprivate-resultまたは本人の正式night-action P#を参照する。結果を別イベントで受け取る能力のnight-action P#は、同じ対象・実行夜のprivate-resultへ決定的に結び付けて正本化する。deceptionは本ポリシーの対象外とする。
 */

import { getPublicAbilityClaimDefinition, normalizePublicAbilityResult } from '../policies/publicAbilityClaimPolicy.js';
import { buildAbilityClaimTiming } from '../policies/abilityClaimTimingPolicy.js';

const ROLE_ID_BY_ACTION_TYPE = Object.freeze({
  inspect: 'seer',
  medium: 'medium',
  guard: 'guard',
  visit: 'namahage',
  freeze: 'snowWoman',
});

const PRIVATE_RESULT_ACTION_TYPES = new Set(['inspect', 'medium']);
const ACTION_ONLY_TYPES = new Set(['guard', 'visit', 'freeze']);

function isOwnPrivateEvent(event, actorId) {
  return event?.actorId === actorId
    && event?.status !== 'voided'
    && event?.audience?.type === 'player'
    && (event.audience.targetIds ?? []).includes(actorId)
    && Number.isInteger(Number(event.sequence));
}

function sourceDescriptor(event, { sourceRefOverride = null } = {}) {
  const actionType = String(event?.payload?.actionType ?? '');
  const roleId = ROLE_ID_BY_ACTION_TYPE[actionType] ?? null;
  if (!roleId || !getPublicAbilityClaimDefinition(roleId)) return null;

  if (event.type === 'private-result' && PRIVATE_RESULT_ACTION_TYPES.has(actionType)) {
    const availableDay = Number(event.payload?.availableFromDay ?? event.day);
    const actionDay = actionType === 'inspect'
      ? Number(event.payload?.nightDay ?? availableDay - 1)
      : availableDay - 1;
    const timing = buildAbilityClaimTiming(roleId, actionDay);
    const result = normalizePublicAbilityResult(event.payload?.result);
    if (!timing || timing.availableDay !== availableDay) return null;
    if (!getPublicAbilityClaimDefinition(roleId)?.results?.includes(result)) return null;
    return {
      sourceEventId: event.id,
      sourceRef: Number(sourceRefOverride ?? event.sequence),
      roleId,
      actionType,
      targetId: event.payload?.targetId ?? event.targetIds?.[0] ?? null,
      result,
      ...timing,
    };
  }

  if (event.type === 'night-action' && ACTION_ONLY_TYPES.has(actionType)) {
    const nightDay = Number(event.payload?.nightDay ?? event.day);
    const timing = buildAbilityClaimTiming(roleId, nightDay);
    if (!timing) return null;
    return {
      sourceEventId: event.id,
      sourceRef: Number(sourceRefOverride ?? event.sequence),
      roleId,
      actionType,
      targetId: event.payload?.targetId ?? event.targetIds?.[0] ?? null,
      result: 'unknown',
      ...timing,
    };
  }

  return null;
}

function linkedPrivateResultForNightAction(events, actorId, actionEvent) {
  const actionType = String(actionEvent?.payload?.actionType ?? '');
  if (!PRIVATE_RESULT_ACTION_TYPES.has(actionType)) return null;
  const targetId = actionEvent?.payload?.targetId ?? actionEvent?.targetIds?.[0] ?? null;
  const nightDay = Number(actionEvent?.payload?.nightDay ?? actionEvent?.day);
  return events
    .filter((event) => isOwnPrivateEvent(event, actorId)
      && event.type === 'private-result'
      && String(event.payload?.actionType ?? '') === actionType
      && (event.payload?.targetId ?? event.targetIds?.[0] ?? null) === targetId)
    .find((event) => {
      if (actionType !== 'inspect') return true;
      const availableDay = Number(event.payload?.availableFromDay ?? event.day);
      return Number(event.payload?.nightDay ?? availableDay - 1) === nightDay;
    }) ?? null;
}

export function listAiTruthfulAbilityClaimSources(state, actorId) {
  const events = state?.events ?? [];
  return events
    .filter((event) => isOwnPrivateEvent(event, actorId))
    .flatMap((event) => {
      const direct = sourceDescriptor(event);
      if (direct) return [direct];
      if (event.type !== 'night-action') return [];
      const linkedResult = linkedPrivateResultForNightAction(events, actorId, event);
      const linked = linkedResult
        ? sourceDescriptor(linkedResult, { sourceRefOverride: Number(event.sequence) })
        : null;
      return linked ? [linked] : [];
    })
    .filter((item) => item?.targetId)
    .sort((left, right) => left.sourceRef - right.sourceRef);
}

export function resolveAiTruthfulAbilityClaimSource(state, {
  actorId,
  sourceRef,
} = {}) {
  const sequence = Number(sourceRef);
  if (!Number.isInteger(sequence) || sequence < 1) {
    return { ok: false, errors: ['truthful能力結果のsourceRefは本人へ表示されたP#番号の正整数で指定してください。'], source: null };
  }
  const source = listAiTruthfulAbilityClaimSources(state, actorId)
    .find((item) => item.sourceRef === sequence) ?? null;
  if (!source) {
    return { ok: false, errors: [`P#${sequence}は本人がtruthful公開に使用できる正式な能力・行動記録ではありません。`], source: null };
  }
  return { ok: true, errors: [], source };
}
