/**
 * 責務: 1ゲーム通しテストを、現在状態から本番の次操作導出・AIプロンプト生成・候補検証・正式登録・状態検証へ逐次接続し、再開可能なチェックポイントとして進行する。
 * 変更ルール: ゲーム規則、AIタスク分類、登録分岐、勝敗判定、投票集計、夜行動解決を独自実装しない。本番resolveAutomaticAction / createAutomaticActionController / prepareAiTask / evaluateAiTaskCandidate / createAiTaskCommitControllerを正本とし、外部AIのrawResponseだけを受け取る。
 */

import '../game/testEnvironment.js';

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutomaticActionController } from '../../../app/renderer/js/ui/controllers/automaticActionController.js';
import { createAiTaskCommitController } from '../../../app/renderer/js/ui/controllers/aiTaskCommitController.js';
import { createSetupActionController } from '../../../app/renderer/js/ui/controllers/setupActionController.js';
import { ManualGenerationController } from '../../../app/renderer/js/ui/ai/manualGenerationController.js';
import { resolveAutomaticAction } from '../../../app/renderer/js/domain/game/automaticActionPolicy.js';
import { prepareAiTask, evaluateAiTaskCandidate } from '../../../app/renderer/js/services/aiTaskService.js';
import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { createAutosaveState } from '../../../app/renderer/js/state/autosaveState.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';
import { APP_VERSION, PROMPT_SPEC_VERSION, SCHEMA_VERSION } from '../../../app/renderer/js/config/constants.js';
import {
  clearSubmittedAiResponse,
  providerPaths,
  publishPendingAiTask,
  readSubmittedAiResponse,
} from './aiResponseProvider.js';
import { checkpointStateHash, writePromptTestOutputs } from './gameTestReporter.js';

