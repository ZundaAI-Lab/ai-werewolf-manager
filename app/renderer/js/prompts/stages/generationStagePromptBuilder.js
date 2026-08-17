/**
 * 責務: 共通の構造草案・発言化契約と、深度4だけに後置する昼公開発言校正契約から、最小工程プロンプトを生成する。
 * 変更ルール:
 * - 深度3と4のdraft・renderを同一実装に保ち、全game-data区画の値はpromptDataSerializerを正本としてJSON化・データ境界文字列を無害化し、通常昼発言のdraftでは解決済み非公開参考視点を直接生成と同じ文面で判断材料へ含め、ゲーム状態を書き換えず、他人の私有情報を追加せず、公開発言本文の意味を解析しない。
 * - 処刑判断はgenerationGuidance.executionValuePolicyを正本として投票と最終巡の通常発言・優先回答へ同じ文面で適用し、voteのdecisionPatch具体化ガイダンスはvoteResponseGuidancePolicy.jsを正本として深度1/2と同じ優先項目を使用する。
 * - 構造草案では検証上任意の項目を原則出力と条件付き出力へ分離し、原則出力の生成機会を削らず、欠落だけをエラー条件へ昇格させない。
 * - draftへ生公開イベントを渡さずgenerationStageSourceの公開履歴射影を使用し、空値を除去したminified JSONだけを掲載する。
 * - 各工程の中間区画は判断・表現・意味ロックだけを説明し、AI向け必須出力・原則出力、主JSON例、返却キー、文字数制約は各工程末尾の最終確認へ一度だけ集約する。
 * - 回答検証上のrequiredTopLevelKeysは原則出力項目を省く根拠にせず、recommendedTopLevelKeysと主JSON例へ検証任意項目の生成機会を維持する。
 * - 公開発言量の人間向けラベルや長さ区分は中間工程へ出さず、会話開始・序盤反応に意味がある追加指示だけroleTaskData.promptGuidanceから引き継ぐ。
 * - 内部UUIDは雪女の明示ID契約以外へ出さず表示名またはイベント番号へ変換する。
 * - renderではsourceTextを唯一の意味正本とし、話者・口調・呼称・意味ロックだけを渡して他人の公開発言本文や候補全体を渡さない。
 * - 校正ではpublicSpeech以外、生の公開イベント、実役職、未許可区画を出力しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { publicAbilityResultLabel } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { renderPriorityAnswerSemanticRules, renderPublicSpeechSemanticRules, renderVoteReevaluationRule, renderWolfAttackSemanticRules } from '../policies/taskInstructionPolicy.js';
import { renderVoteDecisionPatchGuidance } from '../policies/voteResponseGuidancePolicy.js';
import { renderInternalReasoningDirective } from '../templates/characterReasoningDirectiveTemplates.js';
import { getDecisionPatchKeys } from '../response/responseContract.js';
import { stringifyPromptData } from '../serialization/promptDataSerializer.js';

function nonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).length > 0;
}

function json(value, { compact = false } = {}) {
  // generation工程でも共通serializerを使い、game-data境界文字列を値としてのみ保持する。
  // draftは転送量削減のためminifyする。
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


function draftPublicState(source) {
  return {
    alivePlayers: (source?.publicState?.alivePlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')),
    deadPlayers: (source?.publicState?.deadPlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? '')),
    activeClaims: formatActiveClaims(source),
    publicAbilityClaims: formatPublishedAbilityClaims(source),
    publicLocks: sanitizePromptValue(source, source?.publicState?.publicLocks ?? {}),
    currentVoteState: sanitizePromptValue(source, source?.publicState?.currentVoteState ?? null),
    recentOutcomeSummary: sanitizePromptValue(source, source?.publicState?.recentOutcomeSummary ?? []),
  };
}

function draftPrivateState(source) {
  const teammates = source?.privateState?.teammates ?? {};
  return {
    ownRole: sanitizePromptValue(source, source?.privateState?.ownRole ?? {}),
    ownAbilityResults: sanitizePromptValue(source, source?.privateState?.ownAbilityResults ?? []),
    teammates: {
      knownWolves: (teammates.knownWolfIds ?? []).map((id) => displayPlayerName(source, id)),
      knownMadmen: (teammates.knownMadmanIds ?? []).map((id) => displayPlayerName(source, id)),
      knownMasons: (teammates.knownMasonIds ?? []).map((id) => displayPlayerName(source, id)),
    },
    privateLocks: sanitizePromptValue(source, source?.privateState?.privateLocks ?? {}),
  };
}

function draftRoleTaskData(source, taskType) {
  const roleTaskData = source?.roleTaskData ?? {};
  const result = sanitizePromptValue(source, roleTaskData);
  delete result.validTargetNames;
  delete result.validTargetIds;
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

function buildProofreadSpeaker(source) {
  const expression = source?.characterExpression ?? {};
  return {
    name: String(source?.currentMoment?.playerName ?? ''),
    firstPerson: String(expression.firstPerson ?? ''),
    genericSecondPerson: String(expression.genericSecondPerson ?? ''),
    speakingStyle: String(expression.speakingStyle ?? ''),
    defaultEndings: String(expression.defaultEndings ?? ''),
    avoidedExpressions: String(expression.avoidedExpressions ?? ''),
    callNames: compactCallNames(source),
  };
}

function compactCandidateAbilityClaims(value) {
  if (!Array.isArray(value)) return null;
  return value.map((claim) => ({
    roleId: String(claim?.roleId ?? ''),
    resultDay: Number(claim?.resultDay ?? 0),
    target: String(claim?.target ?? ''),
    result: String(claim?.result ?? ''),
    selectionBasis: String(claim?.selectionBasis ?? ''),
    evidenceEventSequences: [...(claim?.evidenceEventSequences ?? [])].map(Number).filter(Number.isInteger),
    selectionReasonAtTime: String(claim?.selectionReasonAtTime ?? ''),
  }));
}

function buildLockedMeaning(candidateObject) {
  const interaction = candidateObject?.speechInteraction ?? {};
  const decisionPatch = candidateObject?.decisionPatch ?? {};
  return {
    questionTargets: [...(interaction.questionTargets ?? [])].map(String),
    answerEventSequences: [...(interaction.answerEventSequences ?? [])].map(Number).filter(Number.isInteger),
    correctedSpeechSequences: [...(decisionPatch.correctedSpeechSequences ?? [])].map(Number).filter(Number.isInteger),
    coOperation: Object.hasOwn(candidateObject ?? {}, 'coOperation')
      ? structuredClone(candidateObject.coOperation)
      : null,
    abilityClaims: Object.hasOwn(candidateObject ?? {}, 'abilityClaims')
      ? compactCandidateAbilityClaims(candidateObject.abilityClaims)
      : null,
    decisionStance: {
      suspicionCandidates: [...(decisionPatch.suspicionCandidates ?? [])].map(String),
      executionCandidates: [...(decisionPatch.executionCandidates ?? [])].map(String),
      intendedVote: Object.hasOwn(decisionPatch, 'intendedVote') ? decisionPatch.intendedVote : undefined,
      assessmentLevel: String(decisionPatch.assessmentLevel ?? ''),
      uncertainty: String(decisionPatch.uncertainty ?? ''),
    },
  };
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
    const day = Number(claim?.observedDay ?? claim?.resultDay ?? 0);
    return `Day ${day} ${actor}（${role}）→ ${target}: ${publicAbilityResultLabel(claim?.result, claim?.claimedRoleId ?? claim?.roleId)}`;
  });
}

function buildProofreadPublicSituation(source) {
  return {
    day: Number(source?.currentMoment?.day ?? 0),
    phase: String(source?.currentMoment?.phase ?? ''),
    aliveNames: (source?.publicState?.alivePlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? row?.id ?? '')),
    deadNames: (source?.publicState?.deadPlayers ?? []).map((row) => String(row?.name ?? row?.playerName ?? row?.id ?? '')),
    activeClaims: formatActiveClaims(source),
    publishedAbilityClaims: formatPublishedAbilityClaims(source),
  };
}

function effectivePublicClaim(source, candidateObject) {
  const playerId = String(source?.currentMoment?.playerId ?? '');
  const existing = (source?.publicState?.activeClaims ?? []).find((claim) => String(claim?.actorId ?? '') === playerId) ?? null;
  const operation = candidateObject?.coOperation ?? null;
  const action = String(operation?.action ?? 'none');
  if (['declare', 'change'].includes(action)) {
    return { roleId: String(operation?.roleId ?? ''), day: Number(source?.currentMoment?.day ?? 0) };
  }
  if (action === 'withdraw') return null;
  return existing ? { roleId: String(existing.roleId ?? ''), day: Number(existing.day ?? 0) } : null;
}

function compactClaimHistoryItem(source, claim) {
  return {
    day: Number(claim?.observedDay ?? claim?.resultDay ?? 0),
    targetName: claim?.targetId
      ? displayPlayerName(source, claim.targetId)
      : String(claim?.target ?? ''),
    result: publicAbilityResultLabel(claim?.result, claim?.claimedRoleId ?? claim?.roleId),
    selectionReasonAtTime: String(claim?.selectionReasonAtTime ?? ''),
  };
}

function buildClaimConsistency(source, candidateObject) {
  const ownRole = source?.privateState?.ownRole ?? {};
  const effectiveClaim = effectivePublicClaim(source, candidateObject);
  const isFakeWolfTeamClaim = String(ownRole.team ?? '') === 'wolf'
    && Boolean(effectiveClaim?.roleId)
    && String(effectiveClaim.roleId) !== String(ownRole.roleId ?? '');
  if (!isFakeWolfTeamClaim) {
    return { checkRequired: false, claimedRole: null, claimStartedDay: null, publishedAbilityClaims: [] };
  }
  const playerId = String(source?.currentMoment?.playerId ?? '');
  const roleId = String(effectiveClaim.roleId);
  const prior = (source?.publicState?.publicAbilityClaims ?? [])
    .filter((claim) => String(claim?.actorId ?? '') === playerId && String(claim?.claimedRoleId ?? claim?.roleId ?? '') === roleId)
    .map((claim) => compactClaimHistoryItem(source, claim));
  const current = Array.isArray(candidateObject?.abilityClaims)
    ? candidateObject.abilityClaims
      .filter((claim) => String(claim?.roleId ?? '') === roleId)
      .map((claim) => compactClaimHistoryItem(source, claim))
    : [];
  return {
    checkRequired: true,
    claimedRole: roleLabel(roleId),
    claimStartedDay: Number(effectiveClaim.day ?? source?.currentMoment?.day ?? 0),
    publishedAbilityClaims: [...prior, ...current],
  };
}

export function buildSpeechProofreadInput({ taskArtifact, candidateObject }) {
  if (!(isNormalSpeechTask(taskArtifact?.taskType) || taskArtifact?.taskType === 'priority-answer')) throw new RangeError('校正プロンプトは昼の公開発言だけ（通常発言・回答優先発言）を対象にします。');
  const source = taskArtifact.stageSource;
  return {
    sourceText: String(candidateObject?.publicSpeech ?? ''),
    speaker: buildProofreadSpeaker(source),
    lockedMeaning: sanitizePromptValue(source, buildLockedMeaning(candidateObject)),
    publicSituation: buildProofreadPublicSituation(source),
    claimConsistency: buildClaimConsistency(source, candidateObject),
  };
}

function publicSpeechGuidance(source) {
  return String(source?.roleTaskData?.promptGuidance?.publicSpeechGuidance ?? '').trim();
}

function publicSpeechOutputConstraint(source, taskType = 'speech') {
  const policy = source?.promptPolicies?.publicSpeechLengthPolicy ?? {};
  const targetChars = Number(policy.targetChars ?? 0);
  if (!Number.isFinite(targetChars) || targetChars <= 0) return '';
  const maxChars = Number(source?.promptPolicies?.outputLimits?.maxPublicSpeechLength ?? 450);
  const claimTargetChars = Number(policy.claimOverride?.targetChars ?? 0);
  const claimOverride = Number.isFinite(claimTargetChars) && claimTargetChars > 0 && claimTargetChars !== targetChars
    ? `（CO・能力履歴公開時は約${claimTargetChars}文字）`
    : '';
  const label = taskType === 'priority-answer' ? '公開回答' : '公開発言';
  return `${label}: ${maxChars}文字以内。目安は約${targetChars}文字${claimOverride}`;
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
    rows.push(`心の声: 1～2文・${maxHeartVoiceLength}文字以内`);
  }
  return rows.join('、');
}

function draftContractView(contract, recommendedKeys, conditionalKeys) {
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

function draftExample(contract, taskType, recommendedKeys, conditionalKeys) {
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

function draftFinalConfirmation(source, taskType, contract, recommendedKeys, conditionalKeys) {
  const requiredKeys = [...(contract?.requiredTopLevelKeys ?? [])];
  const example = draftExample(contract, taskType, recommendedKeys, conditionalKeys);
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
    firstPerson: value.firstPerson,
    genericSecondPerson: value.genericSecondPerson,
    speakingStyle: value.speakingStyle,
    defaultEndings: value.defaultEndings,
    avoidedExpressions: value.avoidedExpressions,
  };
}

function actionSummary(source, candidateObject) {
  const summary = {
    taskType: String(source?.currentMoment?.taskType ?? ''),
    validTargets: (source?.roleTaskData?.validTargetIds ?? []).map((id) => displayPlayerName(source, id)),
  };
  for (const key of ['actionAnswer', 'attackAssessment', 'decisionPatch', 'speechInteraction', 'coOperation', 'abilityClaims', 'sharedStrategyUpdate', 'estimate']) {
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

function draftHistories(source, taskType) {
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


function draftTaskData(taskArtifact, policy) {
  const source = taskArtifact.stageSource;
  const sections = new Set(policy.contextSections ?? []);
  const result = {};
  if (sections.has('currentMoment')) result.currentMoment = promptMoment(source);
  if (sections.has('publicState')) result.publicState = draftPublicState(source);
  if (sections.has('recentOutcomeSummary') && !sections.has('publicState')) result.recentOutcomeSummary = sanitizePromptValue(source, source.publicState?.recentOutcomeSummary ?? []);
  if (sections.has('resultSummary')) result.resultSummary = sanitizePromptValue(source, source.roleTaskData?.taskSpecific?.resultImpression ?? null);
  if (sections.has('privateState')) result.privateState = draftPrivateState(source);
  if (sections.has('roleTaskData')) result.roleTaskData = draftRoleTaskData(source, taskArtifact.taskType);
  if (sections.has('histories') || sections.has('recentWolfConversation') || sections.has('recentMasonConversation') || sections.has('recentGraveyardConversation') || sections.has('pastGraveyardConversations') || sections.has('existingInternalMemo')) {
    result.histories = draftHistories(source, taskArtifact.taskType);
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
        : { questionTargets: [], answerEventSequences: [] },
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
    lines.push('- public-dialogueはsourceTextと同じ話者・対象・結論・時系列を維持し、一人称・呼称・話し方・語尾・文法だけを整えてください。');
    lines.push('- sourceTextにない新しい根拠、推理、質問、投票意向、CO、能力結果を追加せず、内容を削除または反転しないでください。');
    lines.push('- 安全に表現だけを変更できない場合はsourceTextをそのまま返してください。');
  }
  if (purposes.has('private-dialogue')) lines.push('- private-dialogueは指定参加者だけの自然な秘密会話にし、公開説明へ変えないでください。');
  if (purposes.has('inner-voice')) lines.push('- inner-voiceは公開発言調へ変えず、その局面固有の短い内心として整えてください。');
  if (purposes.has('audit-rationale')) lines.push('- audit-rationaleは確定対象と評価に一致する結果判明前の監査理由として、具体的かつ簡潔にしてください。キャラクター語尾を演出しないでください。');
  if (purposes.has('internal-memo')) lines.push('- internal-memoは会話文にせず、重複を整理し、確定事項と仮説を区別して上限内に収めてください。');
  if (purposes.has('result-comment')) lines.push('- result-commentはresultSummaryと一致する自然で短い感想にしてください。ゲーム経過を読み上げず、knowledgeTimingがafter-exitの区画を生存中から知っていたように書かず、推理や投票判断を再実行しないでください。callNamesがある相手は指定呼称を使用してください。');
  return lines.join('\n');
}

export function buildDraftStagePrompt({ taskArtifact, policy }) {
  if (!policy?.applicable) throw new RangeError('構造草案ポリシーが適用不能です。');
  const source = taskArtifact.stageSource;
  const taskData = draftTaskData(taskArtifact, policy);
  const reasoningCharacter = policy.contextSections?.includes('characterReasoning')
    ? structuredClone(source.characterReasoning ?? {})
    : {};
  const isFirstDay = Number(source?.currentMoment?.day ?? 0) === 1;
  const firstDaySparseEvidence = isFirstDay
    && (source?.publicState?.publicAbilityClaims ?? []).filter((claim) => claim.status !== 'voided').length <= 1;
  const internalReasoningDirective = isNormalSpeechTask(taskArtifact.taskType)
    ? renderInternalReasoningDirective(source.internalReasoningDirective ?? null, { isFirstDay })
    : '';
  const contract = structuredClone(source.responseContract ?? {});
  const allowedKeys = new Set(contract.allowedTopLevelKeys ?? []);
  const conditionalKeys = [...new Set([
    ...Object.keys(contract.conditionalExamples ?? {}),
    ...(allowedKeys.has('speechInteraction') ? ['speechInteraction'] : []),
  ])];
  const recommendedKeys = (contract.optionalTopLevelKeys ?? [])
    .filter((key) => !conditionalKeys.includes(key))
    .filter((key) => !(isNormalSpeechTask(taskArtifact.taskType) && key === 'publicSpeech'));
  const contractView = draftContractView(contract, recommendedKeys, conditionalKeys);
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
    ? '\n- 本人選択能力のabilityClaimsでは、selectionBasis・evidenceEventSequences・selectionReasonAtTimeを選択時点の根拠として記録し、後発情報で変更しないでください。'
    : '';
  const actionRationaleRule = allowedKeys.has('actionRationale')
    ? `\n- actionRationaleは結果判明前の具体的な選択理由を${taskArtifact.taskType === 'freeze' ? '1～3文' : '1～2文'}で簡潔に記録してください。`
    : '';
  const privateTeamStrategyRule = (isNormalSpeechTask(taskArtifact.taskType) || taskArtifact.taskType === 'priority-answer')
    && nonEmpty(taskData?.histories?.privateTeamStrategy)
    ? '\n- histories.privateTeamStrategyは本人限定の判断材料です。文面をpublicSpeechへ引用・転用せず、公開発言は公開情報だけでも成立する表現にしてください。'
    : '';
  const executionValuePolicy = String(source?.roleTaskData?.promptGuidance?.executionValuePolicy ?? '').trim();
  const executionFactionPolicy = String(source?.roleTaskData?.promptGuidance?.executionFactionPolicy ?? '').trim();
  const speechRules = isNormalSpeechTask(taskArtifact.taskType)
    ? `
${renderPublicSpeechSemanticRules({ firstDaySparseEvidence })}
${executionValuePolicy}
${executionFactionPolicy}
- roleTaskData.promptGuidance.publicSpeechGuidanceがある場合は、その追加指示を適用してください。
- CO・能力履歴公開時は役職・対象・結果を先に明示してください。`
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
        : taskArtifact.taskType === 'wolf-attack'
          ? `
${renderWolfAttackSemanticRules()}`
          : '';
  const finalConfirmation = draftFinalConfirmation(
    source,
    taskArtifact.taskType,
    contract,
    recommendedKeys,
    conditionalKeys,
  );
  return `# 構造草案工程

ゲーム判断と構造化情報を確定してください。
文章表現の完成度より、対象、結果、時系列、公開情報との整合を優先してください。

タスク固有情報:
[game-data:draft-task-data]
${json(taskData, { compact: true })}
[/game-data]

${nonEmpty(reasoningCharacter) ? `判断上の人物設定:
[game-data:reasoning-character]
${json(compactStageValue(reasoningCharacter) ?? {}, { compact: true })}
[/game-data]

` : ''}${internalReasoningDirective ? `非公開の参考視点:
${internalReasoningDirective}

` : ''}応答契約:
[game-data:response-contract]
${json(contractView, { compact: true })}
[/game-data]

- response-contractの許可項目・原則出力・条件付き出力の区分と項目構造を維持してください。
- 文章フィールドは、意味が正確な簡潔な草案で構いません。
- 項目を出す場合は具体値を入れ、空値や空配列を穴埋めとして出力しないでください。${recommendedRule}${conditionalRule}${heartVoiceRule}${abilityClaimRule}${actionRationaleRule}${privateTeamStrategyRule}${speechRules}

${finalConfirmation}`;
}

function buildTextStagePrompt({ stageId, taskArtifact, candidateObject, policy }) {
  const fieldJobs = buildStageFieldJobs({ taskArtifact, candidateObject, policy });
  const title = stageId === 'proofread' ? '# 最終校正工程' : '# 発言化工程';
  const lead = stageId === 'proofread'
    ? '判断を再実行せず、各fieldJobの文章をその場で完成稿へ校正してください。'
    : 'sourceTextが意味・話者・対象・結論・時系列の唯一の正本です。各fieldJob内の情報だけを使い、同じ内容のまま表現だけを完成稿へ整えてください。';
  const unchanged = stageId === 'proofread' ? '\n- 変更が不要でも、対象キーは元の文章をそのまま返してください。' : '';
  const constraints = stageOutputConstraints(taskArtifact.stageSource, {
    taskType: taskArtifact.taskType,
    fields: policy.targetTextFields,
  });
  return `${title}

${lead}

今回の作業:
[game-data:field-jobs]
${json(fieldJobs)}
[/game-data]

- 指定されたキーをすべて1回ずつ返してください。
- 指定されていないキーは禁止です。
- semanticLocksを維持し、fieldJobにない事実・判断・情報を追加または推測しないでください。
- 他人の発言を回答として選ばず、context内の文章をコピーしないでください。
- 話者、対象、肯定・否定、評価の強さ、CO、能力結果、質問関係、投票意向を変更しないでください。${unchanged}
${purposeInstructions(fieldJobs, stageId)}

## 最終確認

単一JSONオブジェクトだけを返してください。
textPatch以外のトップレベルキー、説明、批評、コードフェンスは禁止です。

今回返すキー: ${policy.targetTextFields.join(' / ')}。

### 今回のJSON例

${JSON.stringify(exactTextPatchExample(policy.targetTextFields))}${constraints ? `

出力制約: ${constraints}` : ''}`;
}

export function buildRenderStagePrompt({ taskArtifact, candidateObject, policy }) {
  return buildTextStagePrompt({ stageId: 'render', taskArtifact, candidateObject, policy });
}

export function buildProofreadStagePrompt({ taskArtifact, candidateObject, policy }) {
  if (!(isNormalSpeechTask(taskArtifact?.taskType) || taskArtifact?.taskType === 'priority-answer')) throw new RangeError('校正プロンプトは昼の公開発言だけ（通常発言・回答優先発言）を対象にします。');
  if (!policy?.applicable || policy.targetTextFields?.length !== 1 || policy.targetTextFields[0] !== 'publicSpeech') {
    throw new RangeError('校正対象はpublicSpeechだけです。');
  }
  const input = buildSpeechProofreadInput({ taskArtifact, candidateObject });
  const claimSection = input.claimConsistency.checkRequired ? `
## 騙りCO整合性

この話者は公開上「${input.claimConsistency.claimedRole}」をCOしています。
公開情報だけを知るその役職者本人として自然か、公開済みの対象・結果・選択理由・時点・過去COとの整合を確認してください。騙りや人狼であることは漏らさず、安全に直せない場合は原文を維持してください。
` : '';
  const constraints = stageOutputConstraints(taskArtifact.stageSource, {
    taskType: taskArtifact.taskType,
    fields: ['publicSpeech'],
  });
  return `# 昼議論・最終校正

意味・対象・評価の強さ・CO・能力結果・質問関係・訂正対象を変更せず、公開文章だけを完成稿へ校正してください。

- 文法、助詞、語順、一人称、呼称、口調、語尾、会話接続、重複を整えてください。
- 発言時点の時系列、生存・死亡・処刑・襲撃、公開CO・公開能力結果と整合させてください。
- 新しい事実、根拠、推理、質問、誘導、非公開情報を追加せず、内容を水増ししないでください。
- 意味が変わる可能性がある場合は原文を維持してください。
${claimSection}
[game-data:proofread-input]
${json(input)}
[/game-data]

- 変更が不要な場合は原文をそのまま返してください。

## 最終確認

単一JSONオブジェクトだけを返してください。
textPatch以外のトップレベルキー、説明、批評、コードフェンスは禁止です。

今回返すキー: publicSpeech。

### 今回のJSON例

${JSON.stringify({ textPatch: { publicSpeech: '校正後の完成文章' } })}${constraints ? `

出力制約: ${constraints}` : ''}`;
}

