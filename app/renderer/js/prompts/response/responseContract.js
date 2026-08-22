/**
 * 責務: AI応答JSONの回答検証契約、タスク別許可キー、役職適合済み許可キー、欠落時に進行を止める必須キー、完全契約例を一元管理する。
 * 変更ルール:
 * - ゲーム状態を更新せず、表示用文章を組み立てない。
 * - requiredTopLevelKeysは『欠落時に回答拒否・修復・再生成が必要な回答検証必須項目』だけを表し、AIへプロンプト上で出力を求める項目集合とは意図的に一致させない。
 * - rationale / decisionPatchなど進行に不可欠でない項目はAI向け説明・JSON例へ掲載してもrequiredTopLevelKeysへ追加せず、欠落だけでエラーにしない。
 * - 汎用パーサー向けのタスク別許可キーと、本人役職に適合する実行時許可キーを分離し、役職適合判定はfactionStrategyState.jsを正本とする。
 * - 通常発言はpublicSpeechを回答検証必須とする。
 * - 投票理由はrationaleを正本とし、投票のdecisionPatchは比較・不確実性・公開根拠参照だけを扱う。
 * - 構文キーを追加・変更する場合はresponseParser.js、responseAutoRepair.js、responseContractCatalog.js、activeResponseContract.jsを同時に変更する。
 * - 通常の完全例と、実行時だけ追加できる条件付き例を分離して生成工程・自動検査へ渡す。
 * - フェーズプロンプトへ掲載する項目の選択はactiveResponseContract.jsへ委譲し、回答検証契約との集合一致を要求しない。
 * - 個人夜行動かどうかの分類はpersonalNightActionTasks.jsへ委譲し、本モジュールは各taskTypeの応答モード対応だけを明示する。
 * - 公開イベント番号は固定値を置かず、呼出元から渡された実在参照だけを使用する。
 * - heartVoiceのAI生成許可は通常昼発言系とpriority-answerだけに限定し、生成・保存契約は維持する一方、過去の保存済みheartVoiceが次回入力へ再投入されることを前提にしない。
 * - 遺言・墓場会話では新規応答キーとして許可しない。
 */

import { getFactionStrategyFields, isFactionStrategyRole } from '../../domain/game/factionStrategyState.js';
import { isWolfPartnerDispositionApplicable } from '../../domain/game/wolfPartnerDispositionPolicy.js';
import { getPublicAbilityClaimDefinition } from '../../domain/policies/publicAbilityClaimPolicy.js';

const COMMON_DECISION_CHANGE_KEYS = Object.freeze([
  'suspects', 'executionCandidates', 'intendedVote', 'assessmentLevel',
  'leaveAliveBenefit', 'misexecutionCost', 'selectionDifference',
  'uncertainty', 'nextDiscriminatingInformation',
]);

const VOTE_DECISION_CHANGE_KEYS = Object.freeze(
  COMMON_DECISION_CHANGE_KEYS.filter((key) => key !== 'intendedVote'),
);

