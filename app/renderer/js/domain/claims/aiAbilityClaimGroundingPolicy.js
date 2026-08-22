/**
 * 責務: AIがtruthfulとして公開する能力主張を、本人に実在する非公開の正式記録へ結び付け、対象・結果・resultDay・役職を正本から解決する。
 * 変更ルール: 公開能力履歴の一般検証や騙り内容の妥当性は扱わない。truthfulではAI入力の対象・結果を受け取らず、本人可視のprivate-resultまたは本人の正式night-actionだけを参照する。deceptionは本ポリシーの対象外とする。
 */

import { getPublicAbilityClaimDefinition, normalizePublicAbilityResult } from '../policies/publicAbilityClaimPolicy.js';

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

function sourceDescriptor(event) {
  const actionType = String(event?.payload?.actionType ?? '');
  const roleId = ROLE_ID_BY_ACTION_TYPE[actionType] ?? null;
  if (!roleId || !getPublicAbilityClaimDefinition(roleId)) return null;

  if (event.type === 'private-result' && PRIVATE_RESULT_ACTION_TYPES.has(actionType)) {
    const observedDay = Number(event.payload?.availableFromDay ?? event.day);
    const result = normalizePublicAbilityResult(event.payload?.result);
    if (!Number.isInteger(observedDay) || observedDay < 1) return null;
    if (!getPublicAbilityClaimDefinition(roleId)?.results?.includes(result)) return null;
    return {
      sourceEventId: event.id,
      sourceRef: Number(event.sequence),
      roleId,
      actionType,
      targetId: event.payload?.targetId ?? event.targetIds?.[0] ?? null,
      result,
      observedDay,
    };
  }

  if (event.type === 'night-action' && ACTION_ONLY_TYPES.has(actionType)) {
    const nightDay = Number(event.payload?.nightDay ?? event.day);
    if (!Number.isInteger(nightDay) || nightDay < 0) return null;
    return {
      sourceEventId: event.id,
      sourceRef: Number(event.sequence),
      roleId,
      actionType,
      targetId: event.payload?.targetId ?? event.targetIds?.[0] ?? null,
      result: 'unknown',
      observedDay: nightDay + 1,
    };
  }

  return null;
}

export function listAiTruthfulAbilityClaimSources(state, actorId) {
  return (state?.events ?? [])
    .filter((event) => isOwnPrivateEvent(event, actorId))
    .map(sourceDescriptor)
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
