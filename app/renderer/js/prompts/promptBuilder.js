/**
 * 責務: 可視コンテキスト、正式な現在判断・本人履歴、セクション生成器を統合し、初回役職通知と各AIタスクの最終プロンプトEnvelopeを生成する。
 * 変更ルール:
 * - 他人の内部メモ・陣営戦略・GM専用情報・未公開情報を混入させない。
 * - taskInvariantContextには同一taskTypeで不変の意味ルールだけを置き、役職・局面・会話段階・出力契約など可変情報はtaskVariableContext以降へ置く。
 * - キャッシュ効率のために可変情報を不変区画へ移さず、dynamicTaskPrompt末尾の「最終確認」以下は位置・内容とも変更しない。
 * - stablePlayerContextへ渡す本人プロフィール・相手別呼称の表示可否はpromptSectionPolicy.jsの解決結果をそのまま使用し、動的タスク側へ重複掲載しない。
 * - 襲撃候補ごとの警告はdecisionContext.jsが返す公開事実だけを文章化し、候補の固定優先・禁止・真役職断定へ変換しない。
 * - 役職通知は今回固定の本人情報と有効役職だけに限定し、実行タスクは役職通知の保持状態へ依存せず、毎回必要な本人情報・キャラクター・タスク別契約を本文へ含める。
 * - 固定実行原則は常時システム契約を正本とし、通常プロンプトへ重複掲載しない。
 * - 差分送信の基準は必須項目代替・行代替を除く最新の正常AI登録だけとし、代替で追加された公開イベントは次回差分へ残す。
 * - 過去のAPI要求・生応答・継続アンカー・当日カプセルを再送せず、本人の継続情報は正式な現在状態と本人履歴から毎回導出する。
 * - delta時だけ本人の直近公開発言を一件補完し、タスク別応答契約はキャッシュ境界後へ置く。
 * - 公開履歴の順序・時系列とイベント参照番号を変更しない。
 * - 公開履歴はcompactを既定とし、fullは明示選択時だけ全件・全文、compactでは最新の正常AI登録位置以前の通常発言だけを構造的に選別して以後の履歴を全件・全文で維持する。
 * - deltaの既存境界と再同期規則は変更せず、通常昼発言の非公開参考視点が参照する公開イベント番号はcompact・deltaの送信履歴へ必ず残す。
 * - 夜タスクは当日最終巡の公開発言、CO・能力結果を含む盤面、投票・処刑・夜明けの確定履歴を渡す。
 * - 公開質問先と回答元は保存済みの構造化interactionだけを表示し、公開発言本文から推定しない。
 * - 白狼固有の候補区分と説明は公開配役で白狼判定分岐が有効な場合だけ表示する。
 * - 他プレイヤーの能力結果矛盾は公開CO・公開結果・公開配役だけから能力者COごとに表示する。
 * - 前回判断後の公開イベントは本文を複製せずイベント番号だけを前回判断状態へ添える。
 * - 能力者騙りが可能な非村陣営には後発CO用の能力履歴を残す。
 * - キャラクターの推理傾向は固定コンテキストを正本とし、現在タスク側へ重複掲載しない。
 * - 公開会話では会話種のsubjectとtoneだけを短いroleplayCueとして渡す。
 * - 次の通常発言者本人宛ての質問はcurrent-task.requiredAnswersとして通常発言へ渡し、独立回答フェーズ用の指示と重複させない。
 * - 可視情報抽出はpromptContext.js、一般局面判定はpromptSituation.js、表示選択はpromptSectionPolicy.js、個別データ文章化はsections配下、最終文章化はpromptTemplates.jsを使用する。
 */

