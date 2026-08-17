/**
 * 責務: 人狼本人が把握している生存仲間だけを基準に、partnerDispositionの有効値と既定方針を決定する。
 * 変更ルール: 実配役を直接参照せず、呼出元から渡された本人可視のknownWolfIdsとalivePlayerIdsだけを使用する。partnerDispositionは永続的な公開上の扱いだけを表し、暫定投票先・実投票先との整合判定を持ち込まない。プロンプト表示・応答検証・状態登録は必ず本ポリシーを共有し、列挙値を別実装へ複製しない。
 */

const PARTNER_DISPOSITION_VALUES_WITH_PARTNER = Object.freeze(['independent', 'support', 'separate']);
const PARTNER_DISPOSITION_VALUES_SOLO = Object.freeze(['not-applicable']);

export function resolveWolfPartnerDispositionPolicy({
  actorId,
  knownWolfIds = [],
  alivePlayerIds = [],
} = {}) {
  const aliveSet = new Set(alivePlayerIds.map((id) => String(id)));
  const actorKey = String(actorId ?? '');
  const alivePartnerIds = [...new Set(knownWolfIds.map((id) => String(id)))]
    .filter((id) => id && id !== actorKey && aliveSet.has(id));
  const hasAlivePartner = alivePartnerIds.length > 0;
  const allowedValues = hasAlivePartner
    ? [...PARTNER_DISPOSITION_VALUES_WITH_PARTNER]
    : [...PARTNER_DISPOSITION_VALUES_SOLO];
  return Object.freeze({
    alivePartnerIds: Object.freeze(alivePartnerIds),
    hasAlivePartner,
    allowedValues: Object.freeze(allowedValues),
    defaultValue: hasAlivePartner ? 'independent' : 'not-applicable',
    requiredValue: hasAlivePartner ? null : 'not-applicable',
  });
}

export function isWolfPartnerDispositionApplicable(policy = null) {
  if (!policy) return true;
  if (policy.hasAlivePartner === false) return false;
  const allowedValues = [...(policy.allowedValues ?? [])].map((value) => String(value).trim().toLowerCase());
  return !(allowedValues.length === 1 && allowedValues[0] === 'not-applicable');
}

export function validateWolfPartnerDispositionChoice({
  policy,
  disposition,
} = {}) {
  const normalized = String(disposition ?? '').trim().toLowerCase();
  const allowedValues = policy?.allowedValues ?? PARTNER_DISPOSITION_VALUES_SOLO;
  if (allowedValues.includes(normalized)) return [];
  return [`partnerDispositionは${allowedValues.join(' / ')}のいずれかで指定してください。`];
}

export {
  PARTNER_DISPOSITION_VALUES_SOLO,
  PARTNER_DISPOSITION_VALUES_WITH_PARTNER,
};