export const RESPONSE_MODE_DEFINITIONS = Object.freeze({
  none: Object.freeze({
    allowedTopLevelKeys: Object.freeze([]),
    requiredTopLevelKeys: Object.freeze([]),
    decisionChangeKeys: Object.freeze([]),
  }),
  wolf: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['wolfMessage', 'sharedStrategy', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['wolfMessage']),
    decisionChangeKeys: Object.freeze([]),
  }),
  mason: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['masonMessage', 'decisionPatch', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['masonMessage']),
    decisionChangeKeys: COMMON_DECISION_CHANGE_KEYS,
  }),
  graveyard: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['graveyardMessage', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['graveyardMessage']),
    decisionChangeKeys: Object.freeze([]),
  }),
  'attack-action': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['actionAnswer', 'attackAssessment', 'rationale']),
    requiredTopLevelKeys: Object.freeze(['actionAnswer']),
    decisionChangeKeys: Object.freeze([]),
  }),
  'freeze-action': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['estimate', 'actionAnswer', 'rationale']),
    requiredTopLevelKeys: Object.freeze(['actionAnswer']),
    decisionChangeKeys: Object.freeze([]),
  }),
  'night-action': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['actionAnswer', 'rationale']),
    requiredTopLevelKeys: Object.freeze(['actionAnswer']),
    decisionChangeKeys: Object.freeze([]),
  }),
  vote: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['actionAnswer', 'rationale', 'decisionPatch', 'factionStrategy', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['actionAnswer']),
    decisionChangeKeys: VOTE_DECISION_CHANGE_KEYS,
  }),
  speech: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims', 'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['publicSpeech']),
    decisionChangeKeys: COMMON_DECISION_CHANGE_KEYS,
  }),
  'speech-designated': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims', 'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd', 'nextSpeakerPreference']),
    requiredTopLevelKeys: Object.freeze(['publicSpeech']),
    decisionChangeKeys: COMMON_DECISION_CHANGE_KEYS,
  }),
  'speech-free': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims', 'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd', 'discussionPreference']),
    requiredTopLevelKeys: Object.freeze(['publicSpeech']),
    decisionChangeKeys: COMMON_DECISION_CHANGE_KEYS,
  }),
  'discussion-opening-preference': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['openingPreference']),
    requiredTopLevelKeys: Object.freeze(['openingPreference']),
    decisionChangeKeys: Object.freeze([]),
  }),
  'priority-answer': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['publicSpeech', 'coOperation', 'abilityClaims', 'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['publicSpeech']),
    decisionChangeKeys: COMMON_DECISION_CHANGE_KEYS,
  }),
  testament: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['publicSpeech', 'coOperation', 'abilityClaims', 'memoAdd']),
    requiredTopLevelKeys: Object.freeze(['publicSpeech']),
    decisionChangeKeys: Object.freeze([]),
  }),
  'public-only': Object.freeze({
    allowedTopLevelKeys: Object.freeze(['publicSpeech']),
    requiredTopLevelKeys: Object.freeze(['publicSpeech']),
    decisionChangeKeys: Object.freeze([]),
  }),
  memo: Object.freeze({
    allowedTopLevelKeys: Object.freeze(['fullMemo']),
    requiredTopLevelKeys: Object.freeze(['fullMemo']),
    decisionChangeKeys: Object.freeze([]),
  }),
});

const RESPONSE_MODE_BY_TASK_TYPE = Object.freeze({
  briefing: 'none',
  'mason-conversation': 'mason',
  'graveyard-conversation': 'graveyard',
  'wolf-conversation': 'wolf',
  'wolf-attack': 'attack-action',
  inspect: 'night-action',
  guard: 'night-action',
  visit: 'night-action',
  freeze: 'freeze-action',
  'choose-owner': 'night-action',
  speech: 'speech',
  'speech-designated': 'speech-designated',
  'speech-free': 'speech-free',
  'discussion-opening-preference': 'discussion-opening-preference',
  'priority-answer': 'priority-answer',
  testament: 'testament',
  'result-impression': 'public-only',
  vote: 'vote',
  'memo-consolidate': 'memo',
});
const SHARED_STRATEGY_FIELDS = Object.freeze([
  'claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan',
  'collapsePlan', 'discussionPlan', 'attackPlan',
]);
const HEART_VOICE_EXAMPLE = '公開発言や行動理由へ直接出していない、その局面固有の感情・本音・迷い・警戒・期待';
const MEMO_ADD_EXAMPLE = '次以降のターンでも保持すべき仮説、警戒点、予定、表では言わなかった狙い';

const EMPTY_EXAMPLE_REFERENCES = Object.freeze({
  answerToRefs: Object.freeze([]),
  correctedSpeechRefs: Object.freeze([]),
  decisionEvidenceRefs: Object.freeze([]),
  abilityEvidenceRefs: Object.freeze([]),
  truthfulAbilitySourceRefs: Object.freeze([]),
  abilityResultDay: 1,
});

const DECISION_GROUNDING_REFERENCE_FIELDS = Object.freeze({
  correctedSpeechRefs: Object.freeze({
    allowedEventTypes: Object.freeze(['public-speech']),
    purpose: '自分の過去発言を訂正するときだけ指定する公開発言番号',
  }),
  evidenceRefs: Object.freeze({
    allowedEventTypes: Object.freeze(['public-speech', 'vote-finalized', 'execution', 'dawn']),
    purpose: '現在の判断を支える公開イベント番号',
  }),
});

function normalizeExampleSequenceList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(Number)
    .filter((sequence) => Number.isInteger(sequence) && sequence > 0))]
    .sort((left, right) => left - right)
    .slice(-1);
}

export function normalizeResponseExampleReferences(value = null) {
  const source = value && typeof value === 'object' ? value : EMPTY_EXAMPLE_REFERENCES;
  return {
    answerToRefs: normalizeExampleSequenceList(source.answerToRefs),
    correctedSpeechRefs: normalizeExampleSequenceList(source.correctedSpeechRefs),
    decisionEvidenceRefs: normalizeExampleSequenceList(source.decisionEvidenceRefs),
    abilityEvidenceRefs: normalizeExampleSequenceList(source.abilityEvidenceRefs),
    truthfulAbilitySourceRefs: normalizeExampleSequenceList(source.truthfulAbilitySourceRefs),
    abilityResultDay: Math.max(1, Number(source.abilityResultDay ?? 1)),
  };
}