import {
  APP_VERSION,
  MAX_RESULT_IMPRESSION_LENGTH,
  PHASE_LABELS,
  PROMPT_SPEC_VERSION,
  ROLE_DEFINITIONS,
  TEAM_LABELS,
} from '../config/constants.js';
import { BUILD_ID } from '../../generated/buildInfo.js';
import { buildDecisionContext } from '../domain/game/decisionContext.js';
import { findLatestNormalAiRegistrationTurn } from '../domain/game/aiTurnRegistrationPolicy.js';
import { buildClaimRolePolicy } from '../domain/claims/claimRolePolicy.js';
import { resolveCounterClaimOpportunity } from '../domain/claims/counterClaimOpportunityPolicy.js';
import { resolveOwnerClaimCorroborationOpportunity } from '../domain/claims/ownerClaimCorroborationPolicy.js';
import { resolveWolfPartnerDispositionPolicy } from '../domain/game/wolfPartnerDispositionPolicy.js';
import { resolveFactionStrategyUpdatePolicy } from '../domain/game/factionStrategyUpdatePolicy.js';
import { resolveSnowWomanEstimateLimit } from '../domain/night/snowWomanEstimatePolicy.js';
import { validatePromptVisibility } from './policies/promptAccessPolicy.js';
import { buildPlayerVisibleContext, createPromptContextFingerprint } from './context/promptContext.js';
import { buildPromptEnvelope } from './promptEnvelopeBuilder.js';
import { buildCharacterPromptProfile } from './context/characterPromptProfile.js';
import {
  ROLE_BRIEFING_TEMPLATE,
  DAY_SPEECH_ORDER_PRINCIPLE_TEMPLATE,
  renderOpeningConversationSection,
  renderPublicSpeechGuidance,
  renderResponseFormat,
  renderDynamicTaskPrompt,
  renderFinalResponseReminder,
  renderTaskInvariantPrompt,
  renderTaskVariablePrompt,
  renderTaskInvariantInstruction,
  renderTaskVariableInstruction,
  renderTwoSeerExecutionInstruction,
  renderWolfBlackResultCrisisInstruction,
  renderWolfDayStrategyInstruction,
  renderWhiteWolfDayStrategyInstruction,
  renderMadmanDayStrategyInstruction,
  renderMadmanClaimBranchInstruction,
  renderCounterClaimOpportunityInstruction,
  renderOwnerClaimCorroborationInstruction,
  renderWolfInitialClaimDecisionInstruction,
  renderMadmanInitialClaimDecisionInstruction,
} from './templates/promptTemplates.js';

import { formatInternalMemoryText, formatMemoryLedgerSnapshotForPrompt } from '../domain/memory/memoryLedger.js';
import { resolvePublicSpeechLengthPolicy } from '../domain/policies/publicSpeechLengthPolicy.js';
import { publicAbilityResultLabel } from '../domain/policies/publicAbilityClaimPolicy.js';
import { renderPromptDataBlock } from './serialization/promptDataSerializer.js';
import { renderRoleGuidance } from './templates/rolePromptTemplates.js';
import { renderRuntimeReasoningPolicy } from './templates/reasoningPolicyTemplates.js';
import { renderExecutionValueSemanticRules, renderFactionExecutionValueSemanticRules, renderFinalDiscussionDecisionWindowGuidance } from './policies/taskInstructionPolicy.js';
import { renderInternalReasoningDirective } from './templates/characterReasoningDirectiveTemplates.js';
import { resolveInternalReasoningDirective } from './policies/characterReasoningDirector.js';
import { getFactionStrategyResponseFields, getResponseModeForTask } from './response/responseContract.js';
import { isNormalSpeechTask } from '../config/discussionAiTaskTypes.js';
import { buildResponseExampleReferences } from './response/responseExampleReferences.js';
import { buildStructuredOutputContract } from './response/structuredOutputContract.js';
import { BRIEFING_AI_SYSTEM_INSTRUCTION, PERSISTENT_AI_SYSTEM_INSTRUCTION } from './response/responseContractCatalog.js';
import { resolveCharacterConversationSeed } from './policies/characterConversationPolicy.js';
import { resolveCharacterRoleplayCue } from './policies/characterRoleplayCuePolicy.js';
import { buildPromptSituation } from './policies/promptSituation.js';
import { resolvePromptSectionPolicy } from './policies/promptSectionPolicy.js';
import {
  normalizePublicHistoryTransmissionMode,
  selectPublicHistoryTimeline,
  selectLatestOwnSpeechBeforeDelta,
} from './policies/publicHistoryPolicy.js';
import {
  OPENING_CONVERSATION_MODES,
  isInitialClaimDecisionSituation,
  resolveOpeningConversationMode,
  resolveOpeningIntent,
} from './policies/openingSpeechPolicy.js';