const RUNNER_SCHEMA_VERSION = 1;
const RUN_FILES = Object.freeze({ state: 'state.json', session: 'session.json' });
const MANUAL_PROFILE = Object.freeze({
  id: 'prompt-test-manual',
  label: 'Prompt Test Manual',
  enabled: true,
  generation: Object.freeze({ depth: 1 }),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Text(value) {
  return sha256(Buffer.from(String(value ?? ''), 'utf8'));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runPaths(workspace) {
  const root = resolve(workspace);
  return Object.freeze({
    root,
    state: join(root, RUN_FILES.state),
    session: join(root, RUN_FILES.session),
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assertValidState(state, label, { includeHistory = false } = {}) {
  const target = includeHistory
    ? state
    : { ...state, undoStack: [], redoStack: [], restorePoints: [] };
  const validation = validateImportedState(target);
  if (!validation.ok) throw new Error(`${label}: ${validation.errors.join(' / ')}`);
}

function compactCommitResponse(response) {
  return {
    ok: Boolean(response?.ok),
    message: String(response?.message ?? ''),
    issues: structuredClone(response?.issues ?? []),
    warnings: structuredClone(response?.warnings ?? []),
  };
}

function evaluationAudit(evaluation) {
  return {
    ok: Boolean(evaluation?.ok),
    parsed: structuredClone(evaluation?.parsed ?? null),
    parseResult: structuredClone(evaluation?.parseResult ?? null),
    validation: structuredClone(evaluation?.validation ?? null),
    issues: structuredClone(evaluation?.issues ?? []),
    warnings: structuredClone(evaluation?.warnings ?? []),
    autoRepair: structuredClone(evaluation?.autoRepair ?? null),
    effectiveRawResponse: String(evaluation?.effectiveRawResponse ?? ''),
  };
}

function createRuntime(store) {
  const toast = () => {};
  const setupActionController = createSetupActionController({
    store,
    toast,
    render: () => {},
    commitSetupMutation: (label, mutator, options = {}) => store.commit(label, mutator, options),
    refreshSetupView: () => {},
  });
  const automaticActionController = createAutomaticActionController({
    ui: { setupActionController },
  });
  const executionSettings = {
    executionMode: 'manual',
    profiles: [MANUAL_PROFILE],
    assignments: Object.fromEntries((store.getState().players ?? []).map((player) => [player.id, MANUAL_PROFILE.id])),
  };
  const manualGenerationController = new ManualGenerationController({
    aiExecutionSettings: () => executionSettings,
  });
  const drafts = new Map();
  const promptCache = new Map();
  const aiTaskCommitController = createAiTaskCommitController({
    store,
    toast,
    drafts,
    promptCache,
    promptKey: (state, taskType, playerId, slotId = '') => [state.game?.id, state.revision, taskType, playerId, slotId].join(':'),
    freshPromptState: () => ({ key: '', cache: null, current: null, error: null }),
    showValidation: () => {},
    manualPlan: (playerId, taskType) => manualGenerationController.manualPlan(playerId, taskType),
    manualDirectGenerationRun: (taskArtifact, rawResponse, evaluation) => manualGenerationController.manualDirectGenerationRun(taskArtifact, rawResponse, evaluation),
    runEngine: (label, command, options = {}) => setupActionController._runEngine(label, command, options),
    clearSpeechMetadata: () => {},
    completeFullPublicHistorySync: () => false,
  });
  return Object.freeze({
    setupActionController,
    automaticActionController,
    aiTaskCommitController,
  });
}

async function saveCheckpoint(paths, store, session) {
  const state = createAutosaveState(store.getState());
  assertValidState(state, 'チェックポイント保存前状態検証');
  await Promise.all([
    writeJson(paths.state, state),
    writeJson(paths.session, session),
  ]);
}

async function loadContext(workspace) {
  const paths = runPaths(workspace);
  const [rawState, session] = await Promise.all([readJson(paths.state), readJson(paths.session)]);
  assertValidState(rawState, 'チェックポイント読込前状態検証');
  const store = new StateStore(rawState);
  assertValidState(store.getState(), 'チェックポイント読込後状態検証');
  return { paths, store, session, runtime: createRuntime(store) };
}

function nextTurnId(session) {
  return `turn-${String((session.turns ?? []).length + 1).padStart(4, '0')}`;
}

function actionDescriptor(action) {
  return {
    playerId: String(action.taskRequest?.playerId ?? ''),
    taskType: String(action.taskRequest?.taskType ?? ''),
    slotId: String(action.taskRequest?.slotId ?? ''),
  };
}

function pendingDescriptor(turn) {
  return {
    playerId: String(turn.playerId ?? ''),
    taskType: String(turn.taskType ?? ''),
    slotId: String(turn.slotId ?? ''),
  };
}

function sameDescriptor(left, right) {
  return left.playerId === right.playerId && left.taskType === right.taskType && left.slotId === right.slotId;
}

async function publishAiTask({ paths, store, session, action, retryIssues = [] }) {
  const request = actionDescriptor(action);
  const state = store.getState();
  const artifact = prepareAiTask(state, request);
  let turn = session.pendingTurnId
    ? session.turns.find((item) => item.id === session.pendingTurnId)
    : null;
  if (turn) {
    if (!sameDescriptor(pendingDescriptor(turn), request)) {
      throw new Error(`保存済みAIタスクと本番次タスクが一致しません: ${JSON.stringify(pendingDescriptor(turn))} != ${JSON.stringify(request)}`);
    }
    if (turn.promptFingerprint !== artifact.fingerprint || turn.promptText !== artifact.text) {
      throw new Error('保存済みAIタスクのpromptTextまたはfingerprintが現在状態から再生成した値と一致しません。');
    }
  } else {
    turn = {
      id: nextTurnId(session),
      playerId: request.playerId,
      taskType: request.taskType,
      slotId: request.slotId,
      promptText: artifact.text,
      promptSha256: sha256Text(artifact.text),
      promptFingerprint: artifact.fingerprint,
      promptMode: artifact.promptMode,
      mode: artifact.mode,
      publicSequenceAtGeneration: artifact.publicSequenceAtGeneration,
      publicHistoryMode: artifact.publicHistoryMode,
      publicHistoryTransmissionMode: artifact.publicHistoryTransmissionMode,
      validTargetIds: [...artifact.validTargetIds],
      stateBeforeHash: checkpointStateHash(state),
      generatedAt: new Date().toISOString(),
      attempts: [],
      commit: null,
    };
    session.turns.push(turn);
    session.pendingTurnId = turn.id;
  }
  await publishPendingAiTask({
    workspace: paths.root,
    task: {
      id: turn.id,
      playerId: turn.playerId,
      taskType: turn.taskType,
      slotId: turn.slotId,
      promptFingerprint: turn.promptFingerprint,
      promptSha256: turn.promptSha256,
      publicSequenceAtGeneration: turn.publicSequenceAtGeneration,
      attemptNumber: turn.attempts.length + 1,
    },
    promptText: turn.promptText,
    issues: retryIssues,
  });
  await saveCheckpoint(paths, store, session);
  return turn;
}

async function finalizeRun({ paths, store, session }) {
  const state = store.getState();
  session.completedAt ??= new Date().toISOString();
  session.finalStateHash = checkpointStateHash(state);
  await saveCheckpoint(paths, store, session);
  const outputs = await writePromptTestOutputs({ workspace: paths.root, state, session });
  await writeJson(paths.session, session);
  return {
    kind: 'ended',
    summary: {
      day: state.game?.day ?? 0,
      winner: state.game?.winner ?? state.result?.winner ?? null,
      aiTurnCount: state.aiTurns?.length ?? 0,
    },
    outputDir: outputs.outputDir,
    importVerification: outputs.importVerification,
  };
}

async function pumpUntilAiOrEnded({ paths, store, session, runtime }, { maxAutomaticActions = 1000 } = {}) {
  for (let index = 0; index < maxAutomaticActions; index += 1) {
    const state = store.getState();
    assertValidState(state, '次操作導出前状態検証');
    const action = resolveAutomaticAction(state, { autoPublish: true });
    if (action.kind === 'ai-task') {
      const turn = await publishAiTask({ paths, store, session, action });
      const io = providerPaths(paths.root);
      return {
        kind: 'ai-task',
        turnId: turn.id,
        playerId: turn.playerId,
        taskType: turn.taskType,
        slotId: turn.slotId,
        promptPath: io.prompt,
        aiInputPath: io.aiInput,
        responsePath: io.response,
      };
    }
    if (action.kind === 'ended') return finalizeRun({ paths, store, session });
    if (action.kind !== 'command') {
      throw new Error(`全AI通しテストを継続できない本番次操作です: ${action.kind} / ${action.reason ?? ''}`);
    }
    const beforeHash = checkpointStateHash(state);
    const response = runtime.automaticActionController.executeAutomaticAction(action);
    if (!response?.ok) throw new Error(`${action.label}: ${response?.message ?? '本番自動操作に失敗しました。'}`);
    const afterState = store.getState();
    assertValidState(afterState, `自動操作「${action.label}」後状態検証`);
    session.automaticActions.push({
      sequence: session.automaticActions.length + 1,
      command: action.command,
      label: action.label,
      request: structuredClone(action),
      response: compactCommitResponse(response),
      beforeHash,
      afterHash: checkpointStateHash(afterState),
      executedAt: new Date().toISOString(),
    });
  }
  throw new Error(`自動GM操作が${maxAutomaticActions}件を超えました。無限進行の可能性があります。`);
}

async function sourceZipInfo(sourceZipPath, explicitSha256 = '') {
  if (!sourceZipPath) return { path: '', sha256: String(explicitSha256 ?? '') };
  const path = resolve(sourceZipPath);
  const bytes = await readFile(path);
  const calculated = sha256(bytes);
  if (explicitSha256 && calculated !== String(explicitSha256).toLowerCase()) {
    throw new Error(`入力ZIP SHA-256が指定値と一致しません: ${calculated}`);
  }
  return { path, sha256: calculated };
}

export async function initializeRun({ workspace, sourceZipPath = '', sourceZipSha256 = '', force = false } = {}) {
  const paths = runPaths(workspace);
  if (await exists(paths.root)) {
    if (!force && ((await exists(paths.state)) || (await exists(paths.session)))) {
      throw new Error(`既存の通しテスト作業領域があります: ${paths.root}。再初期化する場合は--forceを指定してください。`);
    }
    if (force) await rm(paths.root, { recursive: true, force: true });
  }
  await mkdir(paths.root, { recursive: true });

  const store = new StateStore(createInitialState(8));
  const runtime = createRuntime(store);
  runtime.setupActionController._randomizeCharacters();
  const setupState = store.getState();
  assertValidState(setupState, 'ゲーム初期化後状態検証');
  if ((setupState.players ?? []).some((player) => !player.characterCardId || player.controller !== 'ai')) {
    throw new Error('8人全員AI・キャラクター重複なしの初期設定を作成できませんでした。');
  }
  const cardIds = setupState.players.map((player) => player.characterCardId);
  if (new Set(cardIds).size !== cardIds.length) throw new Error('キャラクターカードが重複しています。');
  const zip = await sourceZipInfo(sourceZipPath, sourceZipSha256);
  const session = {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    dataSchemaVersion: SCHEMA_VERSION,
    promptSpecVersion: PROMPT_SPEC_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: null,
    sourceZipPath: zip.path,
    sourceZipSha256: zip.sha256,
    randomization: {
      players: setupState.players.map((player, index) => ({
        order: index + 1,
        id: player.id,
        name: player.name,
        characterCardId: player.characterCardId,
        roleId: player.roleId,
      })),
    },
    pendingTurnId: null,
    turns: [],
    automaticActions: [],
    invalidConditions: [],
    sourceRouteBypassCount: 0,
  };
  await saveCheckpoint(paths, store, session);
  return pumpUntilAiOrEnded({ paths, store, session, runtime });
}

export async function submitRun({ workspace, responseFile = '' } = {}) {
  const context = await loadContext(workspace);
  const { paths, store, session, runtime } = context;
  if (!session.pendingTurnId) throw new Error('回答待ちAIタスクがありません。advanceを実行してください。');
  const pending = session.turns.find((turn) => turn.id === session.pendingTurnId);
  if (!pending) throw new Error(`回答待ちターンが監査データにありません: ${session.pendingTurnId}`);

  const state = store.getState();
  const action = resolveAutomaticAction(state, { autoPublish: true });
  if (action.kind !== 'ai-task') throw new Error(`回答待ち保存中ですが、本番次操作はAIタスクではありません: ${action.kind}`);
  const request = actionDescriptor(action);
  if (!sameDescriptor(pendingDescriptor(pending), request)) {
    throw new Error(`回答待ちAIタスクと本番次操作が一致しません: ${JSON.stringify(pendingDescriptor(pending))} != ${JSON.stringify(request)}`);
  }
  const taskArtifact = prepareAiTask(state, request);
  if (taskArtifact.fingerprint !== pending.promptFingerprint || taskArtifact.text !== pending.promptText) {
    throw new Error('回答登録前にpromptTextまたはfingerprintが変化しました。古いプロンプトへの回答は登録しません。');
  }
  const { rawResponse, source } = await readSubmittedAiResponse({ workspace: paths.root, responseFile });
  const evaluation = evaluateAiTaskCandidate(state, taskArtifact, rawResponse);
  const attempt = {
    number: pending.attempts.length + 1,
    submittedAt: new Date().toISOString(),
    source,
    rawResponse,
    rawResponseSha256: sha256Text(rawResponse),
    mode: taskArtifact.mode,
    ok: Boolean(evaluation.ok),
    evaluation: evaluationAudit(evaluation),
  };
  pending.attempts.push(attempt);
  await clearSubmittedAiResponse(paths.root);

  if (!evaluation.ok) {
    await publishPendingAiTask({
      workspace: paths.root,
      task: {
        id: pending.id,
        playerId: pending.playerId,
        taskType: pending.taskType,
        slotId: pending.slotId,
        promptFingerprint: pending.promptFingerprint,
        promptSha256: pending.promptSha256,
        publicSequenceAtGeneration: pending.publicSequenceAtGeneration,
        attemptNumber: pending.attempts.length + 1,
      },
      promptText: pending.promptText,
      issues: evaluation.issues,
    });
    await saveCheckpoint(paths, store, session);
    return {
      kind: 'retry-required',
      turnId: pending.id,
      attemptNumber: attempt.number,
      issues: structuredClone(evaluation.issues),
      aiInputPath: providerPaths(paths.root).aiInput,
      responsePath: providerPaths(paths.root).response,
    };
  }

  const beforeCount = state.aiTurns?.length ?? 0;
  const response = runtime.aiTaskCommitController.commitAiTaskCandidate({
    taskArtifact,
    rawResponse,
    evaluation,
    interactive: false,
    autoConfirmWarnings: true,
  });
  if (!response?.ok) {
    pending.commit = {
      ok: false,
      response: compactCommitResponse(response),
      attemptedAt: new Date().toISOString(),
    };
    session.invalidConditions.push({
      code: 'PRODUCTION_COMMIT_FAILED',
      turnId: pending.id,
      message: response?.message ?? '本番登録に失敗しました。',
      detectedAt: new Date().toISOString(),
    });
    await saveCheckpoint(paths, store, session);
    throw new Error(`${pending.id}の本番登録に失敗しました: ${response?.message ?? ''}`);
  }
  const afterState = store.getState();
  assertValidState(afterState, `${pending.id}本番登録後状態検証`);
  const committedTurn = afterState.aiTurns?.at(-1) ?? null;
  if ((afterState.aiTurns?.length ?? 0) !== beforeCount + 1 || !committedTurn) {
    throw new Error(`${pending.id}登録後にAIターンが1件追加されていません。`);
  }
  pending.commit = {
    ok: true,
    response: compactCommitResponse(response),
    aiTurnId: committedTurn.id,
    generationRun: structuredClone(committedTurn.generationRun ?? null),
    effectiveRawResponse: String(committedTurn.rawResponse ?? ''),
    stateAfterHash: checkpointStateHash(afterState),
    committedAt: new Date().toISOString(),
  };
  session.pendingTurnId = null;
  return pumpUntilAiOrEnded({ paths, store, session, runtime });
}

export async function advanceRun({ workspace } = {}) {
  const context = await loadContext(workspace);
  if (context.session.pendingTurnId) {
    const pending = context.session.turns.find((turn) => turn.id === context.session.pendingTurnId);
    if (!pending) throw new Error(`回答待ちターンが監査データにありません: ${context.session.pendingTurnId}`);
    const action = resolveAutomaticAction(context.store.getState(), { autoPublish: true });
    if (action.kind !== 'ai-task') throw new Error(`回答待ち保存中ですが、本番次操作はAIタスクではありません: ${action.kind}`);
    await publishAiTask({ paths: context.paths, store: context.store, session: context.session, action });
    return {
      kind: 'ai-task',
      turnId: pending.id,
      playerId: pending.playerId,
      taskType: pending.taskType,
      slotId: pending.slotId,
      promptPath: providerPaths(context.paths.root).prompt,
      aiInputPath: providerPaths(context.paths.root).aiInput,
      responsePath: providerPaths(context.paths.root).response,
    };
  }
  return pumpUntilAiOrEnded(context);
}

export async function statusRun({ workspace } = {}) {
  const { paths, store, session } = await loadContext(workspace);
  const state = store.getState();
  const pending = session.pendingTurnId ? session.turns.find((turn) => turn.id === session.pendingTurnId) : null;
  return {
    workspace: paths.root,
    phase: state.game?.phase ?? '',
    day: state.game?.day ?? 0,
    status: state.game?.status ?? '',
    winner: state.game?.winner ?? state.result?.winner ?? null,
    aiTurnCount: state.aiTurns?.length ?? 0,
    completedTurnCount: session.turns.filter((turn) => turn.commit?.ok).length,
    pending: pending ? {
      id: pending.id,
      playerId: pending.playerId,
      taskType: pending.taskType,
      slotId: pending.slotId,
      nextAttemptNumber: pending.attempts.length + 1,
    } : null,
    provider: providerPaths(paths.root),
  };
}

function parseCli(argv) {
  const [command = 'status', ...tokens] = argv;
  const options = { command, workspace: resolve(process.cwd(), 'prompt-test-run') };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--force') options.force = true;
    else if (token === '--workspace') options.workspace = resolve(tokens[++index]);
    else if (token === '--source-zip') options.sourceZipPath = resolve(tokens[++index]);
    else if (token === '--source-zip-sha256') options.sourceZipSha256 = String(tokens[++index] ?? '');
    else if (token === '--response') options.responseFile = resolve(tokens[++index]);
    else throw new Error(`未対応の引数です: ${token}`);
  }
  return options;
}

async function cli() {
  const options = parseCli(process.argv.slice(2));
  let result;
  if (options.command === 'init') result = await initializeRun(options);
  else if (options.command === 'submit') result = await submitRun(options);
  else if (options.command === 'advance') result = await advanceRun(options);
  else if (options.command === 'status') result = await statusRun(options);
  else throw new Error(`未対応のコマンドです: ${options.command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
