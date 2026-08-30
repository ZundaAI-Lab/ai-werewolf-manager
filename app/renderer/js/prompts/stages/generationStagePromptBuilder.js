/**
 * 責務: 深度2の判断・キャラ発言化、深度3/4の客観分析、深度4の批判的検証、深度3/4の最終回答から、責務を分離した最小プロンプトを生成する。
 * 変更ルール:
 * - 深度2の判断は直接生成と同じ人物プロフィール・推理傾向・議論行動・非公開参考視点を判断材料に使うが、一人称・口調・語尾・口調例・呼称は使わない。深度3/4の客観分析と深度4の批判的検証は人物設定を使わず、役職・陣営・本人可視情報とゲーム規則だけを扱う。
 * - 処刑判断はgenerationGuidance.executionValuePolicyを正本として投票と最終巡の通常発言・優先回答へ同じ文面で適用し、voteのdecisionPatch具体化ガイダンスはvoteResponseGuidancePolicy.jsを正本として深度1/2と同じ優先項目を使用する。
 * - 完成回答を生成する判断・最終回答では、検証上任意の項目を原則出力と条件付き出力へ分離し、原則出力の生成機会を削らず、欠落だけをエラー条件へ昇格させない。能力結果を公開する回答ではabilityClaimsを構造化正本として維持し、同じ役職・対象・結果をpublicSpeechにも必ず明示させる。
 * - 判断・客観分析・批判的検証へ生公開イベントを渡さずgenerationStageSourceの公開履歴射影を使用し、空値を除去したminified JSONだけを掲載する。
 * - 各工程の中間区画は判断・表現・意味ロックだけを説明し、AI向け必須出力・原則出力、主JSON例、返却キー、文字数制約は各工程末尾の最終確認へ一度だけ集約する。heartVoiceは文数を指定せずmaxHeartVoiceLengthの文字数上限だけを提示する。
 * - 回答検証上のrequiredTopLevelKeysは原則出力項目を省く根拠にせず、recommendedTopLevelKeysと主JSON例へ検証任意項目の生成機会を維持する。
 * - 公開発言量の人間向けラベルや長さ区分は中間工程へ出さず、会話開始・序盤反応に意味がある追加指示だけroleTaskData.promptGuidanceから引き継ぐ。通常昼議論第1巡の初期役職構成由来ガイドはpublicState内の解釈補助として直接生成と同じ条件で引き継ぐ。墓場会話では生存中のdecisionと昼推理用characterReasoningを草案へ再投入せず、memoAddをプロンプト契約から外して秘密共有・答え合わせ・感想の会話目的を維持する。
 * - 内部UUIDは雪女の明示ID契約以外へ出さず表示名またはイベント番号へ変換する。
 * - renderではsourceTextを唯一の意味正本とし、話者・口調・呼称・意味ロックだけを渡して他人の公開発言本文や候補全体を渡さない。
 * - 批判的検証は客観分析の事実誤認・対象取り違え・推論飛躍・陣営目標との不整合・見落としを自由記述で検査し、ゲーム上の確定候補は生成しない。Analyze/Critiqueの推奨出力量はgenerationIntermediateTextPolicyを正本とし、Finalizeは存在する参照区画だけを提示する。キャラ発言化は確定候補の意味を変更しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { publicAbilityResultLabel } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { resolvePublicSpeechPromptMaxChars } from '../../domain/policies/publicSpeechLengthPolicy.js';
import { formatAbilityClaimTiming } from '../../domain/policies/abilityClaimTimingPolicy.js';
import { renderPriorityAnswerSemanticRules, renderPublicSpeechSemanticRules, renderVoteReevaluationRule, renderWolfAttackSemanticRules } from '../policies/taskInstructionPolicy.js';
import { renderVoteDecisionPatchGuidance } from '../policies/voteResponseGuidancePolicy.js';
import { renderInternalReasoningDirective } from '../templates/characterReasoningDirectiveTemplates.js';
import { getDecisionPatchKeys } from '../response/responseContract.js';
import { stringifyPromptData } from '../serialization/promptDataSerializer.js';
import { generationIntermediateTextPolicy } from './generationIntermediateTextPolicy.js';

function nonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).length > 0;
}

function json(value, { compact = false } = {}) {
  // generation工程でも共通serializerを使い、game-data境界文字列を値としてのみ保持する。
  // 中間生成用データは転送量削減のためminifyする。
  return stringifyPromptData(value, { pretty: !compact });
}

const INTERNAL_UUID_PATTERN = /^(?:[a-z][a-z0-9-]*-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVENT_ID_KEY_PATTERN = /eventIds?$/iu;

function compactStageValue(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const rows = value.map(compactStageValue).filter((item) => item !== undefined);
    return rows.length ? rows : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, child]) => [key, compactStageValue(child)])
      .filter(([, child]) => child !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (typeof value === 'string' && !value.length) return undefined;
  return value;
}


function roleLabel(roleId) {
  const id = String(roleId ?? '');
  return ROLE_DEFINITIONS[id]?.name ?? id;
}

function playerNameMap(source) {
  const rows = [
    ...(source?.publicState?.alivePlayers ?? []),
    ...(source?.publicState?.deadPlayers ?? []),
  ];
  const map = new Map(rows.map((row) => [String(row?.id ?? row?.playerId ?? ''), String(row?.name ?? row?.playerName ?? row?.id ?? '')]));
  const playerId = String(source?.currentMoment?.playerId ?? '');
  const playerName = String(source?.currentMoment?.playerName ?? '');
  if (playerId && playerName) map.set(playerId, playerName);
  return map;
}

function displayPlayerName(source, playerId) {
  const id = String(playerId ?? '');
  return playerNameMap(source).get(id) ?? id;
}

function promptMoment(source) {
  return {
    day: Number(source?.currentMoment?.day ?? 0),
    phase: String(source?.currentMoment?.phase ?? ''),
    taskType: String(source?.currentMoment?.taskType ?? ''),
    playerName: String(source?.currentMoment?.playerName ?? ''),
  };
}

function eventReferenceMap(source) {
  const map = new Map();
  const events = [
    ...(source?.histories?.recentPublicTimeline ?? []),
    ...(source?.publicState?.recentOutcomeSummary ?? []),
  ];
  events.forEach((event) => {
    const sequence = Number(event?.sequence ?? 0);
    if (!Number.isInteger(sequence) || sequence <= 0) return;
    const ref = `#${sequence}`;
    for (const id of [event?.id, event?.payload?.correctsEventId, ...(event?.correctionLineageIds ?? [])]) {
      if (id) map.set(String(id), ref);
    }
  });
  return map;
}

const PLAYER_ID_KEY_NAMES = Object.freeze({
  playerId: 'player',
  actorId: 'actor',
  targetId: 'target',
  speakerId: 'speaker',
  ownerId: 'owner',
  askerId: 'asker',
});

function sanitizePromptValue(source, value) {
  const names = playerNameMap(source);
  const eventRefs = eventReferenceMap(source);
  if (typeof value === 'string') {
    if (names.has(value)) return names.get(value);
    if (eventRefs.has(value)) return eventRefs.get(value);
    if (INTERNAL_UUID_PATTERN.test(value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePromptValue(source, item)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'opportunityContext') continue;
    if (EVENT_ID_KEY_PATTERN.test(key)) continue;
    if ([
      'id', 'correctionLineageIds', 'slotId', 'sessionId', 'messageId', 'turnId',
    ].includes(key)) continue;

    let outputKey = key;
    if (names.has(key)) outputKey = names.get(key);
    else if (eventRefs.has(key)) outputKey = eventRefs.get(key);
    else if (INTERNAL_UUID_PATTERN.test(key)) continue;

    if (Object.hasOwn(PLAYER_ID_KEY_NAMES, key)) {
      const sanitized = sanitizePromptValue(source, child);
      if (sanitized !== undefined) result[PLAYER_ID_KEY_NAMES[key]] = sanitized;
      continue;
    }
    if (/playerId$/iu.test(key)) {
      const prefix = key.slice(0, -8);
      const sanitized = sanitizePromptValue(source, child);
      if (sanitized !== undefined) result[`${prefix}PlayerName`] = sanitized;
      continue;
    }
    if (/playerIds$/iu.test(key) && Array.isArray(child)) {
      const prefix = key.slice(0, -9);
      const sanitized = child.map((item) => sanitizePromptValue(source, item)).filter((item) => item !== undefined);
      if (sanitized.length) result[`${prefix}PlayerNames`] = sanitized;
      continue;
    }
    if (key.endsWith('Ids') && Array.isArray(child) && child.every((item) => names.has(String(item)))) {
      result[`${key.slice(0, -3)}Names`] = child.map((item) => names.get(String(item)));
      continue;
    }
    const sanitized = sanitizePromptValue(source, child);
    if (sanitized !== undefined) result[outputKey] = sanitized;
  }
  return compactStageValue(result) ?? {};
}


function stagePublicState(source) {
  return {
    alivePlayers: (source?.publicState?.alivePlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')),
    deadPlayers: (source?.publicState?.deadPlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')),
    activeClaims: formatActiveClaims(source),
    publicAbilityClaims: formatPublishedAbilityClaims(source),
    publicLocks: sanitizePromptValue(source, source?.publicState?.publicLocks ?? {}),
    currentVoteState: sanitizePromptValue(source, source?.publicState?.currentVoteState ?? null),
    recentOutcomeSummary: sanitizePromptValue(source, source?.publicState?.recentOutcomeSummary ?? []),
    roleCompositionSituationGuide: sanitizePromptValue(source, source?.publicState?.roleCompositionSituationGuide ?? null),
  };
}

function stagePrivateState(source) {
  const teammates = source?.privateState?.teammates ?? {};
  return {
    ownRole: sanitizePromptValue(source, source?.privateState?.ownRole ?? {}),
    ownAbilityResults: sanitizePromptValue(source, source?.privateState?.ownAbilityResults ?? []),
    ownFactionStrategy: sanitizePromptValue(source, source?.privateState?.ownFactionStrategy ?? null),
    teammates: {
      knownWolves: (teammates.knownWolfIds ?? []).map((id) => displayPlayerName(source, id)),
      knownMadmen: (teammates.knownMadmanIds ?? []).map((id) => displayPlayerName(source, id)),
      knownMasons: (teammates.knownMasonIds ?? []).map((id) => displayPlayerName(source, id)),
    },
    privateLocks: sanitizePromptValue(source, source?.privateState?.privateLocks ?? {}),
  };
}

function stageRoleTaskData(source, taskType) {
  const roleTaskData = source?.roleTaskData ?? {};
  const result = sanitizePromptValue(source, roleTaskData);
  delete result.validTargetNames;
  delete result.validTargetIds;
  if (taskType === 'graveyard-conversation') delete result.decision;
  if (taskType === 'freeze') {
    result.validTargetPlayers = (roleTaskData.validTargetIds ?? []).map((id) => ({
      id: String(id),
      name: displayPlayerName(source, id),
    }));
  } else {
    result.validTargets = (roleTaskData.validTargetIds ?? []).map((id) => displayPlayerName(source, id));
  }
  return result;
}

function compactCallNames(source) {
  return (source?.characterExpression?.callNames ?? []).map((row) => ({
    targetName: String(row?.targetName ?? ''),
    preferred: String(row?.preferred ?? row?.targetName ?? ''),
  })).filter((row) => row.targetName && row.preferred);
}

function formatActiveClaims(source) {
  return (source?.publicState?.activeClaims ?? []).map((claim) => {
    const actor = displayPlayerName(source, claim?.actorId);
    return `${actor}: ${roleLabel(claim?.roleId)}`;
  });
}

function formatPublishedAbilityClaims(source) {
  return (source?.publicState?.publicAbilityClaims ?? []).map((claim) => {
    const actor = displayPlayerName(source, claim?.actorId);
    const target = displayPlayerName(source, claim?.targetId);
    const role = roleLabel(claim?.claimedRoleId ?? claim?.roleId);
    const timing = formatAbilityClaimTiming(claim);
    return `${timing} ${actor}（${role}）→ ${target}: ${publicAbilityResultLabel(claim?.result, claim?.claimedRoleId ?? claim?.roleId)}`;
  });
}

function publicSpeechGuidance(source) {
  return String(source?.roleTaskData?.promptGuidance?.publicSpeechGuidance ?? '').trim();
}

function publicSpeechOutputConstraint(source, taskType = 'speech') {
  const policy = source?.promptPolicies?.publicSpeechLengthPolicy ?? {};
  const targetChars = Number(policy.targetChars ?? 0);
  if (!Number.isFinite(targetChars) || targetChars <= 0) return '';
  const absoluteMaxChars = Number(source?.promptPolicies?.outputLimits?.maxPublicSpeechLength ?? 450);
  const promptMaxChars = resolvePublicSpeechPromptMaxChars(targetChars, { absoluteMaxChars });
  const claimTargetChars = Number(policy.claimOverride?.targetChars ?? 0);
  const claimOverride = Number.isFinite(claimTargetChars) && claimTargetChars > 0 && claimTargetChars !== targetChars
    ? `（CO・能力履歴公開時は目安約${claimTargetChars}文字、上限約${resolvePublicSpeechPromptMaxChars(claimTargetChars, { absoluteMaxChars })}文字）`
    : '';
  const label = taskType === 'priority-answer' ? '公開回答' : '公開発言';
  return `${label}: 目安は約${targetChars}文字、上限は約${promptMaxChars}文字${claimOverride}`;
}

function stageOutputConstraints(source, { taskType = '', fields = [] } = {}) {
  const selected = new Set(fields);
  const rows = [];
  if (selected.has('publicSpeech')) {
    const speechConstraint = publicSpeechOutputConstraint(source, taskType);
    if (speechConstraint) rows.push(speechConstraint);
  }
  if (selected.has('heartVoice')) {
    const maxHeartVoiceLength = Number(source?.promptPolicies?.outputLimits?.maxHeartVoiceLength ?? 120);
    rows.push(`心の声: ${maxHeartVoiceLength}文字以内`);
  }
  return rows.join('、');
}

function candidateContractView(contract, recommendedKeys, conditionalKeys) {
  const conditionalExamples = structuredClone(contract?.conditionalExamples ?? {});
  if (conditionalKeys.includes('speechInteraction') && Object.hasOwn(contract?.completeExample ?? {}, 'speechInteraction')) {
    conditionalExamples.speechInteraction = structuredClone(contract.completeExample.speechInteraction);
  }
  return {
    mode: String(contract?.mode ?? ''),
    allowedTopLevelKeys: [...(contract?.allowedTopLevelKeys ?? [])],
    recommendedTopLevelKeys: [...recommendedKeys],
    conditionalTopLevelKeys: [...conditionalKeys],
    fieldDescriptions: structuredClone(contract?.fieldDescriptions ?? {}),
    conditionalExamples,
  };
}

function candidateExample(contract, taskType, recommendedKeys, conditionalKeys) {
  const blocked = new Set(conditionalKeys);
  const complete = contract?.completeExample ?? {};
  const keys = [];
  for (const key of contract?.requiredTopLevelKeys ?? []) {
    if (Object.hasOwn(complete, key) && !keys.includes(key)) keys.push(key);
  }
  for (const key of recommendedKeys) {
    if (Object.hasOwn(complete, key) && !blocked.has(key) && !keys.includes(key)) keys.push(key);
  }
  return Object.fromEntries(keys.map((key) => [key, structuredClone(complete[key])]));
}

function candidateFinalConfirmation(source, taskType, contract, recommendedKeys, conditionalKeys) {
  const requiredKeys = [...(contract?.requiredTopLevelKeys ?? [])];
  const example = candidateExample(contract, taskType, recommendedKeys, conditionalKeys);
  const rules = [`今回の必須出力: ${requiredKeys.join(' / ') || 'なし'}。`];
  const constraints = stageOutputConstraints(source, {
    taskType,
    fields: Object.keys(example),
  });
  return `## 最終確認

単一JSONオブジェクトだけを返してください。

${rules.join('\n')}

項目: ${Object.keys(example).join(' / ') || 'なし'}。

### 今回のJSON例

${JSON.stringify(example)}${constraints ? `

出力制約: ${constraints}` : ''}`;
}

function characterSurface(source) {
  const value = source?.characterExpression ?? {};
  return {
    profile: value.profile,
    firstPerson: value.firstPerson,
    genericSecondPerson: value.genericSecondPerson,
    speakingStyle: value.speakingStyle,
    defaultEndings: value.defaultEndings,
    avoidedExpressions: value.avoidedExpressions,
    speechExamples: String(value.speechExamples ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
  };
}

function actionSummary(source, candidateObject) {
  const summary = {
    taskType: String(source?.currentMoment?.taskType ?? ''),
    validTargets: (source?.roleTaskData?.validTargetIds ?? []).map((id) => displayPlayerName(source, id)),
  };
  for (const key of ['actionAnswer', 'attackAssessment', 'decisionPatch', 'speechInteraction', 'coOperation', 'abilityClaims', 'sharedStrategy', 'estimate']) {
    if (Object.hasOwn(candidateObject ?? {}, key)) summary[key] = sanitizePromptValue(source, candidateObject[key]);
  }
  return summary;
}


function contextForPurpose(purpose, source, candidateObject) {
  const commonMoment = promptMoment(source);
  if (purpose === 'public-dialogue') {
    const context = {
      currentMoment: commonMoment,
      characterSurface: characterSurface(source),
      callNames: compactCallNames(source),
    };
    const guidance = publicSpeechGuidance(source);
    if (guidance) context.speechGuidance = guidance;
    return context;
  }
  if (purpose === 'result-comment') {
    return {
      currentMoment: commonMoment,
      characterSurface: characterSurface(source),
      callNames: compactCallNames(source),
      resultSummary: sanitizePromptValue(source, source?.roleTaskData?.taskSpecific?.resultImpression ?? null),
    };
  }
  if (purpose === 'private-dialogue') {
    const taskType = source?.currentMoment?.taskType;
    return {
      currentMoment: commonMoment,
      characterSurface: characterSurface(source),
      participants: taskType === 'wolf-conversation'
        ? { knownWolves: (source?.privateState?.teammates?.knownWolfIds ?? []).map((id) => displayPlayerName(source, id)) }
        : taskType === 'graveyard-conversation'
          ? { deadPlayers: (source?.publicState?.deadPlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')) }
          : { knownMasons: (source?.privateState?.teammates?.knownMasonIds ?? []).map((id) => displayPlayerName(source, id)) },
      privateConversation: taskType === 'wolf-conversation'
        ? sanitizePromptValue(source, source?.histories?.recentWolfConversation ?? [])
        : taskType === 'graveyard-conversation'
          ? sanitizePromptValue(source, {
            current: source?.histories?.recentGraveyardConversation ?? [],
            past: source?.histories?.pastGraveyardConversations ?? [],
          })
          : sanitizePromptValue(source, source?.histories?.recentMasonConversation ?? []),
      publicState: {
        alivePlayers: (source?.publicState?.alivePlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')),
        deadPlayers: (source?.publicState?.deadPlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')),
      },
      conversationPurpose: source?.roleTaskData?.taskSpecific?.wolfConversationPurpose ?? null,
    };
  }
  if (purpose === 'inner-voice') {
    return {
      currentMoment: commonMoment,
      characterSurface: characterSurface(source),
      actionSummary: actionSummary(source, candidateObject),
    };
  }
  if (purpose === 'audit-rationale') {
    return {
      currentMoment: commonMoment,
      actionSummary: actionSummary(source, candidateObject),
      publicEvidence: compactStageValue(sanitizePromptValue(source, source?.histories?.publicHistoryProjection ?? {})) ?? {},
      maxLength: source?.currentMoment?.taskType === 'freeze' ? 360 : 240,
      resultKnown: false,
    };
  }
  if (purpose === 'internal-memo') {
    return {
      currentMoment: commonMoment,
      existingInternalMemo: structuredClone(source?.histories?.existingInternalMemo ?? {}),
      maxLength: 3000,
      rules: ['確定事項と仮説を区別する', 'システム管理記憶を書き写さない'],
    };
  }
  throw new RangeError(`未対応の文章用途です: ${purpose}`);
}

function selectObjectKeys(source, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source ?? {}, key)).map((key) => [key, structuredClone(source[key])]));
}

function stageHistories(source, taskType) {
  const histories = source?.histories ?? {};
  if (taskType === 'wolf-conversation') {
    return compactStageValue(sanitizePromptValue(source, selectObjectKeys(histories, ['recentWolfConversation', 'existingInternalMemo']))) ?? {};
  }
  if (taskType === 'mason-conversation') {
    return compactStageValue(sanitizePromptValue(source, selectObjectKeys(histories, ['recentMasonConversation', 'existingInternalMemo']))) ?? {};
  }
  if (taskType === 'graveyard-conversation') {
    return compactStageValue(sanitizePromptValue(source, selectObjectKeys(histories, ['recentGraveyardConversation', 'pastGraveyardConversations', 'existingInternalMemo']))) ?? {};
  }
  if (taskType === 'memo-consolidate') {
    return compactStageValue(sanitizePromptValue(source, selectObjectKeys(histories, ['existingInternalMemo']))) ?? {};
  }
  if (taskType === 'result-impression') return {};
  return compactStageValue(sanitizePromptValue(source, selectObjectKeys(histories, [
    'publicHistoryMode',
    'publicHistoryProjection',
    'ownPublicHistoryProjection',
    'existingInternalMemo',
    'privateTeamStrategy',
  ]))) ?? {};
}


function stageTaskData(taskArtifact, policy) {
  const source = taskArtifact.stageSource;
  const sections = new Set(policy.contextSections ?? []);
  const result = {};
  if (sections.has('currentMoment')) result.currentMoment = promptMoment(source);
  if (sections.has('publicState')) result.publicState = stagePublicState(source);
  if (sections.has('recentOutcomeSummary') && !sections.has('publicState')) result.recentOutcomeSummary = sanitizePromptValue(source, source.publicState?.recentOutcomeSummary ?? []);
  if (sections.has('resultSummary')) result.resultSummary = sanitizePromptValue(source, source.roleTaskData?.taskSpecific?.resultImpression ?? null);
  if (sections.has('privateState')) result.privateState = stagePrivateState(source);
  if (sections.has('roleTaskData')) result.roleTaskData = stageRoleTaskData(source, taskArtifact.taskType);
  if (sections.has('histories') || sections.has('recentWolfConversation') || sections.has('recentMasonConversation') || sections.has('recentGraveyardConversation') || sections.has('pastGraveyardConversations') || sections.has('existingInternalMemo')) {
    result.histories = stageHistories(source, taskArtifact.taskType);
  }
  Object.keys(result).forEach((key) => { if (!nonEmpty(result[key])) delete result[key]; });
  return compactStageValue(result) ?? {};
}

function publicDialogueLocks(source, candidateObject) {
  return {
    speakerIdentity: {
      playerName: String(source?.currentMoment?.playerName ?? ''),
    },
    publicAct: {
      interaction: Object.hasOwn(candidateObject ?? {}, 'speechInteraction')
        ? sanitizePromptValue(source, candidateObject.speechInteraction)
        : { questionTargets: [], answerToRefs: [] },
      claimOperation: Object.hasOwn(candidateObject ?? {}, 'coOperation')
        ? sanitizePromptValue(source, candidateObject.coOperation)
        : null,
      abilityClaims: Array.isArray(candidateObject?.abilityClaims)
        ? sanitizePromptValue(source, candidateObject.abilityClaims)
        : [],
    },
    sourcePolicy: {
      sourceTextIsCanonical: true,
      allowedChange: 'style-only',
      mayChangeSpeaker: false,
      mayAddClaim: false,
      mayAddAbilityResult: false,
      mayAddTarget: false,
      mayReverseConclusion: false,
    },
  };
}

function locksForField(taskArtifact, candidateObject, policy, fieldName) {
  const purpose = policy.fieldPurposes[fieldName];
  const locks = {};
  if (purpose === 'public-dialogue') {
    return publicDialogueLocks(taskArtifact.stageSource, candidateObject);
  }
  if (purpose === 'private-dialogue') {
    for (const key of policy.candidateLockFields) {
      if (Object.hasOwn(candidateObject, key)) locks[key] = structuredClone(candidateObject[key]);
    }
  } else if (purpose === 'audit-rationale' || purpose === 'inner-voice') {
    const summary = actionSummary(taskArtifact.stageSource, candidateObject);
    Object.assign(locks, summary);
  }
  return locks;
}

export function buildStageFieldJobs({ taskArtifact, candidateObject, policy }) {
  if (!policy?.applicable || !(policy.targetTextFields ?? []).length) throw new RangeError('対象文章フィールドがない工程プロンプトは生成できません。');
  return policy.targetTextFields.map((fieldName) => {
    const purpose = policy.fieldPurposes[fieldName];
    if (!purpose) throw new RangeError(`文章用途が登録されていません: ${fieldName}`);
    return {
      field: fieldName,
      purpose,
      sourceText: String(candidateObject[fieldName] ?? ''),
      semanticLocks: locksForField(taskArtifact, candidateObject, policy, fieldName),
      context: contextForPurpose(purpose, taskArtifact.stageSource, candidateObject),
    };
  });
}

function exactTextPatchExample(targetTextFields) {
  return {
    textPatch: Object.fromEntries(targetTextFields.map((fieldName) => [fieldName, `${fieldName}の完成文章`])),
  };
}

function purposeInstructions(fieldJobs, stageId) {
  const purposes = new Set(fieldJobs.map((job) => job.purpose));
  const lines = [];
  if (purposes.has('public-dialogue')) {
    lines.push('- public-dialogueはsourceTextと同じ話者・対象・結論・時系列を維持し、一人称、呼称、語彙、語順、文の分割・統合、接続表現、相槌、語尾などを自然に調整してください。');
    lines.push('- sourceTextにない新しい根拠、推理、質問、投票意向、CO、能力結果を追加せず、内容を削除または反転しないでください。');
    lines.push('- 単に特徴的な語尾を付け足すだけでなく、characterSurfaceを参考に文章全体を自然な話し方へ整えてください。');
  }
  if (purposes.has('private-dialogue')) lines.push('- private-dialogueは指定参加者だけの自然な秘密会話にし、公開説明へ変えないでください。');
  if (purposes.has('inner-voice')) lines.push('- inner-voiceは公開発言調へ変えず、その局面固有の短い内心として整えてください。');
  if (purposes.has('audit-rationale')) lines.push('- audit-rationaleは確定対象と評価に一致する結果判明前の監査理由として、具体的かつ簡潔にしてください。キャラクター語尾を演出しないでください。');
  if (purposes.has('internal-memo')) lines.push('- internal-memoは会話文にせず、重複を整理し、確定事項と仮説を区別して上限内に収めてください。');
  if (purposes.has('result-comment')) lines.push('- result-commentはresultSummaryと一致する自然で短い感想にしてください。ゲーム経過を読み上げず、knowledgeTimingがafter-exitの区画を生存中から知っていたように書かず、推理や投票判断を再実行しないでください。callNamesがある相手は指定呼称を使用してください。');
  return lines.join('\n');
}

function promptContractForDraft(contract, taskType) {
  const result = structuredClone(contract ?? {});
  if (taskType !== 'graveyard-conversation') return result;
  // 墓場ではmemoAddを回答検証契約から削除せず、LLMへ見せる草案契約だけから外す。
  result.allowedTopLevelKeys = (result.allowedTopLevelKeys ?? []).filter((key) => key !== 'memoAdd');
  result.optionalTopLevelKeys = (result.optionalTopLevelKeys ?? []).filter((key) => key !== 'memoAdd');
  if (result.fieldDescriptions) delete result.fieldDescriptions.memoAdd;
  if (result.completeExample) delete result.completeExample.memoAdd;
  return result;
}

function responseContractPromptParts(taskArtifact, policy) {
  if (!policy?.applicable) throw new RangeError('回答生成ポリシーが適用不能です。');
  const source = taskArtifact.stageSource;
  const taskData = stageTaskData(taskArtifact, policy);
  const contract = promptContractForDraft(source.responseContract ?? {}, taskArtifact.taskType);
  const allowedKeys = new Set(contract.allowedTopLevelKeys ?? []);
  const conditionalKeys = [...new Set([
    ...Object.keys(contract.conditionalExamples ?? {}),
    ...(allowedKeys.has('speechInteraction') ? ['speechInteraction'] : []),
  ])];
  const recommendedKeys = (contract.optionalTopLevelKeys ?? [])
    .filter((key) => !conditionalKeys.includes(key))
    .filter((key) => !(isNormalSpeechTask(taskArtifact.taskType) && key === 'publicSpeech'));
  const contractView = candidateContractView(contract, recommendedKeys, conditionalKeys);
  const recommendedRule = recommendedKeys.length
    ? `\n- response-contract.recommendedTopLevelKeysの ${recommendedKeys.join(' / ')} は回答検証上は任意ですが、現在の入力から意味のある内容を生成できる限り原則出力してください。情報不足または該当なしで適切な内容を生成できない場合に限り省略でき、欠落だけでエラーにはなりません。`
    : '';
  const conditionalRule = conditionalKeys.length
    ? `\n- response-contract.conditionalTopLevelKeysの ${conditionalKeys.join(' / ')} は条件付き出力です。今回実際に質問・回答・CO・能力結果公開を行う場合だけ親項目名ごと追加し、条件を満たさない内容は創作せず省略してください。`
    : '';
  const heartVoiceRule = allowedKeys.has('heartVoice')
    ? '\n- heartVoiceは原則出力します。公開本文へ出していない局面固有の本音・迷い・警戒を記入し、現在の入力から別内容を適切に生成できない場合だけ省略してください。'
    : '';
  const abilityClaimRule = allowedKeys.has('abilityClaims')
    ? '\n- abilityClaimsを出力して能力結果を公開する場合は、同じ公開主張の役職・対象・結果をpublicSpeechにも必ず明示してください。abilityClaimsだけに能力結果を置いてpublicSpeechから省略してはいけません。本人選択能力のselectionBasis・evidenceRefs・selectionReasonAtTimeは選択時点の根拠として記録し、後発情報で変更しないでください。'
    : '';
  const rationaleRule = allowedKeys.has('rationale')
    ? `\n- rationaleは結果判明前の具体的な選択理由を${taskArtifact.taskType === 'freeze' ? '1～3文' : '1～2文'}で簡潔に記録してください。`
    : '';
  const privateTeamStrategyRule = (isNormalSpeechTask(taskArtifact.taskType) || taskArtifact.taskType === 'priority-answer')
    && nonEmpty(taskData?.histories?.privateTeamStrategy)
    ? '\n- histories.privateTeamStrategyは本人限定の判断材料です。文面をpublicSpeechへ引用・転用せず、公開発言は公開情報だけでも成立する内容にしてください。'
    : '';
  const ownFactionStrategyRule = (isNormalSpeechTask(taskArtifact.taskType) || taskArtifact.taskType === 'priority-answer')
    && nonEmpty(taskData?.privateState?.ownFactionStrategy)
    ? '\n- privateState.ownFactionStrategyは本人限定の現在戦術です。判断材料として使用し、戦術内部の文面や非公開意図をpublicSpeechへそのまま露出しないでください。'
    : '';
  const executionValuePolicy = String(source?.roleTaskData?.promptGuidance?.executionValuePolicy ?? '').trim();
  const executionFactionPolicy = String(source?.roleTaskData?.promptGuidance?.executionFactionPolicy ?? '').trim();
  const isFirstDay = Number(source?.currentMoment?.day ?? 0) === 1;
  const firstDaySparseEvidence = isFirstDay
    && (source?.publicState?.publicAbilityClaims ?? []).filter((claim) => claim.status !== 'voided').length <= 1;
  const speechRules = isNormalSpeechTask(taskArtifact.taskType)
    ? `
${renderPublicSpeechSemanticRules({ firstDaySparseEvidence })}
${executionValuePolicy}
${executionFactionPolicy}
- roleTaskData.promptGuidance.publicSpeechGuidanceがある場合は、その追加指示を適用してください。
- CO・能力履歴公開時はpublicSpeechで役職・対象・結果を先に明示し、abilityClaimsと同じ公開主張にしてください。`
    : taskArtifact.taskType === 'priority-answer'
      ? `
${renderPriorityAnswerSemanticRules({ firstDaySparseEvidence })}
${executionValuePolicy}
${executionFactionPolicy}
- roleTaskData.promptGuidance.publicSpeechGuidanceがある場合は、その追加指示を適用してください。
- roleTaskData.promptGuidanceの役職固有判断・CO戦術・陣営戦術・公開順序を、通常議論と同じCO判断材料として使用してください。`
      : taskArtifact.taskType === 'vote'
        ? `
${renderVoteReevaluationRule()}
${executionValuePolicy}
${executionFactionPolicy}
${renderVoteDecisionPatchGuidance(getDecisionPatchKeys('vote'))}`
        : taskArtifact.taskType === 'graveyard-conversation'
          ? `
- 墓場会話の主目的は、生前の秘密を共有し、答え合わせや感想を交わすことです。
- roleTaskData.promptGuidance.graveyardConversationGuidanceがある場合は、その参加状況に応じた会話目的を優先してください。`
          : taskArtifact.taskType === 'wolf-attack'
            ? `
${renderWolfAttackSemanticRules({ roleComposition: source?.promptPolicies?.roleComposition ?? {} })}`
            : '';
  return {
    source,
    taskData,
    contract,
    contractView,
    recommendedKeys,
    conditionalKeys,
    recommendedRule,
    conditionalRule,
    heartVoiceRule,
    abilityClaimRule,
    rationaleRule,
    privateTeamStrategyRule,
    ownFactionStrategyRule,
    speechRules,
    isFirstDay,
  };
}

function responseContractRules(parts, taskArtifact) {
  const finalConfirmation = candidateFinalConfirmation(
    parts.source,
    taskArtifact.taskType,
    parts.contract,
    parts.recommendedKeys,
    parts.conditionalKeys,
  );
  return `応答契約:
[game-data:response-contract]
${json(parts.contractView, { compact: true })}
[/game-data]

- response-contractの許可項目・原則出力・条件付き出力の区分と項目構造を維持してください。
- 項目を出す場合は具体値を入れ、空値や空配列を穴埋めとして出力しないでください。${parts.recommendedRule}${parts.conditionalRule}${parts.heartVoiceRule}${parts.abilityClaimRule}${parts.rationaleRule}${parts.privateTeamStrategyRule}${parts.ownFactionStrategyRule}${parts.speechRules}

${finalConfirmation}`;
}

export function buildDecideStagePrompt({ taskArtifact, policy }) {
  const parts = responseContractPromptParts(taskArtifact, policy);
  const reasoningCharacter = policy.contextSections?.includes('characterReasoning')
    ? structuredClone(parts.source.characterReasoning ?? {})
    : {};
  const internalReasoningDirective = isNormalSpeechTask(taskArtifact.taskType)
    ? renderInternalReasoningDirective(parts.source.internalReasoningDirective ?? null, { isFirstDay: parts.isFirstDay })
    : '';
  const graveyardLead = taskArtifact.taskType === 'graveyard-conversation'
    ? '現在利用できる情報と人物の判断傾向を踏まえ、生前の秘密、答え合わせ、感想を中心に内容を決めてください。'
    : '現在利用できるゲーム情報、本人だけが知る情報、これまでの判断状態、陣営目標を踏まえて、今回の行動と発言内容を決定してください。';
  return `# 行動と発言内容の決定

${graveyardLead}
人物のreasoningProfileやdiscussionBehaviorは、何を重視し、どのように疑い、どのように結論を出すかへ自然に反映してください。
publicSpeech、wolfMessage、rationaleなどの文章は、意味が明確で簡潔な文章にしてください。
行動対象、投票先、能力使用、CO内容、能力結果の主張、decisionPatch、factionStrategy、発言で伝える主張と根拠を互いに整合させてください。

現在の情報:
[game-data:decision-input]
${json(parts.taskData, { compact: true })}
[/game-data]

${nonEmpty(reasoningCharacter) ? `人物の判断傾向:
[game-data:reasoning-character]
${json(compactStageValue(reasoningCharacter) ?? {}, { compact: true })}
[/game-data]

` : ''}${internalReasoningDirective ? `非公開の参考視点:
${internalReasoningDirective}

` : ''}${responseContractRules(parts, taskArtifact)}`;
}

export function buildAnalyzeStagePrompt({ taskArtifact, policy }) {
  if (!policy?.applicable) throw new RangeError('分析用ポリシーが適用不能です。');
  const source = taskArtifact.stageSource;
  const taskData = stageTaskData(taskArtifact, policy);
  return `# 状況分析

現在利用できるゲーム情報から状況を分析してください。

必要に応じて次の観点を整理してください。
- 現時点で確定している事実
- 各主要候補を支持する材料と反証する材料
- 他プレイヤーの主張の整合性
- 現在取り得る主要な選択肢
- 各選択肢の利点とリスク
- 見落としている可能性のある別仮説
- 今後得られる情報
- 自陣営の勝利条件から見た利害

多数の人物が同じ意見を述べていること自体を、その意見が正しい根拠にはしないでください。
公開情報と本人だけが知る情報を区別し、人名、能力対象、投票先、白黒判定を正確に扱ってください。
重要度の高い内容から箇条書きで整理し、最大${generationIntermediateTextPolicy('analyze').promptMaxItems}項目、全体${generationIntermediateTextPolicy('analyze').promptMaxChars}文字以内にまとめてください。

現在の情報:
[game-data:analysis-input]
${json(taskData, { compact: true })}
[/game-data]

自由記述で回答してください。`;
}

export function buildCritiqueStagePrompt({ taskArtifact, policy, analysisText }) {
  if (!policy?.applicable) throw new RangeError('検証用ポリシーが適用不能です。');
  const taskData = stageTaskData(taskArtifact, policy);
  return `# 分析内容の検証

以下の分析内容を、現在のゲーム情報と照合して検証してください。

特に次を確認してください。
- ゲーム上の事実の取り違え
- 人物名、能力対象、投票先、白黒判定の混同
- 公開情報と本人限定情報の混同
- 根拠から結論への論理的飛躍
- 矛盾、虚偽、説明不足が誰の発言・行動に存在する問題かを特定し、その問題を別の人物の疑い材料へ転嫁していないか
- 多数意見への過度な依存
- 別仮説や有力候補の見落とし
- 情報取得価値と誤判断コストの比較
- 陣営目標との不整合

妥当な部分は無理に否定せず、そのまま妥当と評価してください。
問題がある場合は、どの部分が問題で、どのように解釈し直すべきかを具体的に示してください。
重要な問題から箇条書きで整理し、最大${generationIntermediateTextPolicy('critique').promptMaxItems}項目、全体${generationIntermediateTextPolicy('critique').promptMaxChars}文字以内にまとめてください。

現在の情報:
[game-data:critique-input]
${json(taskData, { compact: true })}
[/game-data]

分析内容:
[game-data:analysis-text]
${json({ text: String(analysisText ?? '') }, { compact: true })}
[/game-data]

自由記述で回答してください。`;
}

export function buildFinalizeStagePrompt({ taskArtifact, policy, analysisText, critiqueText = '' }) {
  const parts = responseContractPromptParts(taskArtifact, policy);
  const reasoningCharacter = policy.contextSections?.includes('characterReasoning')
    ? structuredClone(parts.source.characterReasoning ?? {})
    : {};
  const expressionCharacter = structuredClone(parts.source.characterExpression ?? {});
  const objectiveAnalysis = String(analysisText ?? '').trim();
  const analysisCritique = String(critiqueText ?? '').trim();
  const references = {
    ...(objectiveAnalysis ? { objectiveAnalysis } : {}),
    ...(analysisCritique ? { analysisCritique } : {}),
  };
  const hasAnalysis = Boolean(objectiveAnalysis);
  const hasCritique = Boolean(analysisCritique);
  const referenceLead = hasAnalysis && hasCritique
    ? '現在のゲーム情報と以下の分析内容・検証内容を参考に、今回の行動と発言を決定してください。'
    : hasAnalysis
      ? '現在のゲーム情報と以下の分析内容を参考に、今回の行動と発言を決定してください。'
      : hasCritique
        ? '現在のゲーム情報と以下の検証内容を参考に、今回の行動と発言を決定してください。'
        : '現在のゲーム情報から、今回の行動と発言を決定してください。';
  const referenceCheck = hasAnalysis && hasCritique
    ? '分析内容と検証内容はゲーム情報と照合し、事実誤認や対象の取り違えがあれば引き継がないでください。'
    : hasAnalysis
      ? '分析内容はゲーム情報と照合し、事実誤認や対象の取り違えがあれば引き継がないでください。'
      : hasCritique
        ? '検証内容はゲーム情報と照合し、事実誤認や対象の取り違えがあれば引き継がないでください。'
        : '';
  const referenceBlock = Object.keys(references).length
    ? `\n分析資料:\n[game-data:analysis-reference]\n${json(references, { compact: true })}\n[/game-data]\n`
    : '';
  return `# 回答作成

${referenceLead}
人物のreasoningProfileやdiscussionBehaviorを判断へ自然に反映してください。
${referenceCheck ? `${referenceCheck}\n` : ''}行動、投票先、能力対象、CO内容、能力結果の主張、decisionPatch、factionStrategyを整合させてください。
publicSpeechなどの文章は人物設定に従い、その人物らしい自然な発言にしてください。

現在の情報:
[game-data:finalize-input]
${json(parts.taskData, { compact: true })}
[/game-data]
${referenceBlock}
人物の判断傾向:
[game-data:reasoning-character]
${json(compactStageValue(reasoningCharacter) ?? {}, { compact: true })}
[/game-data]

人物の表現設定:
[game-data:character-expression]
${json(compactStageValue(sanitizePromptValue(parts.source, expressionCharacter)) ?? {}, { compact: true })}
[/game-data]

${responseContractRules(parts, taskArtifact)}`;
}

function buildTextStagePrompt({ taskArtifact, candidateObject, policy }) {
  const fieldJobs = buildStageFieldJobs({ taskArtifact, candidateObject, policy });
  const constraints = stageOutputConstraints(taskArtifact.stageSource, {
    taskType: taskArtifact.taskType,
    fields: policy.targetTextFields,
  });
  return `# キャラクター発言化

以下の文章の意味、判断、事実関係を保ったまま、指定された人物の自然な発言として書き換えてください。

今回の作業:
[game-data:field-jobs]
${json(fieldJobs)}
[/game-data]

- 指定されたキーをすべて1回ずつ返してください。
- 指定されていないキーは禁止です。
- semanticLocksを維持し、fieldJobにない事実・判断・情報を追加または推測しないでください。
- 他人の発言を回答として選ばず、context内の文章をコピーしないでください。
- 話者、対象、肯定・否定、評価の強さ、CO、能力結果、質問関係、投票意向を変更しないでください。
${purposeInstructions(fieldJobs, 'render')}

## 最終確認

単一JSONオブジェクトだけを返してください。
textPatch以外のトップレベルキー、説明、批評、コードフェンスは禁止です。

今回返すキー: ${policy.targetTextFields.join(' / ')}。

### 今回のJSON例

${JSON.stringify(exactTextPatchExample(policy.targetTextFields))}${constraints ? `

出力制約: ${constraints}` : ''}`;
}

export function buildRenderStagePrompt({ taskArtifact, candidateObject, policy }) {
  return buildTextStagePrompt({ taskArtifact, candidateObject, policy });
}