import {
  callNameSection, initialGameRulesSection, initialRoleRulesSection, playerName, compactPromptValue, renderOptionalDataBlock,
} from './sections/promptFormatters.js';
import {
  privateInformation, ownHistory, gameStateData, latestDecisionState, decisionInvalidationState, populationSection,
} from './sections/privateInformationSection.js';
import {
  voteDecisionSection, attackDecisionSection, ownPublicClaimConsistency, otherPublicClaimContradictions, discussionReconsideration,
} from './sections/decisionSection.js';
import {
  claimTimingSection, dayConversationStatusSection, roleDecisionSection, abilityClaimTimelineSection, madmanClaimBranchSection,
} from './sections/conversationSection.js';
import { publicHistoryData, selfPublicContinuityData } from './sections/publicHistorySection.js';
import { graveyardCommunicationSection, masonCommunicationSection, wolfCommunicationSection } from './sections/privateConversationSection.js';
import { currentTaskData } from './sections/currentTaskSection.js';

function buildResponseClaimRolePolicy(context, situation, basePolicy, {
  counterClaimOpportunity = null,
  ownerClaimCorroborationOpportunity = null,
} = {}) {
  if (!(isNormalSpeechTask(situation.taskType) || situation.taskType === 'priority-answer')) return basePolicy;
  const player = context.player;
  const activeClaimRoleId = context.board.claims.find((claim) => claim.actorId === player.id)?.roleId ?? null;
  const strategicClaimer = ['wolf', 'madman', 'fox'].includes(player.strategyProfile);
  const tacticalClaim = Boolean(counterClaimOpportunity || ownerClaimCorroborationOpportunity);
  const coRoleIds = new Set();
  const abilityClaimRoleIds = new Set();

  if (situation.isEndgameFactionTactics) {
    (basePolicy.coRoleIds ?? []).filter((roleId) => roleId !== 'none').forEach((roleId) => coRoleIds.add(roleId));
  } else if (activeClaimRoleId) {
    coRoleIds.add(activeClaimRoleId);
  }

  if (strategicClaimer && (situation.isInitialClaimDecision || tacticalClaim || !activeClaimRoleId || situation.isEndgameFactionTactics)) {
    (basePolicy.abilityClaimRoleIds ?? []).forEach((roleId) => {
      if (!situation.isEndgameFactionTactics) coRoleIds.add(roleId);
      abilityClaimRoleIds.add(roleId);
    });
  } else if (player.roleId !== 'villager' && !['wolf', 'madman', 'fox'].includes(player.roleId)) {
    if (!situation.isEndgameFactionTactics) coRoleIds.add(player.roleId);
    if ((basePolicy.abilityClaimRoleIds ?? []).includes(player.roleId)) abilityClaimRoleIds.add(player.roleId);
  }
  if (activeClaimRoleId) coRoleIds.add(activeClaimRoleId);
  if (activeClaimRoleId && (basePolicy.abilityClaimRoleIds ?? []).includes(activeClaimRoleId)) {
    abilityClaimRoleIds.add(activeClaimRoleId);
  }
  return {
    coRoleIds: [...coRoleIds],
    abilityClaimRoleIds: [...abilityClaimRoleIds],
  };
}

