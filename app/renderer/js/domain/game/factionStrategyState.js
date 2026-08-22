/**
 * 責務: 人狼・狂人・妖狐系プロフィール本人だけに可視な陣営戦略状態を正規化・生成し、局面ポリシーに従う差分適用・現在ポリシーへの補正・完成状態検証を一元実行する。
 * 変更ルール: 公開判断状態へ混在させない。公開イベントへ派生させない。人狼仲間以外へ人狼用戦略を公開せず、狂人へ実際の人狼IDを追加しない。陣営戦略更新は思考品質向上用の任意入力とし、省略時は現在値を変更しない。保存済み戦略がない状態でkeepが届いた場合も無変更として受理し、空の戦略状態を新規作成しない。AI応答の差分と保存直前の完成状態は必ず本ファイルの同じ正規化規則を通し、検証器と状態更新層で列挙値補正を重複実装しない。更新契機の判定はfactionStrategyPolicy.jsへ委譲する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import {
  PARTNER_DISPOSITION_VALUES_SOLO,
  PARTNER_DISPOSITION_VALUES_WITH_PARTNER,
  isWolfPartnerDispositionApplicable,
  validateWolfPartnerDispositionChoice,
} from './wolfPartnerDispositionPolicy.js';

const FACTION_STRATEGY_ROLE_IDS = Object.freeze(Object.values(ROLE_DEFINITIONS).filter((role) => role.strategyProfile).map((role) => role.id));
const FACTION_STRATEGY_PROFILES = Object.freeze(['wolf', 'madman', 'fox']);
const FACTION_STRATEGY_FIELDS_BY_ROLE = Object.freeze({
  wolf: Object.freeze([
    'publicWorld',
    'dayWinPath',
    'partnerDisposition',
    'collapsePlan',
    'failureRisk',
  ]),
  madman: Object.freeze([
    'publicWorld',
    'dayWinPath',
    'linkageRisk',
    'fallbackRoute',
    'failureRisk',
  ]),
  fox: Object.freeze([
    'publicWorld',
    'pressureGoal',
    'failureRisk',
    'nextDayPlan',
  ]),
});
const FACTION_STRATEGY_FIELDS = Object.freeze([
  ...new Set(Object.values(FACTION_STRATEGY_FIELDS_BY_ROLE).flat()),
]);
const WOLF_PARTNER_DISPOSITIONS = Object.freeze([
  ...PARTNER_DISPOSITION_VALUES_WITH_PARTNER,
  ...PARTNER_DISPOSITION_VALUES_SOLO,
]);

function resolveStrategyProfile(roleOrProfile) {
  const value = String(roleOrProfile ?? '');
  if (FACTION_STRATEGY_PROFILES.includes(value)) return value;
  return ROLE_DEFINITIONS[value]?.strategyProfile ?? null;
}

export function isFactionStrategyRole(roleId) {
  return Boolean(resolveStrategyProfile(roleId));
}

export function getFactionStrategyFields(roleOrProfile) {
  return [...(FACTION_STRATEGY_FIELDS_BY_ROLE[resolveStrategyProfile(roleOrProfile)] ?? [])];
}

export function isSubstantiveFactionStrategyText(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const normalized = text
    .replace(/[。．.!！?？]+$/gu, '')
    .replace(/\s+/gu, '')
    .toLowerCase();
  return !/^(?:none|なし|特になし|特にありません|未定|不明|分からない|わからない|情報不足|まだ不明|まだ分からない|まだわからない)$/u.test(normalized);
}

export function createEmptyFactionStrategyState(roleId) {
  const normalizedProfile = resolveStrategyProfile(roleId);
  if (!normalizedProfile) return null;
  return {
    profile: normalizedProfile,
    ...Object.fromEntries(getFactionStrategyFields(normalizedProfile).map((key) => [key, ''])),
    updatedAt: null,
    sourceAiTurnId: null,
  };
}

export function normalizeFactionStrategyState(update, roleId) {
  const normalizedProfile = resolveStrategyProfile(roleId);
  if (!normalizedProfile || !update) return null;
  return {
    profile: normalizedProfile,
    ...Object.fromEntries(getFactionStrategyFields(normalizedProfile).map((key) => [
      key,
      key === 'partnerDisposition'
        ? String(update[key] ?? '').trim().toLowerCase()
        : String(update[key] ?? '').trim(),
    ])),
  };
}

export function normalizeFactionStrategyForPolicy(update, roleId, {
  partnerDispositionPolicy = null,
} = {}) {
  const normalized = normalizeFactionStrategyState(update, roleId);
  if (!normalized) return null;
  if (normalized.profile === 'wolf' && partnerDispositionPolicy?.requiredValue) {
    normalized.partnerDisposition = String(partnerDispositionPolicy.requiredValue).trim().toLowerCase();
  }
  return normalized;
}

export function validateFactionStrategyState(update, roleId, {
  partnerDispositionPolicy = null,
  requiredFields = null,
  allowPartial = true,
  requireSubstantive = false,
} = {}) {
  const errors = [];
  const normalizedProfile = resolveStrategyProfile(roleId);
  if (!normalizedProfile) {
    if (update) errors.push('村人陣営の役職など、陣営戦略対象外の役職は陣営戦略状態を使用できません。');
    return errors;
  }
  const required = new Set(requiredFields ?? (allowPartial ? [] : getFactionStrategyFields(normalizedProfile)));
  if (!update) {
    if (required.size) errors.push('完全性監査では陣営戦略状態の指定が必要です。');
    return errors;
  }
  if (String(update.profile ?? normalizedProfile) !== normalizedProfile) {
    errors.push('陣営戦略のプロフィールが本人の役職と一致していません。');
  }
  const allowedFields = new Set(getFactionStrategyFields(normalizedProfile));
  Object.keys(update).forEach((key) => {
    if (FACTION_STRATEGY_FIELDS.includes(key) && !allowedFields.has(key)) {
      errors.push(`陣営戦略の${key}は${normalizedProfile}では使用できません。本人役職の現行項目だけを記載してください。`);
    }
  });
  getFactionStrategyFields(normalizedProfile).forEach((key) => {
    const rawValue = String(update[key] ?? '').trim();
    if (key === 'partnerDisposition') {
      if (!rawValue && !required.has(key)) return;
      errors.push(...validateWolfPartnerDispositionChoice({
        policy: partnerDispositionPolicy ?? { allowedValues: WOLF_PARTNER_DISPOSITIONS },
        disposition: rawValue,
      }).map((error) => `陣営戦略の${error}`));
      return;
    }
    if (!rawValue && !required.has(key)) return;
    if (requireSubstantive && !isSubstantiveFactionStrategyText(rawValue)) {
      errors.push(`陣営戦略の${key}へ、今回の具体的な判断を記載してください。none、なし、未定、情報不足だけの回答は使用できません。`);
    }
  });
  if (normalizedProfile === 'madman' && String(update.publicWorld ?? '').trim()) {
    const publicWorld = String(update.publicWorld ?? '');
    const assertionText = publicWorld.replace(
      /(?:確定人狼|人狼確定|狼確定)(?:ではない|でない|とはいえない|とは言えない|といえない|と言えない|できない|していない|ではなく|でなく)/gu,
      '',
    );
    if (/(?:確定人狼|人狼確定|狼確定)|(?:人狼|狼)(?:は|が)[^。\r\n]{0,30}(?:確定|確実|判明)/u.test(assertionText)) {
      errors.push('狂人は人狼の正体を確定情報として扱えません。publicWorldは公開情報から成立する候補・仮説として記載してください。');
    }
  }
  return errors;
}

export function normalizeFactionStrategyPatch(patch, roleId) {
  const normalizedProfile = resolveStrategyProfile(roleId);
  if (!normalizedProfile || !patch || typeof patch !== 'object') return null;
  const mode = String(patch.mode ?? '').trim().toLowerCase();
  const sourceChanges = patch.changes && typeof patch.changes === 'object' && !Array.isArray(patch.changes)
    ? patch.changes
    : {};
  const allowedFields = new Set(getFactionStrategyFields(normalizedProfile));
  const changes = Object.fromEntries(
    Object.entries(sourceChanges)
      .filter(([key]) => allowedFields.has(key))
      .map(([key, value]) => [
        key,
        key === 'partnerDisposition'
          ? String(value ?? '').trim().toLowerCase()
          : String(value ?? '').trim(),
      ]),
  );
  return { mode, changes };
}

export function applyFactionStrategyPatch(previousState, patch, roleId) {
  const normalizedProfile = resolveStrategyProfile(roleId);
  const normalizedPatch = normalizeFactionStrategyPatch(patch, normalizedProfile);
  if (!normalizedPatch) return null;
  const base = previousState?.profile === normalizedProfile
    ? normalizeFactionStrategyState(previousState, normalizedProfile)
    : createEmptyFactionStrategyState(normalizedProfile);
  if (normalizedPatch.mode === 'keep') return normalizeFactionStrategyState(base, normalizedProfile);
  if (normalizedPatch.mode !== 'patch') return null;
  return normalizeFactionStrategyState({ ...base, ...normalizedPatch.changes }, normalizedProfile);
}

export function validateFactionStrategyPatch(previousState, patch, roleId, {
  partnerDispositionPolicy = null,
  updatePolicy = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const normalizedProfile = resolveStrategyProfile(roleId);
  if (!normalizedProfile) {
    if (patch) errors.push('陣営戦略対象外の役職はfactionStrategyPatchを出力できません。');
    return { errors, warnings, resolvedUpdate: null };
  }

  const normalizedPrevious = previousState?.profile === normalizedProfile
    ? normalizeFactionStrategyForPolicy(previousState, normalizedProfile, { partnerDispositionPolicy })
    : previousState;
  const requiredFields = [...(updatePolicy?.requiredFields ?? [])];
  const policyMissingFields = updatePolicy?.missingRequiredFields;
  const missingRecommendedFields = Array.isArray(policyMissingFields)
    ? [...policyMissingFields]
    : requiredFields.filter((key) => {
      const value = String(normalizedPrevious?.[key] ?? '').trim();
      return key === 'partnerDisposition' ? !value : !isSubstantiveFactionStrategyText(value);
    });
  const hasPrevious = Boolean(previousState?.updatedAt);
  if (!patch) {
    return { errors, warnings, resolvedUpdate: null };
  }

  const rawChanges = patch?.changes;
  if (!rawChanges || typeof rawChanges !== 'object' || Array.isArray(rawChanges)) {
    errors.push('factionStrategyPatch.changesはオブジェクトで指定してください。');
  }
  const allowedFields = new Set(getFactionStrategyFields(normalizedProfile)
    .filter((key) => key !== 'partnerDisposition' || isWolfPartnerDispositionApplicable(partnerDispositionPolicy)));
  Object.keys(rawChanges ?? {}).forEach((key) => {
    if (FACTION_STRATEGY_FIELDS.includes(key) && !allowedFields.has(key)) {
      errors.push(`factionStrategyPatch.changes.${key}は${normalizedProfile}では使用できません。本人役職の現行項目だけを記載してください。`);
    }
  });

  const normalizedPatch = normalizeFactionStrategyPatch(patch, normalizedProfile);
  if (!normalizedPatch) return { errors: [...errors, 'factionStrategyPatchを解析できません。'], warnings, resolvedUpdate: null };
  if (!['keep', 'patch'].includes(normalizedPatch.mode)) {
    errors.push('factionStrategyPatch.modeはkeepまたはpatchで指定してください。');
  }
  if (normalizedPatch.mode === 'keep') {
    if (Object.keys(normalizedPatch.changes).length) {
      errors.push('factionStrategyPatch.modeがkeepの場合、changesは空オブジェクトにしてください。');
    }
    // 保存済み戦略がないkeepは意味上の無操作として扱う。
    // 応答全文の再生成を要求せず、状態も新規作成しない。
    if (!hasPrevious) {
      return {
        errors: [...new Set(errors)],
        warnings: [...new Set(warnings)],
        resolvedUpdate: null,
      };
    }
    if (missingRecommendedFields.length) {
      warnings.push(`未設定の推奨項目があります。品質向上のため次回patchで検討してください: ${missingRecommendedFields.join(', ')}。`);
    }
  }
  if (normalizedPatch.mode === 'patch'
    && !Object.keys(normalizedPatch.changes).length
    && (!rawChanges || Object.keys(rawChanges).length === 0)) {
    errors.push('factionStrategyPatch.modeがpatchの場合、changesへ変更項目を1件以上指定してください。');
  }

  // 今回送信した差分と保存済み完成状態を分け、過去状態を無関係な差分検証で再拒否しない。
  errors.push(...validateFactionStrategyState(normalizedPatch.changes, normalizedProfile, {
    partnerDispositionPolicy,
    requiredFields: [],
    allowPartial: true,
    requireSubstantive: false,
  }));
  Object.entries(normalizedPatch.changes).forEach(([key, value]) => {
    if (key !== 'partnerDisposition' && !isSubstantiveFactionStrategyText(value)) {
      warnings.push(`factionStrategyPatch.changes.${key}は任意ですが、出力する場合は具体的な戦略を記載すると後続AIの判断品質が上がります。`);
    }
  });

  let resolvedUpdate = applyFactionStrategyPatch(normalizedPrevious, normalizedPatch, normalizedProfile);
  resolvedUpdate = normalizeFactionStrategyForPolicy(resolvedUpdate, normalizedProfile, { partnerDispositionPolicy });
  if (resolvedUpdate) {
    errors.push(...validateFactionStrategyState(resolvedUpdate, normalizedProfile, {
      partnerDispositionPolicy,
      requiredFields: [],
      allowPartial: true,
      requireSubstantive: false,
    }));
    const stillMissingRecommendedFields = requiredFields.filter((key) => {
      const value = String(resolvedUpdate[key] ?? '').trim();
      return key === 'partnerDisposition' ? !value : !isSubstantiveFactionStrategyText(value);
    });
    if (stillMissingRecommendedFields.length) {
      warnings.push(`陣営戦略の推奨項目が未設定です。ゲーム進行は継続しますが、後続AIの判断品質向上のため次回更新を検討してください: ${stillMissingRecommendedFields.join(', ')}。`);
    }
  }
  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    resolvedUpdate: errors.length ? null : resolvedUpdate,
  };
}

export function createFactionStrategyState(roleId, update, {
  updatedAt = null,
  sourceAiTurnId = null,
} = {}) {
  const normalized = normalizeFactionStrategyState(update, roleId);
  if (!normalized) return createEmptyFactionStrategyState(roleId);
  return {
    ...normalized,
    updatedAt,
    sourceAiTurnId,
  };
}

export {
  FACTION_STRATEGY_FIELDS,
  FACTION_STRATEGY_FIELDS_BY_ROLE,
  FACTION_STRATEGY_PROFILES,
  FACTION_STRATEGY_ROLE_IDS,
  WOLF_PARTNER_DISPOSITIONS,
};