export function getResponseModeForTask(taskType) {
  const normalized = String(taskType ?? '').trim();
  const mapped = RESPONSE_MODE_BY_TASK_TYPE[normalized];
  if (mapped) return mapped;
  throw new RangeError(`未定義のAIタスク種別です: ${normalized || '(empty)'}`);
}

export function getResponseModeDefinition(mode) {
  const normalized = String(mode ?? '').trim();
  const definition = RESPONSE_MODE_DEFINITIONS[normalized];
  if (!definition) throw new RangeError(`未定義のAI応答モードです: ${normalized || '(empty)'}`);
  return definition;
}

export function getResponseTopLevelKeys(mode) {
  return [...getResponseModeDefinition(mode).allowedTopLevelKeys];
}

export function getRoleCompatibleResponseTopLevelKeys(mode, roleId) {
  return getResponseTopLevelKeys(mode)
    .filter((key) => key !== 'factionStrategy' || isFactionStrategyRole(roleId));
}

export function getFactionStrategyResponseFields(roleId, partnerDispositionPolicy = null) {
  return getFactionStrategyFields(roleId)
    .filter((field) => field !== 'partnerDisposition' || isWolfPartnerDispositionApplicable(partnerDispositionPolicy));
}

export function getAllResponseTopLevelKeys() {
  return [...new Set(Object.values(RESPONSE_MODE_DEFINITIONS)
    .flatMap((definition) => definition.allowedTopLevelKeys))];
}

export function getRequiredResponseTopLevelKeys(mode) {
  return [...getResponseModeDefinition(mode).requiredTopLevelKeys];
}

export function getDecisionChangeKeys(mode) {
  return [...getResponseModeDefinition(mode).decisionChangeKeys];
}

export function getAllDecisionChangeKeys() {
  return [...new Set(Object.values(RESPONSE_MODE_DEFINITIONS)
    .flatMap((definition) => definition.decisionChangeKeys))];
}

export function getDecisionGroundingReferenceFields() {
  return DECISION_GROUNDING_REFERENCE_FIELDS;
}

export function getDecisionGroundingKeys() {
  return Object.keys(DECISION_GROUNDING_REFERENCE_FIELDS);
}

export function getDecisionPatchKeys(mode) {
  return [
    ...getDecisionChangeKeys(mode),
    ...(mode === 'vote' ? [] : ['reason']),
    ...getDecisionGroundingKeys(),
  ];
}

export function getSharedStrategyFields() {
  return [...SHARED_STRATEGY_FIELDS];
}

export function buildSpeechInteractionExample() {
  return {
    questionTargets: ['質問する相手の正式表示名'],
  };
}

export function buildSpeechInteractionConditionalExamples() {
  return {
    questionOnly: { speechInteraction: { questionTargets: ['質問する相手の正式表示名'] } },
  };
}

export function getCoOperationRoleIds(claimRolePolicy) {
  return (claimRolePolicy?.coRoleIds ?? []).filter((roleId) => roleId !== 'none');
}

export function buildCoOperationConditionalExample(claimRolePolicy) {
  if (!getCoOperationRoleIds(claimRolePolicy).length) return null;
  return { action: 'declare', roleId: '許可された役職ID' };
}

export function buildAbilityClaimsConditionalExample(claimRolePolicy, exampleReferences = null) {
  const references = normalizeResponseExampleReferences(exampleReferences);
  const truthfulSource = references.truthfulAbilitySourceRefs.at(-1) ?? null;
  if (truthfulSource) {
    return [{
      intent: 'truthful',
      sourceRef: truthfulSource,
    }];
  }
  return buildDeceptionAbilityClaimsConditionalExample(claimRolePolicy, references);
}

export function buildDeceptionAbilityClaimsConditionalExample(claimRolePolicy, exampleReferences = null) {
  const references = normalizeResponseExampleReferences(exampleReferences);
  const roleIds = claimRolePolicy?.abilityClaimRoleIds ?? [];
  const roleId = roleIds.find((candidate) => candidate !== 'medium') ?? roleIds[0];
  if (!roleId) return null;
  const result = getPublicAbilityClaimDefinition(roleId)?.results?.[0] ?? 'unknown';
  const claim = {
    intent: 'deception',
    roleId,
    resultDay: references.abilityResultDay,
    target: '能力対象の正式表示名',
    result,
  };
  if (roleId !== 'medium') {
    claim.selectionBasis = 'no-public-information';
    claim.evidenceRefs = [];
    claim.selectionReasonAtTime = '能力対象を選んだ時点での具体的な理由';
  }
  return [claim];
}