export function buildPromptModel(context, decision, {
  state = null,
  taskType = context.task.type,
  internalReasoningDirective = null,
  factionStrategyUpdatePolicy = null,
  includeInitial = false,
  publicHistoryPolicy = null,
  counterClaimOpportunity = null,
  ownerClaimCorroborationOpportunity = null,
} = {}) {
  const player = context.player;
  const rules = context.game.rules.ai;
  const hasFox = Number(context.game.roleComposition?.fox ?? 0) > 0;
  const hasCat = Number(context.game.roleComposition?.cat ?? 0) > 0;
  const badChildRoleNames = ['wolf', 'whiteWolf', 'snowWoman']
    .filter((roleId) => Number(context.game.roleComposition?.[roleId] ?? 0) > 0)
    .map((roleId) => ROLE_DEFINITIONS[roleId].name);
  const situation = buildPromptSituation(context, decision, { taskType });
  const sectionPolicy = resolvePromptSectionPolicy(situation, {
    factionStrategyUpdatePolicy,
    includeInitial,
    publicHistoryPolicy,
  });
  const claimRolePolicy = buildClaimRolePolicy(context.game.roleComposition);
  const responseClaimRolePolicy = buildResponseClaimRolePolicy(context, situation, claimRolePolicy, {
    counterClaimOpportunity,
    ownerClaimCorroborationOpportunity,
  });
  const conversationMode = situation.isSpeech
    ? resolveOpeningConversationMode(context)
    : OPENING_CONVERSATION_MODES.NORMAL;
  const publicSpeechPolicy = situation.isSpeech || situation.isPriorityAnswer || situation.isTestament
    ? resolvePublicSpeechLengthPolicy(player.character?.speechLength, { conversationMode })
    : null;
  // 初日の横並び対策は可変区画だけで扱い、通常日の共通プロンプトを増やさない。
  const isFirstDay = Number(context.game.day ?? 0) === 1;
  const firstDaySparseEvidence = isFirstDay
    && (context.board.publicAbilityClaims ?? []).filter((claim) => claim.status !== 'voided').length <= 1;
  const publicSpeechGuidance = [
    renderPublicSpeechGuidance(publicSpeechPolicy),
    situation.isFinalDiscussionDecisionWindow
      ? renderFinalDiscussionDecisionWindowGuidance()
      : '',
  ].filter(Boolean).join('\n');
  const openingSpeech = conversationMode === OPENING_CONVERSATION_MODES.FIRST_SPEAKER;
  const openingIntent = openingSpeech ? resolveOpeningIntent(context) : null;
  const characterConversation = openingSpeech ? resolveCharacterConversationSeed(context) : null;
  const characterRoleplayCue = situation.isSpeech || situation.isPriorityAnswer
    ? resolveCharacterRoleplayCue(context, { conversationMode })
    : null;
  const decisionTaskText = situation.isVote
    ? voteDecisionSection(context, decision)
    : situation.isAttackTask
      ? attackDecisionSection(context, decision)
      : '';
  const partnerDispositionPolicy = player.strategyProfile === 'wolf'
    ? resolveWolfPartnerDispositionPolicy({
      actorId: player.id,
      knownWolfIds: player.knowledge?.knownWolfIds ?? [],
      alivePlayerIds: context.board.alive.map((item) => item.id),
    })
    : null;
  const historyTimeline = selectPublicHistoryTimeline(context, decision, sectionPolicy.publicHistoryMode, {
    preserveEventSequences: internalReasoningDirective?.anchorEventSequences ?? [],
  });
  const latestOwnSpeechBeforeDelta = selectLatestOwnSpeechBeforeDelta(
    context,
    decision,
    sectionPolicy.publicHistoryMode,
    historyTimeline,
  );
  const latestOwnSpeech = [...(context.board.publicTimeline?.speeches ?? [])]
    .filter((event) => event.actorId === player.id && event.payload?.speechKind === 'normal')
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
    .at(-1) ?? null;
  const history = publicHistoryData(context, historyTimeline, {
    excludeSpeechEventId: situation.isSpeech && sectionPolicy.publicHistoryMode !== 'delta'
      ? latestOwnSpeech?.id ?? null
      : null,
  });
  const responseExampleReferences = buildResponseExampleReferences(state, context);
  const currentTask = currentTaskData(context, taskType, { decision });
  const factionStrategyProfile = player.strategyProfile ?? player.roleId;
  const latestFactionStrategy = {
    profile: factionStrategyProfile,
    ...Object.fromEntries(
      getFactionStrategyResponseFields(factionStrategyProfile, partnerDispositionPolicy)
        .map((key) => [key, String(player.factionStrategyState?.[key] ?? '').trim()])
        .filter(([, value]) => value),
    ),
  };
  const systemMemory = formatMemoryLedgerSnapshotForPrompt(player.memoryLedger, (id) => playerName(context, id))
    .filter((section) => section.label !== '秘密の確定情報');
  const ownClaimConsistency = sectionPolicy.showOwnPublicClaimConsistency
    ? ownPublicClaimConsistency(context, decision)
    : '';
  const otherClaimContradictions = sectionPolicy.showOwnPublicClaimConsistency
    ? otherPublicClaimContradictions(context, decision)
    : '';

  return {
    runtime: {
      appVersion: APP_VERSION,
      buildId: BUILD_ID,
      promptSpecVersion: PROMPT_SPEC_VERSION,
    },
    situation,
    sectionPolicy,
    playerDataBlock: sectionPolicy.showPlayerProfile
      ? renderPromptDataBlock('player', compactPromptValue({
        name: player.name,
        character: buildCharacterPromptProfile(player.character, {
          mode: sectionPolicy.characterProfileMode,
          roleplayCue: characterRoleplayCue,
        }),
      }))
      : '',
    callNameSection: sectionPolicy.callNameMode === 'full' ? callNameSection(context) : '',
    gameStateDataBlock: sectionPolicy.gameStateMode !== 'none'
      ? renderPromptDataBlock('game-state', compactPromptValue(gameStateData(context, { mode: sectionPolicy.gameStateMode })))
      : '',
    publicHistoryTitle: sectionPolicy.publicHistoryMode === 'delta'
      ? '前回の正常登録後に増えた公開会話・確定公開履歴'
      : sectionPolicy.publicHistoryMode === 'compact'
        ? '前回の正常回答登録以前の重要公開履歴と、それ以降に増えた全公開履歴'
        : sectionPolicy.publicHistoryMode === 'day'
          ? '現在Dayの公開会話・確定公開履歴'
          : sectionPolicy.publicHistoryMode === 'night-delta'
            ? '前回の正常登録後に増えた当日最終巡公開発言・確定公開履歴'
            : sectionPolicy.publicHistoryMode === 'night'
              ? '夜判断用の当日最終巡公開発言・確定公開履歴（CO・公開能力結果はゲーム状態も参照）'
              : 'これまでの公開会話・確定公開履歴（無圧縮）',
    latestOwnSpeechDataBlock: situation.isSpeech
      && sectionPolicy.publicHistoryMode !== 'delta'
      && latestOwnSpeech
      ? renderOptionalDataBlock('latest-own-public-speech', selfPublicContinuityData(context, latestOwnSpeech))
      : '',
    deltaSelfSpeechDataBlock: latestOwnSpeechBeforeDelta
      ? renderOptionalDataBlock('delta-self-public-continuity', selfPublicContinuityData(context, latestOwnSpeechBeforeDelta))
      : '',
    publicHistoryDataBlock: sectionPolicy.publicHistoryMode !== 'none'
      ? renderOptionalDataBlock('public-history', history)
      : '',
    daySpeechOrderPrinciple: sectionPolicy.showDaySpeechOrderPrinciple
      ? DAY_SPEECH_ORDER_PRINCIPLE_TEMPLATE
      : '',
    dayConversationStatusSection: sectionPolicy.showDayConversationStatus
      ? dayConversationStatusSection(context, taskType, { conversationMode })
      : '',
    claimTimingSection: sectionPolicy.showClaimTiming ? claimTimingSection(context) : '',
    internalReasoningDirective: situation.isSpeech
      ? renderInternalReasoningDirective(internalReasoningDirective, { isFirstDay })
      : '',
    characterConversationSection: situation.isSpeech
      ? renderOpeningConversationSection({ conversationMode, openingIntent, characterConversation })
      : '',
    currentTaskDataBlock: renderOptionalDataBlock('current-task', currentTask),
    taskInvariantInstruction: renderTaskInvariantInstruction({ taskType, firstDaySparseEvidence }),
    taskVariableInstruction: renderTaskVariableInstruction({
      taskType,
      wolfConversationPurpose: context.task.wolfConversationPurpose,
      voteType: context.game.vote?.type ?? null,
      badChildRoleNames,
      hasRequiredAnswers: Boolean(currentTask?.requiredAnswers?.length),
      hasRoleplayCue: Boolean(characterRoleplayCue),
      publicSpeechGuidance,
    }),
    publicSpeechGuidance,
    reasoningPolicy: sectionPolicy.showReasoningPolicy ? renderRuntimeReasoningPolicy() : '',
    // 投票では全ターン共通なので不変区画、最終巡の通常発言・優先回答では会話段階依存なので可変区画へ置く。
    executionValuePolicy: situation.isVote ? renderExecutionValueSemanticRules() : '',
    executionVariablePolicy: situation.isFinalDiscussionDecisionWindow
      ? renderExecutionValueSemanticRules()
      : '',
    executionFactionPolicy: sectionPolicy.showExecutionValuePolicy
      ? renderFactionExecutionValueSemanticRules({ team: player.team })
      : '',
    roleGuidance: sectionPolicy.showRoleGuidance ? renderRoleGuidance(context, { taskType }) : '',
    privateInformationDataBlock: sectionPolicy.privateInformationMode !== 'none'
      ? renderOptionalDataBlock('private-information', privateInformation(context, {
        mode: sectionPolicy.privateInformationMode,
      }))
      : '',
    ownHistoryDataBlock: sectionPolicy.ownHistoryMode !== 'none'
      ? renderOptionalDataBlock('own-history', ownHistory(context, {
        mode: sectionPolicy.ownHistoryMode,
      }))
      : '',
    latestDecisionDataBlock: sectionPolicy.showLatestDecision
      ? renderOptionalDataBlock('previous-decision-state', latestDecisionState(context, decision, { taskType }))
      : '',
    decisionInvalidationDataBlock: sectionPolicy.showLatestDecision
      ? renderOptionalDataBlock('decision-invalidation', decisionInvalidationState(context))
      : '',
    latestFactionStrategyDataBlock: sectionPolicy.showLatestFactionStrategy
      && context.player.factionStrategyState?.updatedAt
      ? renderOptionalDataBlock('faction-strategy-state', latestFactionStrategy)
      : '',
    discussionReconsideration: sectionPolicy.showDiscussionReconsideration
      ? discussionReconsideration(context, decision)
      : '',
    roleDecisionSection: sectionPolicy.showRoleDecision
      ? roleDecisionSection(context, taskType, {
        sectionPolicy,
        partnerDispositionPolicy,
        counterClaimOpportunity,
        ownerClaimCorroborationOpportunity,
      })
      : '',
    abilityClaimTimelineSection: sectionPolicy.showAbilityClaimTimeline
      ? abilityClaimTimelineSection(context, situation, claimRolePolicy, {
        counterClaimOpportunity,
        ownerClaimCorroborationOpportunity,
      })
      : '',
    systemMemoryDataBlock: sectionPolicy.showSystemMemory
      ? renderOptionalDataBlock('system-memory', systemMemory)
      : '',
    internalMemoryDataBlock: sectionPolicy.showInternalMemory
      ? renderOptionalDataBlock('internal-memory', formatInternalMemoryText(player) || null)
      : '',
    graveyardConversationSection: sectionPolicy.showGraveyardCommunication ? graveyardCommunicationSection(context) : '',
    masonConversationSection: sectionPolicy.showSharedCommunication ? masonCommunicationSection(context) : '',
    wolfConversationSection: sectionPolicy.showWolfSharedCommunication ? wolfCommunicationSection(context) : '',
    decisionPopulationSection: sectionPolicy.showPopulation ? populationSection(context, decision) : '',
    decisionTaskSection: decisionTaskText,
    factionClaimBranchSection: sectionPolicy.showMadmanClaimBranch
      ? madmanClaimBranchSection(context, taskType)
      : '',
    ownPublicClaimConsistencySection: ownClaimConsistency === 'あなた自身が公開した能力結果主張はありません。'
      ? ''
      : ownClaimConsistency,
    otherPublicClaimContradictionsSection: otherClaimContradictions,
    responseFormatOptions: {
      taskType,
      roleId: player.strategyProfile ?? player.roleId,
      openingSpeech,
      hasFox,
      hasCat,
      publicSpeechPolicy,
      maxPublicSpeechLength: rules.maxPublicSpeechLength ?? 450,
      maxWolfMessageLength: rules.maxWolfMessageLength ?? 450,
      maxMasonMessageLength: rules.maxMasonMessageLength ?? 450,
      maxGraveyardMessageLength: rules.maxGraveyardMessageLength ?? 450,
      maxHeartVoiceLength: rules.maxHeartVoiceLength ?? 120,
      maxInternalMemoLength: rules.maxInternalMemoLength ?? 3000,
      maxResultImpressionLength: MAX_RESULT_IMPRESSION_LENGTH,
      hasPreviousDecision: Boolean(player.decisionState?.updatedAt)
        && player.decisionInvalidation?.usablePreviousDecision !== false,
      hasPreviousFactionStrategy: Boolean(player.factionStrategyState?.updatedAt),
      partnerDispositionPolicy,
      factionStrategyUpdatePolicy,
      claimRolePolicy: responseClaimRolePolicy,
      freezeEstimateLimit: taskType === 'freeze' ? resolveSnowWomanEstimateLimit(context.task.validTargetIds.length) : null,
      wolfConversationPurpose: context.task.wolfConversationPurpose ?? null,
      attackAlternativeAvailable: taskType === 'wolf-attack'
        ? context.task.validTargetIds.length > 1
        : true,
      exampleReferences: responseExampleReferences,
      decisionPatchRequired: Boolean(player.decisionInvalidation?.requiresReevaluation),
    },
  };
}

