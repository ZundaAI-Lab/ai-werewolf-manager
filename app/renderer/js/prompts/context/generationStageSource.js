/**
 * 責務: buildPromptContext()の構造化結果とタスク固有決定値から、工程プロンプト投影専用のstageSourceと、AIへ送信しない文章境界検査参照を決定的に構築する。
 * 変更ルール:
 * - 深度2のdecideへ、直接生成と同じ人物プロフィール・推理傾向・議論行動・解決済み非公開参考視点を引き継ぐ。ただし一人称・口調・語尾・口調例・呼称はrenderだけへ投影する。深度3/4のanalyze/critiqueへ人物設定を渡さず、finalizeで判断傾向と表現設定を戻す。
 * - Day 2以降の通常昼議論第1巡では、直接生成と同じ初期公開役職構成由来の夜明け状況ガイドを草案工程へ引き継ぎ、現在の生存・死亡・CO等で候補を絞らない。
 * - 元プロンプト文字列を解析せず、API通信、DOM、ゲーム状態更新を行わない。公開履歴は本番プロンプトと同じ履歴ポリシーとpublicHistorySection.jsの射影を正本とし、中間候補工程へ生イベントを渡さない。未登録キーをstageSourceへ通さず、内部UUIDは工程プロンプトへ直接掲載しない。公開配役は工程側の役職存在判定にも使うためpromptPolicies.roleCompositionを正本として保持し、工程入力本文へ重複表示しない。本人の保存済み陣営戦略は本人限定の判断材料としてprivateStateへ射影し、更新時刻や生成元ターンIDなどの管理情報は渡さない。保存済みheartVoiceは生成・監査用状態に残してもstageSourceへ再投影しない。公開発言の文字数目安・上限は工程プロンプト末尾の最終確認だけで使える構造値として保持する。characterReasoningはdecide/finalizeの判断用、characterExpressionはrender/finalizeの表現用とする。safetyReferencesとrecentPublicTimelineはローカル検査・参照変換専用とする。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

import { resolveOpeningConversationMode } from '../policies/openingSpeechPolicy.js';
import {
  buildSelectedPublicHistoryEvents,
  selectLatestOwnSpeechBeforeDelta,
  selectPublicHistoryTimeline,
} from '../policies/publicHistoryPolicy.js';
import { resolvePublicSpeechLengthPolicy } from '../../domain/policies/publicSpeechLengthPolicy.js';
import { MAX_FREEZE_ACTION_RATIONALE_LENGTH, MAX_NIGHT_ACTION_RATIONALE_LENGTH } from '../../config/constants.js';
import { getFactionStrategyFields } from '../../domain/game/factionStrategyState.js';
import { publicHistoryData, selfPublicContinuityData } from '../sections/publicHistorySection.js';
import { buildRoleCompositionSituationGuide } from '../sections/roleCompositionSituationSection.js';

const RESPONSE_CONTRACT_KEYS = Object.freeze([
  'mode',
  'allowedTopLevelKeys',
  'requiredTopLevelKeys',
  'optionalTopLevelKeys',
  'fieldDescriptions',
  'completeExample',
  'conditionalExamples',
]);

function clone(value, fallback) {
  if (value === undefined || value === null) return structuredClone(fallback);
  return structuredClone(value);
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value ?? {}).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label}のキーが不正です: ${actualKeys.join(', ') || 'なし'}`);
  }
}

function normalizedResponseContract(responseContract) {
  assertExactKeys(responseContract, RESPONSE_CONTRACT_KEYS, 'responseContract');
  return {
    mode: String(responseContract.mode ?? ''),
    allowedTopLevelKeys: clone(responseContract.allowedTopLevelKeys, []),
    requiredTopLevelKeys: clone(responseContract.requiredTopLevelKeys, []),
    optionalTopLevelKeys: clone(responseContract.optionalTopLevelKeys, []),
    fieldDescriptions: clone(responseContract.fieldDescriptions, {}),
    completeExample: clone(responseContract.completeExample, {}),
    conditionalExamples: clone(responseContract.conditionalExamples, {}),
  };
}

function allPublicEvents(context) {
  return Object.values(context?.board?.publicTimeline ?? {})
    .flatMap((events) => Array.isArray(events) ? events : [])
    .filter(Boolean)
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
}

function recentOutcomeSummary(context) {
  return allPublicEvents(context).filter((event) => (
    ['vote-finalized', 'execution', 'dawn', 'result-published', 'game-result'].includes(event?.type)
  )).slice(-8).map((event) => structuredClone(event));
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasMeaningfulValue);
  return String(value).trim().length > 0;
}

function latestWolfSharedStrategy(context) {
  const current = context?.wolfCommunication?.current?.sharedStrategy;
  if (hasMeaningfulValue(current)) return clone(current, {});
  const past = Array.isArray(context?.wolfCommunication?.past) ? context.wolfCommunication.past : [];
  const latest = [...past].reverse().find((session) => hasMeaningfulValue(session?.sharedStrategy));
  return clone(latest?.sharedStrategy, {});
}

function privateTeamStrategy(context) {
  const wolfSharedStrategy = latestWolfSharedStrategy(context);
  const wolfPartnerPublicPositions = clone(context?.wolfPartnerPublicPositions, []);
  if (!hasMeaningfulValue(wolfSharedStrategy) && !wolfPartnerPublicPositions.length) return null;
  return {
    wolfSharedStrategy,
    wolfPartnerPublicPositions,
  };
}

function ownFactionStrategy(context) {
  const state = context?.player?.factionStrategyState ?? null;
  if (!state?.updatedAt) return null;
  const profile = String(context?.player?.strategyProfile ?? state?.profile ?? '');
  const fields = getFactionStrategyFields(profile);
  if (!profile || !fields.length) return null;
  const values = Object.fromEntries(fields
    .map((key) => [key, String(state?.[key] ?? '').trim()])
    .filter(([, value]) => value));
  if (!Object.keys(values).length) return null;
  return { profile, ...values };
}

function otherPublicSpeechReferences(recentPublicTimeline, playerId) {
  const actorId = String(playerId ?? '');
  return (recentPublicTimeline ?? [])
    .filter((event) => event?.type === 'public-speech')
    .filter((event) => String(event?.actorId ?? '') !== actorId)
    .map((event) => ({
      eventId: String(event?.id ?? ''),
      sequence: Number(event?.sequence ?? 0),
      actorId: String(event?.actorId ?? ''),
      text: String(event?.payload?.text ?? ''),
    }))
    .filter((item) => item.text);
}

function privateDialogueReferences(context) {
  const messages = [
    ...(context?.wolfCommunication?.current?.messages ?? []),
    ...(context?.masonCommunication?.current?.messages ?? []),
    ...(context?.graveyardCommunication?.current?.messages ?? []),
  ];
  return messages.map((message) => ({
    id: String(message?.id ?? ''),
    speakerId: String(message?.speakerId ?? ''),
    content: String(message?.content ?? ''),
  })).filter((item) => item.content);
}

export function buildGenerationStageSource({
  context,
  decision,
  taskType,
  playerId,
  slotId,
  validTargetIds,
  publicHistoryMode = 'delta',
  responseContract,
  generationGuidance = null,
  internalReasoningDirective = null,
}) {
  const player = context?.player ?? {};
  const conversationMode = isNormalSpeechTask(taskType) ? resolveOpeningConversationMode(context) : null;
  const speechPolicy = (isNormalSpeechTask(taskType) || ['priority-answer', 'testament'].includes(taskType))
    ? resolvePublicSpeechLengthPolicy(player?.character?.speechLength, {
      conversationMode: isNormalSpeechTask(taskType) ? conversationMode : 'normal',
    })
    : null;
  const aiRules = context?.game?.rules?.ai ?? {};
  const publicHistorySelection = {
    preserveEventSequences: internalReasoningDirective?.anchorEventSequences ?? [],
  };
  const selectedPublicTimeline = selectPublicHistoryTimeline(context, decision, publicHistoryMode, publicHistorySelection);
  const recentPublicTimeline = buildSelectedPublicHistoryEvents(context, decision, publicHistoryMode, publicHistorySelection);
  const publicHistoryProjection = publicHistoryData(context, selectedPublicTimeline);
  const ownPublicHistoryProjection = recentPublicTimeline
    .filter((event) => event?.type === 'public-speech' && String(event?.actorId ?? '') === String(player.id ?? ''))
    .map((event) => selfPublicContinuityData(context, event));
  const latestOwnSpeech = selectLatestOwnSpeechBeforeDelta(
    context,
    decision,
    publicHistoryMode,
    selectedPublicTimeline,
  );
  const teamStrategy = privateTeamStrategy(context);
  const factionStrategy = ownFactionStrategy(context);
  return {
    currentMoment: {
      day: Number(context?.game?.day ?? 0),
      phase: String(context?.game?.phase ?? ''),
      taskType: String(taskType ?? ''),
      playerId: String(playerId ?? player.id ?? ''),
      playerName: String(player.name ?? ''),
      slotId: String(slotId ?? ''),
    },
    publicState: {
      alivePlayers: clone(context?.board?.alive, []),
      deadPlayers: clone(context?.board?.dead, []),
      activeClaims: clone(context?.board?.claims, []),
      publicAbilityClaims: clone(context?.board?.publicAbilityClaims, []),
      publicLocks: {
        claimTimingFacts: clone(context?.board?.claimTimingFacts, []),
        pendingMediumClaimRequirements: clone(context?.board?.pendingMediumClaimRequirements, []),
      },
      currentVoteState: clone(context?.game?.vote, null),
      recentOutcomeSummary: recentOutcomeSummary(context),
      roleCompositionSituationGuide: clone(buildRoleCompositionSituationGuide(context, taskType), null),
    },
    privateState: {
      ownRole: {
        roleId: String(player.roleId ?? ''),
        team: String(player.team ?? ''),
        roleState: clone(player.roleState, null),
      },
      ownAbilityResults: clone(context?.private?.abilityResults, []),
      ...(factionStrategy ? { ownFactionStrategy: factionStrategy } : {}),
      teammates: {
        knownWolfIds: clone(player?.knowledge?.knownWolfIds, []),
        knownMadmanIds: clone(player?.knowledge?.knownMadmanIds, []),
        knownMasonIds: clone(player?.knowledge?.knownMasonIds, []),
      },
      privateLocks: {
        ownHistory: clone(context?.ownHistory, {}),
        latestDecision: clone(player?.decisionState, null),
        personalNotifications: clone(context?.private?.personalNotifications, []),
      },
    },
    roleTaskData: {
      validTargetIds: clone(validTargetIds, []),
      decision: clone(decision, {}),
      taskSpecific: {
        wolfConversationPurpose: context?.task?.wolfConversationPurpose ?? null,
        wolfAttackRequired: Boolean(context?.task?.wolfAttackRequired),
        resultImpression: clone(context?.task?.resultImpression, null),
        priorityAnswer: clone(context?.task?.priorityAnswer, null),
      },
      promptGuidance: clone(generationGuidance, {}),
    },
    characterReasoning: {
      profile: String(player?.character?.profile ?? ''),
      reasoningProfile: clone(player?.character?.reasoningProfile, {}),
      discussionBehavior: String(player?.character?.discussionBehavior ?? ''),
    },
    internalReasoningDirective: isNormalSpeechTask(taskType)
      ? clone(internalReasoningDirective, null)
      : null,
    characterExpression: {
      profile: String(player?.character?.profile ?? ''),
      firstPerson: String(player?.character?.firstPerson ?? ''),
      genericSecondPerson: String(player?.character?.genericSecondPerson ?? ''),
      speakingStyle: String(player?.character?.speakingStyle ?? ''),
      defaultEndings: String(player?.character?.defaultEndings ?? ''),
      avoidedExpressions: String(player?.character?.avoidedExpressions ?? ''),
      speechExamples: String(player?.character?.speechExamples ?? ''),
      callNames: clone(context?.callNames?.rows, []),
    },
    promptPolicies: {
      roleComposition: clone(context?.game?.roleComposition, {}),
      publicSpeechLengthPolicy: speechPolicy ? {
        targetChars: Number(speechPolicy.targetChars ?? 0),
        claimOverride: speechPolicy.claimOverride ? {
          targetChars: Number(speechPolicy.claimOverride.targetChars ?? 0),
        } : null,
      } : {},
      outputLimits: {
        maxPublicSpeechLength: Number(aiRules.maxPublicSpeechLength ?? 450),
        maxHeartVoiceLength: Number(aiRules.maxHeartVoiceLength ?? 120),
        maxWolfMessageLength: Number(aiRules.maxWolfMessageLength ?? 450),
        maxMasonMessageLength: Number(aiRules.maxMasonMessageLength ?? 450),
        maxGraveyardMessageLength: Number(aiRules.maxGraveyardMessageLength ?? 450),
        maxInternalMemoLength: Number(aiRules.maxInternalMemoLength ?? 3000),
        maxNightSelectionRationaleLength: MAX_NIGHT_ACTION_RATIONALE_LENGTH,
        maxFreezeSelectionRationaleLength: MAX_FREEZE_ACTION_RATIONALE_LENGTH,
      },
    },
    histories: {
      publicHistoryMode: String(publicHistoryMode ?? 'delta'),
      publicHistoryProjection,
      ownPublicHistoryProjection,
      recentPublicTimeline,
      ownPublicHistory: [
        ...recentPublicTimeline
          .filter((event) => event?.actorId === player.id || event?.playerId === player.id),
        ...(latestOwnSpeech ? [latestOwnSpeech] : []),
      ].filter((event, index, items) => items.findIndex((item) => item.id === event.id) === index)
        .map((event) => structuredClone(event)),
      recentWolfConversation: clone(context?.wolfCommunication?.current?.messages, []),
      recentMasonConversation: clone(context?.masonCommunication?.current?.messages, []),
      recentGraveyardConversation: clone(context?.graveyardCommunication?.current?.messages, []),
      pastGraveyardConversations: clone(context?.graveyardCommunication?.past, []),
      ...(teamStrategy ? { privateTeamStrategy: teamStrategy } : {}),
      existingInternalMemo: {
        summary: String(player?.internalMemory?.summary ?? ''),
        notes: clone(player?.internalMemory?.notes, []),
      },
    },
    safetyReferences: {
      otherPublicSpeeches: otherPublicSpeechReferences(recentPublicTimeline, player.id),
      privateDialogueTexts: privateDialogueReferences(context),
    },
    responseContract: normalizedResponseContract(responseContract),
  };
}
