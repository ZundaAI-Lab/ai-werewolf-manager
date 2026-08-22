/**
 * 責務: 初期3巡設定の1ゲーム通しテストと1人間プレイヤー通しテストを、デモAIの生回答・パーサー・検証器・登録コマンド・保存状態検証まで改変せず接続して実行する。
 * 変更ルール: 初期ルールを短縮せず、AI回答をダミーJSONへ置換・後加工せず、検証失敗をGM代理・ランダム登録で回避しない。生成された生回答をそのまま解析・意味検証・登録・完全状態検証・JSON再読込まで通す。任意項目の出力数は品質資料として集計するだけで合否条件にせず、出力された項目は解析・保存・再読込まで確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { markBriefingShown, acknowledgeRole } from '../../../app/renderer/js/domain/briefing/briefingCommands.js';
import { recordAiSpeech, recordHumanSpeech } from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import { startGame } from '../../../app/renderer/js/domain/game/gameCommands.js';
import { getCurrentGmTask } from '../../../app/renderer/js/domain/game/workflow.js';
import {
  publishDawn,
  recordMasonMessage,
  recordNightAction,
  recordWolfAttackVote,
  recordWolfMessage,
  resolveNight,
} from '../../../app/renderer/js/domain/night/nightCommands.js';
import {
  acknowledgePrivateResults,
  confirmGameResult,
  publishGameResult,
  recordResultImpression,
} from '../../../app/renderer/js/domain/result/resultCommands.js';
import {
  getAttackCandidates,
  getNightActionCandidates,
  getVoteCandidates,
} from '../../../app/renderer/js/domain/game/standardRules.js';
import {
  beginVote,
  finalizeVote,
  publishExecution,
  publishVoteResult,
  recordVote,
  resolveExecution,
} from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import { parseAiResponse } from '../../../app/renderer/js/prompts/response/responseParser.js';
import { validateAiResponse } from '../../../app/renderer/js/prompts/response/responseValidator.js';
import { SCHEMA_VERSION } from '../../../app/renderer/js/config/constants.js';
import { PERSONAL_NIGHT_ACTION_TASK_TYPES, isPersonalNightActionTask } from '../../../app/renderer/js/config/personalNightActionTasks.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { prepareImportedState } from '../../../app/renderer/js/state/stateImport.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';
import { prepareAiTask, evaluateAiTaskCandidate } from '../../../app/renderer/js/services/aiTaskService.js';
import { resolveGenerationPlan } from '../../../app/renderer/js/services/generationDepthPolicy.js';
import { runGenerationPipeline } from '../../../app/renderer/js/services/generationPipeline.js';
import { resolveGenerationStagePromptPolicy } from '../../../app/renderer/js/prompts/stages/generationStagePromptPolicy.js';
import { buildDraftStagePrompt, buildRenderStagePrompt, buildProofreadStagePrompt } from '../../../app/renderer/js/prompts/stages/generationStagePromptBuilder.js';
import { inspectPromptDataBlocks } from '../../../app/renderer/js/prompts/serialization/promptDataSerializer.js';

const require = createRequire(import.meta.url);
const demoAi = require('../../../app/shared/demoAi.js');
const AI_RESPONSE_TASKS = Object.freeze([
  'speech', 'vote', 'wolf-attack',
  ...PERSONAL_NIGHT_ACTION_TASK_TYPES,
  'mason-conversation', 'wolf-conversation', 'result-impression',
]);


function assertOk(response, label) {
  assert.equal(response?.ok, true, `${label}: ${response?.message ?? '応答なし'}`);
}

function assertValidState(state, label) {
  const validation = validateImportedState(state);
  assert.equal(validation.ok, true, `${label}: ${validation.errors.join(' / ')}`);
}

function validTargetIds(state, taskType, playerId) {
  if (taskType === 'vote') {
    return getVoteCandidates(state, playerId, state.voteSession.candidateIds).map((player) => player.id);
  }
  if (isPersonalNightActionTask(taskType)) {
    return getNightActionCandidates(state, taskType, playerId).map((player) => player.id);
  }
  if (['wolf-conversation', 'wolf-attack'].includes(taskType)) {
    return getAttackCandidates(state).map((player) => player.id);
  }
  return [];
}

function currentConversationSpeakerId(state, taskType) {
  const isWolf = taskType === 'wolf-conversation';
  const sessionId = isWolf ? state.night?.wolfConversationId : state.night?.masonConversationId;
  const sessions = isWolf ? state.wolfConversations : state.masonConversations;
  const session = sessions.find((item) => item.id === sessionId);
  assert.ok(session, `${taskType}の会話セッションが存在する`);
  const playerId = session.participantIds.find((id) => Number(session.remainingByParticipant[id] ?? 0) > 0);
  assert.ok(playerId, `${taskType}の発言可能者が存在する`);
  return playerId;
}

function isPopulated(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function promptDataValue(promptText, name) {
  const inspection = inspectPromptDataBlocks(promptText);
  assert.equal(inspection.ok, true, inspection.errors.join(' / '));
  return inspection.blocks.find((block) => block.name === name)?.value ?? null;
}

function parsePromptResponseExample(promptText) {
  const text = String(promptText ?? '');
  const end = text.lastIndexOf('\n\n出力制約:');
  if (end < 0) return {};
  const start = text.lastIndexOf('\n{', end);
  if (start < 0) return {};
  try {
    return JSON.parse(text.slice(start + 1, end));
  } catch {
    return {};
  }
}

function summarizeStructuredOutputs(state) {
  const fields = [
    ['heartVoice', 'parsedHeartVoice'],
    ['decisionUpdate', 'parsedDecisionUpdate'],
    ['factionStrategy', 'parsedFactionStrategyPatch'],
    ['sharedStrategy', 'parsedSharedStrategyPatch'],
    ['internalMemoUpdate', 'parsedInternalMemoUpdate'],
    ['attackAssessment', 'parsedAttackAssessment'],
    ['speechInteraction', 'parsedSpeechInteraction'],
    ['coOperation', 'parsedCoOperation'],
    ['abilityClaims', 'parsedAbilityClaims'],
    ['selectionBasis', 'resolvedAbilityClaims'],
    ['evidenceRefs', 'resolvedAbilityClaims'],
    ['selectionReasonAtTime', 'resolvedAbilityClaims'],
    ['estimatedWerewolfIds', 'estimatedWerewolfIds'],
    ['predictedAttackTargetIds', 'predictedAttackTargetIds'],
  ];
  const result = Object.fromEntries(fields.map(([field]) => [field, {
    available: 0,
    output: 0,
    saved: 0,
    empty: 0,
    rePresented: 0,
  }]));

  state.aiTurns.forEach((turn, index) => {
    const example = parsePromptResponseExample(turn.promptText);
    let raw = {};
    try { raw = JSON.parse(turn.rawResponse); } catch { raw = {}; }
    fields.forEach(([field, savedKey]) => {
      const metric = result[field];
      const abilityClaimExample = example.abilityClaims?.claims?.[0] ?? null;
      const abilityClaimOutput = raw.abilityClaims?.claims?.[0] ?? null;
      const isAbilitySelectionField = ['selectionBasis', 'evidenceRefs', 'selectionReasonAtTime'].includes(field);
      const available = isAbilitySelectionField
        ? Boolean(abilityClaimExample && Object.hasOwn(abilityClaimExample, field))
        : Object.hasOwn(example, field);
      if (available) metric.available += 1;
      const hasOutput = isAbilitySelectionField
        ? Boolean(abilityClaimOutput && Object.hasOwn(abilityClaimOutput, field))
        : Object.hasOwn(raw, field);
      if (!hasOutput) return;
      metric.output += 1;
      const outputValue = isAbilitySelectionField ? abilityClaimOutput[field] : raw[field];
      const savedValue = isAbilitySelectionField
        ? turn.resolvedAbilityClaims?.[0]?.[field === 'evidenceRefs' ? 'evidenceEventIds' : field]
        : turn[savedKey];
      if (isPopulated(outputValue)) {
        if (isPopulated(savedValue)) metric.saved += 1;
      } else {
        metric.empty += 1;
      }
      if (!['decisionUpdate', 'factionStrategy', 'sharedStrategy', 'internalMemoUpdate'].includes(field)) return;
      let representative = '';
      if (field === 'internalMemoUpdate') representative = String(raw[field]?.text ?? '');
      if (field === 'decisionUpdate') representative = String(raw[field]?.decisionReason ?? '');
      if (['factionStrategy', 'sharedStrategy'].includes(field)) {
        representative = Object.values(raw[field]?.changes ?? {}).find((value) => typeof value === 'string' && value.trim()) ?? '';
      }
      if (!representative) return;
      const laterPrompt = state.aiTurns.slice(index + 1)
        .filter((later) => later.playerId === turn.playerId)
        .map((later) => later.promptText)
        .join('\n');
      if (laterPrompt.includes(representative)) metric.rePresented += 1;
    });
  });
  return result;
}

function assertStructuredFieldsSaved(state, parsed, validation) {
  const turn = state.aiTurns.at(-1);
  assert.ok(turn, 'AI回答がAIターンへ保存される');
  if (parsed.heartVoice !== undefined) assert.equal(turn.parsedHeartVoice, parsed.heartVoice);
  if (parsed.internalMemoUpdate) assert.deepEqual(turn.parsedInternalMemoUpdate, parsed.internalMemoUpdate);
  if (parsed.decisionUpdate) {
    assert.deepEqual(turn.parsedDecisionUpdate, parsed.decisionUpdate);
    assert.ok(turn.resolvedDecisionUpdate, '出力された判断更新を解決済み状態へ保存する');
  }
  if (parsed.factionStrategyPatch) {
    assert.deepEqual(turn.parsedFactionStrategyPatch, parsed.factionStrategyPatch);
    assert.ok(turn.resolvedFactionStrategyState, '出力された陣営戦略を解決済み状態へ保存する');
  }
  if (parsed.sharedStrategyPatch) assert.deepEqual(turn.parsedSharedStrategyPatch, parsed.sharedStrategyPatch);
  if (parsed.attackAssessment) {
    assert.deepEqual(turn.parsedAttackAssessment, parsed.attackAssessment);
    assert.ok(turn.resolvedAttackAssessment, '出力された襲撃評価を解決済み状態へ保存する');
  }
  if (parsed.speechInteraction) assert.deepEqual(turn.parsedSpeechInteraction, parsed.speechInteraction);
  if (parsed.coOperation) assert.deepEqual(turn.parsedCoOperation, parsed.coOperation);
  if (parsed.abilityClaims) assert.deepEqual(turn.parsedAbilityClaims, validation.normalizedParsedAbilityClaims);
}



function buildAiCommonInput(built, rawResponse, parsed, validation, generationRun = null) {
  return {
    rawResponse,
    promptText: built.text,
    promptFingerprint: built.fingerprint,
    promptMode: built.promptMode,
    publicSequenceAtGeneration: built.publicSequenceAtGeneration,
    resolvedInternalReasoningDirective: built.internalReasoningDirective ?? null,
    heartVoice: parsed.heartVoice,
    internalMemoUpdate: parsed.internalMemoUpdate,
    selectionRationale: parsed.selectionRationale,
    parsedAttackAssessment: parsed.attackAssessment,
    resolvedAttackAssessment: validation.resolvedAttackAssessment,
    estimatedWerewolfIds: validation.resolvedFreezeEstimates?.estimatedWerewolfIds ?? [],
    predictedAttackTargetIds: validation.resolvedFreezeEstimates?.predictedAttackTargetIds ?? [],
    parsedFactionStrategyPatch: parsed.factionStrategyPatch,
    factionStrategyPatch: validation.resolvedFactionStrategyState,
    warnings: validation.warnings,
    generationRun,
  };
}

async function executeAiResponsePipeline(state, { taskType, playerId, slotId = '', generationDepth = 1 }) {
  const player = state.players.find((item) => item.id === playerId);
  assert.ok(player, `${taskType}のAIプレイヤーが存在する`);
  assert.equal(player.controller, 'ai', `${player.name}はAI制御である`);

  const built = prepareAiTask(state, { playerId, taskType, slotId });
  let resultPromptAudit = null;
  if (taskType === 'result-impression') {
    const currentTask = promptDataValue(built.text, 'current-task');
    assert.ok(currentTask, '感想プロンプトへ現在タスク情報を含める');
    assert.equal(currentTask.allRoles.length, state.players.length, '全員の公開役職一覧を従来どおり維持する');
    assert.ok(currentTask.gameResult?.winner, '感想プロンプトへ勝敗を含める');
    assert.ok(currentTask.yourResult?.finalTeam && currentTask.yourResult?.result, '感想プロンプトへ本人の最終陣営と勝敗を含める');
    assert.equal(Object.hasOwn(currentTask, 'speaker'), false, '共通話者情報を感想専用データへ重複投入しない');
    assert.equal(Object.hasOwn(currentTask, 'speakerJourney'), false, '通常会話・本人投票の独立履歴を感想専用データへ残さない');
    assert.equal(Object.hasOwn(currentTask, 'voteResult'), false, '旧最終投票ブロックを重複投入しない');
    assert.equal(Object.hasOwn(currentTask, 'nightResult'), false, '旧最終夜明けブロックを重複投入しない');
    const flowEvents = (currentTask.gameFlow ?? []).flatMap((section) => section.events ?? []);
    assert.ok(
      flowEvents.some((event) => ['execution-result', 'night-result'].includes(event.type)),
      '感想プロンプトへ処刑・夜の確定結果を含める',
    );
    assert.ok(
      flowEvents.every((event) => ['role-claim', 'ability-result', 'execution-result', 'night-result'].includes(event.type)),
      '感想用経過をCO・能力結果・処刑・夜結果だけに限定する',
    );
    resultPromptAudit = {
      playerWasDead: !player.alive,
      hasAfterExitFlow: (currentTask.gameFlow ?? []).some((section) => section.knowledgeTiming === 'after-exit'),
    };
  }
  const ownerProfile = {
    id: 'profile-demo',
    label: 'デモAI',
    enabled: true,
    generation: { depth: generationDepth },
  };
  const plan = resolveGenerationPlan({ ownerProfile, profiles: [ownerProfile], taskType });
  const textStagePrompts = [];
  const pipeline = await runGenerationPipeline({
    plan,
    taskArtifact: built,
    evaluateCandidate: (rawResponse) => evaluateAiTaskCandidate(state, built, rawResponse),
    resolveStagePromptPolicy: resolveGenerationStagePromptPolicy,
    buildDraftPrompt: buildDraftStagePrompt,
    buildRenderPrompt: buildRenderStagePrompt,
    buildProofreadPrompt: buildProofreadStagePrompt,
    requestFullCandidate: async ({ stage, prompt }) => {
      const rawResponse = demoAi.generate({
        prompt,
        taskType,
        playerName: player.name,
        requestPurpose: stage.stageId === 'draft' ? 'generation-draft' : 'normal',
      });
      const evaluation = evaluateAiTaskCandidate(state, built, rawResponse);
      return {
        ok: evaluation.ok,
        rawResponse,
        evaluation,
        attemptCount: 1,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
        issues: evaluation.issues,
      };
    },
    requestTextPatch: async ({ stage, prompt }) => {
      textStagePrompts.push({ stageId: stage.stageId, length: prompt.length, prompt });
      return {
        ok: true,
        rawResponse: demoAi.generate({
          prompt,
          taskType,
          playerName: player.name,
          requestPurpose: stage.stageId === 'render' ? 'generation-render' : 'generation-proofread',
        }),
        attemptCount: 1,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
        issues: [],
      };
    },
  });
  assert.equal(pipeline.ok, true, `${player.name}/${taskType}/深度${generationDepth}の生成パイプラインが成功する`);
  const rawResponse = pipeline.rawResponse;
  const parsed = pipeline.evaluation.parsed;
  const validation = pipeline.evaluation.validation;
  assert.equal(validation.ok, true, `${player.name}/${taskType}: ${validation.errors.join(' / ')}\nAI回答: ${rawResponse}`);

  const common = buildAiCommonInput(built, rawResponse, parsed, validation, pipeline.generationRun);
  let response;
  if (taskType === 'speech') {
    response = recordAiSpeech(state, {
      playerId,
      content: parsed.publicSpeech,
      heartVoice: common.heartVoice,
      internalMemoUpdate: common.internalMemoUpdate,
      rawResponse: common.rawResponse,
      generationRun: common.generationRun,
      promptText: common.promptText,
      promptFingerprint: common.promptFingerprint,
      promptMode: common.promptMode,
      publicSequenceAtGeneration: common.publicSequenceAtGeneration,
      warnings: common.warnings,
      coOperation: parsed.coOperation,
      parsedSpeechInteraction: parsed.speechInteraction,
      speechInteraction: validation.resolvedSpeechInteraction,
      parsedAbilityClaims: validation.normalizedParsedAbilityClaims,
      abilityClaims: validation.resolvedAbilityClaims,
      parsedDecisionUpdate: parsed.decisionUpdate,
      decisionUpdate: validation.resolvedDecisionUpdate,
      parsedFactionStrategyPatch: common.parsedFactionStrategyPatch,
      factionStrategyPatch: common.factionStrategyPatch,
      resolvedInternalReasoningDirective: common.resolvedInternalReasoningDirective,
    });
  } else if (taskType === 'vote') {
    response = recordVote(state, {
      voterId: playerId,
      targetId: validation.resolvedAction.id,
      parsedDecisionUpdate: parsed.decisionUpdate,
      decisionUpdate: validation.resolvedDecisionUpdate,
      ...common,
    });
  } else if (isPersonalNightActionTask(taskType)) {
    response = recordNightAction(state, {
      slotId,
      actorId: playerId,
      targetId: validation.resolvedAction.id,
      ...common,
    });
  } else if (taskType === 'wolf-attack') {
    response = recordWolfAttackVote(state, {
      actorId: playerId,
      targetId: validation.resolvedAction.id,
      ...common,
    });
  } else if (taskType === 'mason-conversation') {
    response = recordMasonMessage(state, {
      speakerId: playerId,
      content: parsed.masonMessage,
      parsedDecisionUpdate: parsed.decisionUpdate,
      decisionUpdate: validation.resolvedDecisionUpdate,
      ...common,
    });
  } else if (taskType === 'wolf-conversation') {
    response = recordWolfMessage(state, {
      speakerId: playerId,
      content: parsed.wolfMessage,
      sharedStrategyPatch: parsed.sharedStrategyPatch,
      ...common,
    });
  } else if (taskType === 'result-impression') {
    response = recordResultImpression(state, {
      playerId,
      content: parsed.publicSpeech,
      ...common,
    });
  } else {
    assert.fail(`未対応のAIタスクです: ${taskType}`);
  }

  assertOk(response, `${player.name}/${taskType}登録`);
  assertStructuredFieldsSaved(state, parsed, validation);
  assertValidState(state, `${player.name}/${taskType}保存後`);
  const storedTurn = state.aiTurns.at(-1);
  assert.equal(storedTurn.generationRun.depth, generationDepth);
  assert.equal(storedTurn.generationRun.taskCategory, plan.taskCategory);
  assert.equal(storedTurn.generationRun.stages.length, plan.stages.length);
  assert.equal(storedTurn.rawResponse, rawResponse, '中間回答ではなく最終候補だけをAIターンへ保存する');
  return {
    taskType,
    playerId,
    day: Number(built.context.game.day),
    prompt: built.text,
    rawResponse,
    hasTruncatedPublicHistory: built.text.includes('"historyDetail"'),
    textStagePrompts,
    resultPromptAudit: resultPromptAudit ? (() => {
      const renderStageExpected = plan.stages.some((stage) => stage.stageId === 'render');
      const renderPrompts = textStagePrompts.filter((item) => item.stageId === 'render');
      return {
        ...resultPromptAudit,
        renderStageExpected,
        renderStagePromptCount: renderPrompts.length,
        usesConsolidatedStageSummary: renderStageExpected
          ? renderPrompts.length > 0
            && renderPrompts.every((item) => item.prompt.includes('resultSummary') && !item.prompt.includes('recentOutcomeSummary'))
          : renderPrompts.length === 0,
      };
    })() : null,
  };
}

function executeHumanTask(state, task, humanId) {
  assert.equal(task.playerId, humanId, '人間タスクは指定した人間プレイヤー本人のもの');
  const player = state.players.find((item) => item.id === humanId);
  if (task.type === 'speech') {
    return recordHumanSpeech(state, {
      playerId: humanId,
      content: `${player.name}の人間入力です。#1を確認しつつ自由に発言します。`,
      coOperation: { action: 'none', roleId: 'none' },
    });
  }
  if (task.type === 'vote') {
    const target = getVoteCandidates(state, humanId, state.voteSession.candidateIds)[0];
    assert.ok(target, '人間投票の有効対象が存在する');
    return recordVote(state, { voterId: humanId, targetId: target.id });
  }
  if (task.type === 'result-impression') {
    return recordResultImpression(state, {
      playerId: humanId,
      content: '人間プレイヤーとして最後まで参加しました。',
    });
  }
  const targetId = validTargetIds(state, task.type, humanId)[0];
  assert.ok(targetId, `${task.type}の人間向け有効対象が存在する`);
  if (task.type === 'wolf-attack') {
    return recordWolfAttackVote(state, {
      actorId: humanId,
      targetId,
      selectionRationale: '人間が専用操作で明示選択した。',
    });
  }
  if (PERSONAL_NIGHT_TASKS.includes(task.type)) {
    return recordNightAction(state, {
      slotId: task.slotId,
      actorId: humanId,
      targetId,
      selectionRationale: '人間が専用操作で明示選択した。',
    });
  }
  assert.fail(`未対応の人間タスクです: ${task.type}`);
}

function recordPromptMetrics(metrics, execution) {
  if (!execution) return;
  if (execution.hasTruncatedPublicHistory) metrics.truncatedPublicHistoryPromptCount += 1;
  if (execution.resultPromptAudit) {
    metrics.resultPromptCount += 1;
    assert.equal(execution.resultPromptAudit.usesConsolidatedStageSummary, true, '感想の文章工程は統合済みresultSummaryだけを参照する');
    if (execution.resultPromptAudit.renderStageExpected) {
      assert.ok(execution.resultPromptAudit.renderStagePromptCount > 0, '深度3・4の感想では発言化工程を実際に実行する');
      metrics.deepResultRenderPromptCount += execution.resultPromptAudit.renderStagePromptCount;
    }
    if (execution.resultPromptAudit.playerWasDead && execution.resultPromptAudit.hasAfterExitFlow) {
      metrics.earlyExitResultPromptCount += 1;
    }
  }
  for (const stagePrompt of execution.textStagePrompts ?? []) {
    if (stagePrompt.stageId === 'proofread') metrics.proofreadPromptLengths.push(stagePrompt.length);
  }
  if (execution.taskType !== 'speech') return;
  const key = String(execution.day);
  if (!metrics.speechPromptLengthsByDay[key]) metrics.speechPromptLengthsByDay[key] = [];
  metrics.speechPromptLengthsByDay[key].push(execution.prompt.length);
}

function summarizePromptLengths(lengthsByDay) {
  return Object.fromEntries(Object.entries(lengthsByDay).map(([day, lengths]) => [day, {
    count: lengths.length,
    average: lengths.length ? Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length) : 0,
    max: lengths.length ? Math.max(...lengths) : 0,
  }]));
}

function assertThreeRoundDiscussion(state, completedDays) {
  assert.equal(state.discussion.round, 3, `Day ${state.game.day}は初期設定どおり3巡完了する`);
  assert.ok(Object.values(state.discussion.remainingByPlayer).every((count) => count === 0));
  const publicSpeeches = state.events.filter((event) => (
    event.type === 'public-speech'
    && event.day === state.game.day
    && event.status === 'published'
    && event.audience?.type === 'public'
  ));
  const expectedSpeechCount = state.discussion.roundEligiblePlayerIds.length * 3;
  assert.equal(publicSpeeches.length, expectedSpeechCount, `Day ${state.game.day}は発言可能者全員が3回発言する`);
  completedDays.push({ day: state.game.day, round: state.discussion.round, speechCount: publicSpeeches.length });
}

async function runProductionPlaythrough({ humanPlayer = false, generationDepth = 1 } = {}) {
  const originalRandom = Math.random;
  Math.random = () => 0.137;
  try {
    const state = createInitialState(8);
    assert.equal(state.game.rules.speechCountPerDay, 3, '118版初期設定の議論巡数は3');
    const human = humanPlayer
      ? state.players.find((player) => player.roleId === 'villager') ?? state.players[0]
      : null;
    if (human) human.controller = 'human';

    assertOk(startGame(state), 'ゲーム開始');
    assertValidState(state, 'ゲーム開始後');

    const metrics = {
      humanPlayerId: human?.id ?? null,
      briefingPromptCount: 0,
      aiResponsePromptCount: 0,
      pipelineTaskCounts: {},
      completedDiscussionDays: [],
      humanPublicSpeechCount: 0,
      speechPromptLengthsByDay: {},
      proofreadPromptLengths: [],
      truncatedPublicHistoryPromptCount: 0,
      resultPromptCount: 0,
      deepResultRenderPromptCount: 0,
      earlyExitResultPromptCount: 0,
      steps: 0,
    };

    while (state.game.phase !== 'ended' && metrics.steps < 1000) {
      metrics.steps += 1;
      const task = getCurrentGmTask(state);

      if (task.type === 'briefing') {
        const built = buildPromptContext(state, task.playerId, { taskType: 'briefing', validTargetIds: [] });
        assert.match(built.text, /応答不要/u, '役職通知は118版既存契約どおり応答不要');
        metrics.briefingPromptCount += 1;
        assertOk(markBriefingShown(state, task.playerId), '役職通知表示');
        assertOk(acknowledgeRole(state, task.playerId), '役職通知確認');
      } else if (['mason-conversation', 'wolf-conversation'].includes(task.type)) {
        const playerId = currentConversationSpeakerId(state, task.type);
        const execution = await executeAiResponsePipeline(state, {
          taskType: task.type,
          playerId,
          generationDepth,
        });
        recordPromptMetrics(metrics, execution);
        metrics.aiResponsePromptCount += 1;
        metrics.pipelineTaskCounts[task.type] = Number(metrics.pipelineTaskCounts[task.type] ?? 0) + 1;
      } else if (AI_RESPONSE_TASKS.includes(task.type)) {
        const isHumanTask = human && task.playerId === human.id;
        if (isHumanTask) {
          const response = executeHumanTask(state, task, human.id);
          assertOk(response, `${human.name}/${task.type}人間登録`);
          if (task.type === 'speech') metrics.humanPublicSpeechCount += 1;
          assertValidState(state, `${human.name}/${task.type}人間保存後`);
        } else {
          const execution = await executeAiResponsePipeline(state, {
            taskType: task.type,
            playerId: task.playerId,
            slotId: task.slotId ?? '',
            generationDepth,
          });
          recordPromptMetrics(metrics, execution);
            metrics.aiResponsePromptCount += 1;
          metrics.pipelineTaskCounts[task.type] = Number(metrics.pipelineTaskCounts[task.type] ?? 0) + 1;
        }
      } else if (task.type === 'private-notification') {
        assertOk(acknowledgePrivateResults(state, task.playerId), '人間の本人限定結果確認');
      } else if (task.type === 'resolve-night') {
        assertOk(resolveNight(state, () => 0), '夜解決');
      } else if (task.type === 'publish-dawn') {
        assertOk(publishDawn(state), '夜明け公開');
      } else if (task.type === 'discussion-complete') {
        assertThreeRoundDiscussion(state, metrics.completedDiscussionDays);
        assertOk(beginVote(state), '投票開始');
      } else if (task.type === 'finalize-vote') {
        assertOk(finalizeVote(state, () => 0), '投票集計');
      } else if (task.type === 'publish-vote') {
        assertOk(publishVoteResult(state), '投票結果公開');
      } else if (task.type === 'resolve-execution') {
        assertOk(resolveExecution(state, () => 0), '処刑解決');
      } else if (task.type === 'publish-execution') {
        assertOk(publishExecution(state), '処刑公開');
      } else if (task.type === 'confirm-result') {
        assertOk(confirmGameResult(state), 'ゲーム結果確認');
      } else if (task.type === 'publish-result') {
        assertOk(publishGameResult(state), 'ゲーム結果公開');
      } else if (task.type === 'ended') {
        break;
      } else {
        assert.fail(`通しテスト未対応タスクです: ${task.type} / phase=${state.game.phase}`);
      }
      assertValidState(state, `通しテスト step ${metrics.steps} / ${task.type}`);
    }

    assert.equal(state.game.phase, 'ended', `1000ステップ以内に正常終了する。現在タスク: ${getCurrentGmTask(state).type}`);
    assert.ok(metrics.completedDiscussionDays.length >= 1, '3巡議論を1日以上完了する');
    assert.equal(metrics.briefingPromptCount, state.players.length, '全プレイヤーへ役職通知プロンプトを提示する');
    assert.equal(state.aiTurns.length, metrics.aiResponsePromptCount, '全AI回答がAIターンとして保存される');
    assert.ok(metrics.aiResponsePromptCount > 0, '実際のデモAI回答を生成・登録する');
    metrics.structuredOutputMetrics = summarizeStructuredOutputs(state);
    metrics.speechPromptLengthSummary = summarizePromptLengths(metrics.speechPromptLengthsByDay);
    if (state.game.day >= 2) {
      assert.equal(metrics.truncatedPublicHistoryPromptCount, 0, 'fullでは公開発言を途中切断しない');
    }
    assert.ok(Object.keys(metrics.pipelineTaskCounts).includes('speech'), '公開発言AI回答を本番経路へ通す');
    assert.ok(Object.keys(metrics.pipelineTaskCounts).includes('vote'), '投票AI回答を本番経路へ通す');
    assert.ok(metrics.resultPromptCount > 0, '感想プロンプトを本番経路へ通す');
    assert.ok(metrics.earlyExitResultPromptCount > 0, '早期離脱者へ離脱後の正式ゲーム経過を渡す');
    if (human) {
      assert.ok(metrics.humanPublicSpeechCount >= 3, '人間本人が3巡の公開発言経路を通る');
      assert.equal(state.aiTurns.some((turn) => turn.playerId === human.id && turn.taskType === 'speech'), false, '人間発言をAI発言として保存しない');
    }

    return {
      state,
      metrics: {
        ...metrics,
        winner: state.game.winner,
        finalDay: state.game.day,
        publicEventCount: state.events.filter((event) => event.status === 'published' && event.audience?.type === 'public').length,
        aiTurnCount: state.aiTurns.length,
      },
    };
  } finally {
    Math.random = originalRandom;
  }
}

test('初期3巡設定で全AIの1ゲームをデモAI統合経路で完走する', async () => {
  const { metrics } = await runProductionPlaythrough();
  assert.equal(metrics.humanPlayerId, null);
  console.log(`PLAYTHROUGH_ALL_AI ${JSON.stringify(metrics)}`);
});

test('初期3巡設定で1人間プレイヤーを含む1ゲームをデモAI統合経路で完走する', async () => {
  const { metrics } = await runProductionPlaythrough({ humanPlayer: true, generationDepth: 4 });
  assert.ok(metrics.humanPlayerId);
  assert.ok(metrics.deepResultRenderPromptCount > 0, '深度4の感想発言化工程を本番経路で検証する');
  console.log(`PLAYTHROUGH_ONE_HUMAN ${JSON.stringify(metrics)}`);
});