function finalizeResponsePromptModel(model) {
  const options = model.responseFormatOptions;
  model.responseFormat = renderResponseFormat(options);
  model.finalResponseReminder = renderFinalResponseReminder(options);
  delete model.responseFormatOptions;
  return model;
}

export function buildPromptContext(state, playerId, {
  taskType = 'speech',
  validTargetIds = [],
  slotId = '',
  publicHistoryTransmissionMode = 'compact',
  forceFullPublicHistory = false,
} = {}) {
  const context = buildPlayerVisibleContext(state, playerId, { taskType, validTargetIds, slotId });
  const player = context.player;
  const preValidation = validatePromptVisibility(context);
  if (!preValidation.ok) throw new Error(`プロンプト情報隔離エラー:\n${preValidation.errors.join('\n')}`);
  if (taskType === 'graveyard-conversation' && !context.graveyardCommunication.current) {
    throw new Error('このプレイヤーは現在の墓場会話へ参加できません。');
  }
  if (taskType === 'mason-conversation' && !context.masonCommunication.current) {
    throw new Error('このプレイヤーは現在の共有者共有会話へ参加できません。');
  }
  if (taskType === 'wolf-conversation' && !context.wolfCommunication.current) {
    throw new Error('このプレイヤーは現在の人狼共有会話へ参加できません。');
  }
  const latestSuccessfulTurn = findLatestNormalAiRegistrationTurn(state, playerId);
  const historyCursorSequence = latestSuccessfulTurn?.publicSequenceAtRegistration ?? null;
  const publicHistoryPolicy = {
    transmissionMode: normalizePublicHistoryTransmissionMode(publicHistoryTransmissionMode),
    hasHistoryCursor: Number.isInteger(historyCursorSequence),
    forceFull: Boolean(forceFullPublicHistory),
  };
  const counterClaimOpportunity = resolveCounterClaimOpportunity(state, {
    playerId,
    taskType,
    sinceSequence: historyCursorSequence,
  });
  const ownerClaimCorroborationOpportunity = resolveOwnerClaimCorroborationOpportunity(state, {
    playerId,
    taskType,
    sinceSequence: historyCursorSequence,
  });
  const decision = buildDecisionContext(context, taskType, { historyCursorSequence });
  const conversationMode = isNormalSpeechTask(taskType)
    ? resolveOpeningConversationMode(context)
    : OPENING_CONVERSATION_MODES.NORMAL;
  const internalReasoningDirective = isNormalSpeechTask(taskType)
    ? resolveInternalReasoningDirective(state, context, { conversationMode })
    : null;
  const factionStrategyUpdatePolicy = resolveFactionStrategyUpdatePolicy(state, {
    playerId,
    taskType,
  });
  const includeInitial = taskType === 'briefing';
  const model = finalizeResponsePromptModel(buildPromptModel(context, decision, {
    state,
    taskType,
    internalReasoningDirective,
    factionStrategyUpdatePolicy,
    includeInitial,
    publicHistoryPolicy,
    counterClaimOpportunity,
    ownerClaimCorroborationOpportunity,
  }));
  const fingerprint = createPromptContextFingerprint({
    context,
    decision,
    publicHistoryPolicy,
    promptSpecVersion: PROMPT_SPEC_VERSION,
  });
  // 固定人物像・本人役職・呼称はstablePlayerContextを正本とし、動的タスク側へ重複掲載しない。
  model.playerDataBlock = '';
  model.callNameSection = '';
  const taskInvariantContext = renderTaskInvariantPrompt(model);
  const taskVariableContext = renderTaskVariablePrompt(model);
  const runtimeText = renderDynamicTaskPrompt(model);
  const briefingSections = includeInitial ? ROLE_BRIEFING_TEMPLATE : '';
  const dynamicTaskPrompt = includeInitial
    ? `${briefingSections}\n\n---\n\n${runtimeText}`
    : runtimeText;
  const promptEnvelope = buildPromptEnvelope({
    state,
    context,
    commonSystemInstruction: taskType === 'briefing' ? BRIEFING_AI_SYSTEM_INSTRUCTION : PERSISTENT_AI_SYSTEM_INSTRUCTION,
    taskInvariantContext,
    taskVariableContext,
    dynamicTaskPrompt,
    structuredOutput: buildStructuredOutputContract(state, { taskType, playerId, validTargetIds }),
    promptFamily: taskType === 'briefing' ? 'role-briefing' : 'game-candidate',
    stablePlayerContextPolicy: {
      showPlayerProfile: model.sectionPolicy.showPlayerProfile,
      callNameMode: model.sectionPolicy.callNameMode,
    },
  });
  const text = promptEnvelope.combinedText;
  const postValidation = validatePromptVisibility(context, text);
  if (!postValidation.ok) throw new Error(`プロンプト情報隔離エラー:\n${postValidation.errors.join('\n')}`);
  const promptMode = taskType === 'briefing' ? 'initial' : 'runtime';
  const publicSequenceAtGeneration = Math.max(0, ...Object.values(context.board.publicTimeline)
    .flat()
    .map((event) => Number(event.sequence ?? 0)));
  return {
    text,
    promptEnvelope,
    systemInstruction: taskType === 'briefing' ? BRIEFING_AI_SYSTEM_INSTRUCTION : PERSISTENT_AI_SYSTEM_INSTRUCTION,
    fingerprint,
    mode: getResponseModeForTask(taskType),
    promptMode,
    includeInitial,
    publicSequenceAtGeneration,
    publicHistoryMode: model.sectionPolicy.publicHistoryMode,
    context,
    decision,
    internalReasoningDirective,
    generationGuidance: Object.freeze({
      roleGuidance: model.roleGuidance,
      roleDecision: model.roleDecisionSection,
      claimTiming: model.claimTimingSection,
      reasoningPolicy: model.reasoningPolicy,
      executionValuePolicy: model.executionValuePolicy || model.executionVariablePolicy,
      executionFactionPolicy: model.executionFactionPolicy,
      factionClaimBranch: model.factionClaimBranchSection,
      ownPublicClaimConsistency: model.ownPublicClaimConsistencySection,
      otherPublicClaimContradictions: model.otherPublicClaimContradictionsSection,
      ...(model.publicSpeechGuidance ? { publicSpeechGuidance: model.publicSpeechGuidance } : {}),
    }),
    diagnostics: {
      appVersion: APP_VERSION,
      buildId: BUILD_ID,
      promptSpecVersion: PROMPT_SPEC_VERSION,
      visibilityAudit: '正常',
      aliveCount: decision.population.aliveCount,
      factionStrategyUpdateTriggers: [...(factionStrategyUpdatePolicy.triggers ?? [])],
      strategyOpportunityTypes: [counterClaimOpportunity?.type, ownerClaimCorroborationOpportunity?.type].filter(Boolean),
      majorityThreshold: decision.population.majorityThreshold,
      publicHistoryMode: model.sectionPolicy.publicHistoryMode,
      historyCursorSequence,
      promptEnvelope: { ...promptEnvelope.diagnostics },
    },
  };
}