export function buildResponseConditionalExamples({
  mode,
  claimRolePolicy = null,
  exampleReferences = null,
} = {}) {
  if (!['speech', 'speech-designated', 'speech-free', 'priority-answer', 'testament'].includes(mode)) return {};
  const examples = {};
  const coOperation = buildCoOperationConditionalExample(claimRolePolicy);
  if (coOperation) examples.coOperation = coOperation;
  const abilityClaims = buildAbilityClaimsConditionalExample(claimRolePolicy, exampleReferences);
  if (abilityClaims) examples.abilityClaims = abilityClaims;
  return examples;
}

export function buildDecisionPatchExample(mode, exampleReferences = null) {
  const references = normalizeResponseExampleReferences(exampleReferences);
  const values = {
    suspects: ['疑っている相手の正式表示名'],
    executionCandidates: ['処刑候補の正式表示名'],
    intendedVote: '現時点の投票予定先の正式表示名。解除する場合はnull',
    assessmentLevel: 'moderate',
    leaveAliveBenefit: '対象を残すことで自陣営が得る利益',
    misexecutionCost: 'その処刑が自陣営に不利だった場合の主要損失',
    selectionDifference: '最有力の別候補との今日の処刑価値の差',
    uncertainty: '現在の判断に残る不確実性',
    nextDiscriminatingInformation: '次に判断を分ける情報',
  };
  const patch = Object.fromEntries(getDecisionChangeKeys(mode).map((key) => [key, values[key]]));
  if (mode !== 'vote') {
    patch.reason = mode === 'mason'
      ? '共有者間で確認した現在の判断理由'
      : '現在の判断を支える具体的な公開根拠';
  }
  patch.correctedSpeechRefs = [];
  patch.evidenceRefs = [];
  return patch;
}

function strategyFieldExample(field, partnerDispositionPolicy) {
  const values = {
    publicWorld: '公開上成立させる盤面',
    dayWinPath: '昼の勝ち筋',
    partnerDisposition: partnerDispositionPolicy?.allowedValues?.[0] ?? 'independent',
    collapsePlan: '主張や騙りが崩れた場合の移行先',
    linkageRisk: '人狼候補との関係が露出する危険',
    fallbackRoute: '主張が成立しない場合の代替ルート',
    pressureGoal: '昼の議論で圧力を向ける目標',
    failureRisk: '現在想定している失敗要因',
    nextDayPlan: '翌日に向けた行動計画',
  };
  return values[field] ?? `${field}の現在方針`;
}

export function buildFactionStrategyExample(roleId, partnerDispositionPolicy = null) {
  if (!isFactionStrategyRole(roleId)) return null;
  return {
    mode: 'patch',
    changes: Object.fromEntries(getFactionStrategyResponseFields(roleId, partnerDispositionPolicy)
      .map((field) => [field, strategyFieldExample(field, partnerDispositionPolicy)])),
  };
}

export function buildSharedStrategyExample(wolfConversationPurpose = null) {
  const fields = SHARED_STRATEGY_FIELDS.filter((field) => !(field === 'attackPlan' && wolfConversationPurpose === 'opening-strategy'));
  const values = {
    claimPlan: '騙り方針',
    blackReceivedPlan: '黒結果を受けた場合の方針',
    partnerExecutionPlan: '仲間が処刑圏に入った場合の方針',
    collapsePlan: '騙りや主張が崩れた場合の方針',
    discussionPlan: '昼会話の方針',
    attackPlan: '襲撃方針',
  };
  return {
    mode: 'patch',
    changes: Object.fromEntries(fields.map((field) => [field, values[field]])),
  };
}

export function buildAttackAssessmentExample(attackAlternativeAvailable = true) {
  const example = {
    hunterAliveChance: 'medium',
    guardRisk: 'medium',
  };
  if (attackAlternativeAvailable) {
    example.otherTarget = '最有力別候補の正式表示名';
    example.otherGuardRisk = 'low';
  }
  return example;
}

export function buildResponseContractExample({
  mode,
  roleId,
  partnerDispositionPolicy = null,
  claimRolePolicy = null,
  freezeEstimateLimit = null,
  wolfConversationPurpose = null,
  attackAlternativeAvailable = true,
  exampleReferences = null,
} = {}) {
  const references = normalizeResponseExampleReferences(exampleReferences);
  if (['speech', 'speech-designated', 'speech-free'].includes(mode)) {
    const example = {
      publicSpeech: '公開履歴へそのまま保存するキャラクター本人の発言',
      speechInteraction: buildSpeechInteractionExample(references),
      decisionPatch: buildDecisionPatchExample('speech', references),
    };
    const factionStrategy = buildFactionStrategyExample(roleId, partnerDispositionPolicy);
    if (factionStrategy) example.factionStrategy = factionStrategy;
    example.heartVoice = HEART_VOICE_EXAMPLE;
    example.memoAdd = MEMO_ADD_EXAMPLE;
    if (mode === 'speech-designated') example.nextSpeakerPreference = '次に早めて発言してほしい未発言者の正式表示名。指名しない場合は空文字';
    if (mode === 'speech-free') example.discussionPreference = 'EARLY';
    return example;
  }
  if (mode === 'discussion-opening-preference') return { openingPreference: 'EARLY' };
  if (mode === 'priority-answer') {
    const example = {
      publicSpeech: '指定された質問へ直接答えるキャラクター本人の公開回答',
      decisionPatch: buildDecisionPatchExample('priority-answer', references),
    };
    const factionStrategy = buildFactionStrategyExample(roleId, partnerDispositionPolicy);
    if (factionStrategy) example.factionStrategy = factionStrategy;
    example.heartVoice = HEART_VOICE_EXAMPLE;
    example.memoAdd = MEMO_ADD_EXAMPLE;
    return example;
  }
  if (mode === 'testament') {
    return {
      publicSpeech: '処刑直前に一度だけ公開するキャラクター本人の遺言',
      memoAdd: MEMO_ADD_EXAMPLE,
    };
  }
  if (mode === 'vote') {
    const example = {
      actionAnswer: '投票先の正式表示名',
      rationale: 'この相手へ投票する具体的な理由',
      decisionPatch: buildDecisionPatchExample('vote', references),
    };
    const factionStrategy = buildFactionStrategyExample(roleId, partnerDispositionPolicy);
    if (factionStrategy) example.factionStrategy = factionStrategy;
    example.memoAdd = MEMO_ADD_EXAMPLE;
    return example;
  }
  if (mode === 'wolf') {
    return {
      wolfMessage: '人狼仲間へ送る秘密会話',
      sharedStrategy: buildSharedStrategyExample(wolfConversationPurpose),
      memoAdd: MEMO_ADD_EXAMPLE,
    };
  }
  if (mode === 'mason') {
    return {
      masonMessage: '共有者相方へ送る秘密会話',
      decisionPatch: buildDecisionPatchExample('mason', references),
      memoAdd: MEMO_ADD_EXAMPLE,
    };
  }
  if (mode === 'graveyard') {
    return {
      graveyardMessage: '墓場の死亡者へ送る秘密会話',
      memoAdd: MEMO_ADD_EXAMPLE,
    };
  }
  if (mode === 'attack-action') {
    return {
      actionAnswer: '襲撃対象の正式表示名',
      attackAssessment: buildAttackAssessmentExample(attackAlternativeAvailable),
      rationale: '結果判明前の時点でこの対象を選ぶ具体的理由',
    };
  }
  if (mode === 'freeze-action') {
    const min = freezeEstimateLimit?.min ?? 1;
    const max = freezeEstimateLimit?.max ?? 3;
    return {
      estimate: {
        wolfCandidateIds: [`人狼候補のプレイヤーIDを${min}～${max}件`],
        predictedAttackTargetIds: [`予想襲撃先のプレイヤーIDを${min}～${max}件`],
      },
      actionAnswer: '凍結対象の正式表示名',
      rationale: '人狼推定、襲撃予想、凍結対象選択を結び付ける具体的理由',
    };
  }
  if (mode === 'night-action') {
    return {
      actionAnswer: '対象の正式表示名',
      rationale: '結果判明前の時点でこの対象を選んだ具体的理由',
    };
  }
  if (mode === 'public-only') {
    return { publicSpeech: '公開表示へそのまま掲載する1～2文の短い感想' };
  }
  if (mode === 'memo') return { fullMemo: '現在も必要な自由内部メモの全文' };
  if (mode === 'none') return {};
  throw new RangeError(`未定義のAI応答モードです: ${String(mode ?? '').trim() || '(empty)'}`);
}
