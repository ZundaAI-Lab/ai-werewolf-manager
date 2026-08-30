/**
 * 責務: 1ゲーム通しテストの監査記録から、提出用完全状態・ターン監査・公開タイムライン・マニフェスト・機械集計を生成する。
 * 変更ルール: ゲーム状態を更新せず、勝敗・役職・判断の意味を独自解決しない。表示用データはdeep copyして作成し、質的なプロンプト評価をルールベース文章へ置換しない。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { APP_VERSION, PROMPT_SPEC_VERSION, SCHEMA_VERSION } from '../../../app/renderer/js/config/constants.js';
import { isPersonalNightActionTask } from '../../../app/renderer/js/config/personalNightActionTasks.js';
import { parseAiResponse } from '../../../app/renderer/js/prompts/response/responseParser.js';
import { prepareImportedState } from '../../../app/renderer/js/state/stateImport.js';
import { createAutosaveState } from '../../../app/renderer/js/state/autosaveState.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';
import { stableStringify } from '../../../app/renderer/js/shared/utils.js';

export const RESULT_FILENAMES = Object.freeze({
  result: 'ai_werewolf_8player_prompt_test_result.json',
  artifacts: 'ai_werewolf_8player_prompt_test_artifacts.json',
  timeline: 'ai_werewolf_8player_prompt_test_timeline.json',
  manifest: 'ai_werewolf_8player_prompt_test_manifest.json',
  evaluationJson: 'ai_werewolf_8player_prompt_test_evaluation.json',
  evaluationMarkdown: 'ai_werewolf_8player_prompt_test_evaluation.md',
});

function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function countBy(values) {
  return values.reduce((counts, value) => {
    const key = String(value ?? '');
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizeSpeechPattern(text, playerNames) {
  let normalized = String(text ?? '').normalize('NFKC');
  [...playerNames]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .forEach((name) => { normalized = normalized.split(name).join('{PLAYER}'); });
  return normalized
    .replace(/[A-Za-z0-9_-]{8,}/gu, '{ID}')
    .replace(/\d+/gu, '{N}')
    .replace(/\s+/gu, ' ')
    .trim();
}

function acceptedAttempt(turn) {
  return [...(turn.attempts ?? [])].reverse().find((attempt) => attempt.ok) ?? null;
}

function publishedPublicEvents(state) {
  return (state.events ?? []).filter((event) => event?.status === 'published' && event?.audience?.type === 'public');
}

function publicSpeechFromEvent(event) {
  return String(event?.payload?.content ?? event?.payload?.text ?? event?.payload?.speech ?? '');
}

function stateSummary(state) {
  return {
    appVersion: String(state.appVersion ?? APP_VERSION),
    schemaVersion: Number(state.schemaVersion ?? SCHEMA_VERSION),
    promptSpecVersion: Number(state.runtime?.promptSpecVersion ?? PROMPT_SPEC_VERSION),
    phase: String(state.game?.phase ?? ''),
    status: String(state.game?.status ?? ''),
    day: Number(state.game?.day ?? 0),
    winner: state.game?.winner ?? state.result?.winner ?? null,
    playerCount: (state.players ?? []).length,
    eventCount: (state.events ?? []).length,
    aiTurnCount: (state.aiTurns ?? []).length,
  };
}

export function checkpointStateHash(state) {
  return sha256Text(stableStringify(createAutosaveState(state)));
}

export function buildPromptTestEvaluation(state, session) {
  const turns = session.turns ?? [];
  const attempts = turns.flatMap((turn) => turn.attempts ?? []);
  const accepted = turns.map(acceptedAttempt).filter(Boolean);
  const publicEvents = publishedPublicEvents(state);
  const publicSpeechEvents = publicEvents.filter((event) => event.type === 'public-speech');
  const playerNames = new Set((state.players ?? []).map((player) => String(player.name ?? '')).filter(Boolean));
  const normalizedPatterns = publicSpeechEvents
    .map(publicSpeechFromEvent)
    .filter(Boolean)
    .map((text) => normalizeSpeechPattern(text, playerNames));
  const patternCounts = countBy(normalizedPatterns);
  const [mostCommonPattern = '', mostCommonPatternCount = 0] = Object.entries(patternCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))[0] ?? [];
  const nightTurns = (state.aiTurns ?? []).filter((turn) => (
    isPersonalNightActionTask(turn.taskType) || turn.taskType === 'wolf-attack'
  ));
  const nightRationaleSaved = nightTurns.filter((turn) => String(turn.parsedSelectionRationale ?? '').trim()).length;
  const selfVotes = (state.events ?? []).filter((event) => (
    event.type === 'vote-cast'
    && event.payload?.voterId
    && event.payload?.voterId === event.payload?.targetId
  )).length;
  const parserMismatchCount = accepted.reduce((count, attempt) => {
    const reparsed = parseAiResponse(attempt.rawResponse, attempt.mode);
    return count + (stableStringify(reparsed.value) === stableStringify(attempt.evaluation?.parsed) ? 0 : 1);
  }, 0);
  const questionCount = publicSpeechEvents.filter((event) => (
    (event.payload?.questionTargetIds ?? []).length > 0
    || (event.payload?.speechInteraction?.questionTargetIds ?? []).length > 0
  )).length;
  const playerSpeechCounts = countBy(publicSpeechEvents.map((event) => event.actorId ?? ''));
  const validationErrorAttempts = attempts.filter((attempt) => !attempt.ok).length;
  const warningAttempts = attempts.filter((attempt) => (attempt.evaluation?.warnings ?? []).length > 0).length;
  const autoRepairAttempts = attempts.filter((attempt) => Boolean(attempt.evaluation?.autoRepair?.applied)).length;

  return {
    validitySignals: {
      completed: state.game?.phase === 'ended',
      parserMismatchCount,
      validationErrorAttempts,
      warningAttempts,
      autoRepairAttempts,
      sourceRouteBypassCount: Number(session.sourceRouteBypassCount ?? 0),
      gmOverrideCount: (state.aiTurns ?? []).filter((turn) => Boolean(turn.override?.applied)).length,
    },
    responsePath: {
      aiTurnCount: (state.aiTurns ?? []).length,
      taskTypeCounts: countBy(turns.map((turn) => turn.taskType)),
      attemptCount: attempts.length,
      retryCount: Math.max(0, attempts.length - turns.length),
      validationErrorAttempts,
      warningAttempts,
      autoRepairAttempts,
      parserMismatchCount,
    },
    speechAndDecision: {
      publicSpeechCount: publicSpeechEvents.length,
      playerSpeechCounts,
      roleClaimCount: (state.claims ?? []).length,
      publicAbilityClaimCount: (state.publicAbilityClaims ?? []).length,
      questionCount,
      selfVoteCount: selfVotes,
      nightActionCount: nightTurns.length,
      nightSelectionRationaleSavedCount: nightRationaleSaved,
      nightSelectionRationaleSavedRate: nightTurns.length ? nightRationaleSaved / nightTurns.length : null,
      normalizedSpeechPatternCount: normalizedPatterns.length,
      mostCommonNormalizedSpeechPattern: mostCommonPattern,
      mostCommonNormalizedSpeechPatternCount: mostCommonPatternCount,
      mostCommonNormalizedSpeechPatternRate: normalizedPatterns.length ? mostCommonPatternCount / normalizedPatterns.length : null,
      normalizedSpeechMethod: 'NFKC後、参加者名を{PLAYER}、長いIDを{ID}、数字列を{N}へ置換し空白を正規化',
    },
    memoryAndSafety: {
      memoConsolidateTurnCount: (state.aiTurns ?? []).filter((turn) => turn.taskType === 'memo-consolidate').length,
      wolfConversationTurnCount: turns.filter((turn) => turn.taskType === 'wolf-conversation').length,
      secretLeakCount: null,
      secretLeakAutomaticAssessment: 'プロンプト本文と完全状態の意味比較が必要なため質的評価で判定',
      missingLatestPublicSpeechCount: null,
      missingLatestPublicSpeechAutomaticAssessment: 'ターン単位の意味評価で判定',
    },
  };
}

export function buildPromptTestTimeline(state) {
  const allowed = new Set([
    'public-speech', 'role-claim', 'ability-result', 'vote-finalized', 'execution', 'dawn', 'game-result', 'result-impression',
  ]);
  return publishedPublicEvents(state)
    .filter((event) => allowed.has(event.type))
    .map((event) => clone(event));
}

export function buildPromptTestArtifacts(session) {
  const turns = (session.turns ?? []).map((turn) => ({
    ...clone(turn),
    generationMethod: 'external-ai-manual-direct',
    attempts: (turn.attempts ?? []).map((attempt) => {
      const reparsed = parseAiResponse(attempt.rawResponse, attempt.mode);
      return {
        ...clone(attempt),
        reparseResult: clone(reparsed),
        parserMatchesSavedEvaluation: stableStringify(reparsed.value) === stableStringify(attempt.evaluation?.parsed),
      };
    }),
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    turns,
    automaticActions: clone(session.automaticActions ?? []),
  };
}

export function buildPromptTestManifest(state, session, importVerification = null) {
  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    promptSpecVersion: PROMPT_SPEC_VERSION,
    sourceZipPath: String(session.sourceZipPath ?? ''),
    sourceZipSha256: String(session.sourceZipSha256 ?? ''),
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null,
    randomization: clone(session.randomization ?? {}),
    players: (state.players ?? []).map((player) => ({
      id: player.id,
      name: player.name,
      characterCardId: player.characterCardId,
      roleId: player.roleId,
      controller: player.controller,
    })),
    rules: clone(state.game?.rules ?? {}),
    executionMethod: 'source-level-headless-runner',
    sequentialSingleAiRoleplay: true,
    independentAgentCount: 1,
    modelContextPhysicalIsolationVerified: false,
    productionSourcesModifiedByRunner: false,
    productionFunctions: [
      'prepareAiTask',
      'evaluateAiTaskCandidate',
      'createAiTaskCommitController/commitAiTaskCandidate',
      'resolveAutomaticAction',
      'createAutomaticActionController/executeAutomaticAction',
      'prepareImportedState',
      'validateImportedState',
    ],
    helperScripts: [
      'tools/tests/game-runner/runFullGame.js',
      'tools/tests/game-runner/aiResponseProvider.js',
      'tools/tests/game-runner/gameTestReporter.js',
    ],
    environmentAdjustments: ['Node.js上でRenderer本番ES Modulesを直接実行', 'character catalog読込はtools/tests/game/testEnvironment.js経由で本番characterDataStoreを使用'],
    invalidConditions: clone(session.invalidConditions ?? []),
    finalStateSummary: stateSummary(state),
    importVerification: clone(importVerification),
  };
}

function evaluationMarkdown(state, evaluation, manifest) {
  const winner = state.game?.winner ?? state.result?.winner ?? '未確定';
  const rate = evaluation.speechAndDecision.mostCommonNormalizedSpeechPatternRate;
  const rationaleRate = evaluation.speechAndDecision.nightSelectionRationaleSavedRate;
  return `# AI人狼 8人村プロンプト通しテスト評価\n\n`
    + `## 実行結果\n\n`
    + `- 完走: ${evaluation.validitySignals.completed ? 'はい' : 'いいえ'}\n`
    + `- 勝者: ${winner}\n`
    + `- 終了Day: ${state.game?.day ?? 0}\n`
    + `- AIターン数: ${evaluation.responsePath.aiTurnCount}\n`
    + `- AI回答試行数: ${evaluation.responsePath.attemptCount}\n`
    + `- 本番検証不受理試行: ${evaluation.responsePath.validationErrorAttempts}\n`
    + `- パーサー再解析不一致: ${evaluation.responsePath.parserMismatchCount}\n`
    + `- 自動修復適用試行: ${evaluation.responsePath.autoRepairAttempts}\n\n`
    + `## 機械集計\n\n`
    + `- 公開発言数: ${evaluation.speechAndDecision.publicSpeechCount}\n`
    + `- CO件数: ${evaluation.speechAndDecision.roleClaimCount}\n`
    + `- 公開能力結果件数: ${evaluation.speechAndDecision.publicAbilityClaimCount}\n`
    + `- 質問を含む公開発言件数: ${evaluation.speechAndDecision.questionCount}\n`
    + `- 自己投票: ${evaluation.speechAndDecision.selfVoteCount}\n`
    + `- 夜行動理由保存率: ${rationaleRate === null ? '対象なし' : `${(rationaleRate * 100).toFixed(1)}%`}\n`
    + `- 最多の正規化発言文型割合: ${rate === null ? '対象なし' : `${(rate * 100).toFixed(1)}%`}\n\n`
    + `## 読込検証\n\n`
    + `- JSON構文解析: ${manifest.importVerification?.jsonParseOk ? '成功' : '未確認/失敗'}\n`
    + `- 現行Schema直接検証: ${manifest.importVerification?.rawValidationOk ? '成功' : '未確認/失敗'}\n`
    + `- 本番prepareImportedState: ${manifest.importVerification?.prepareImportedStateOk ? '成功' : '未確認/失敗'}\n`
    + `- 読込後Schema検証: ${manifest.importVerification?.preparedValidationOk ? '成功' : '未確認/失敗'}\n`
    + `- 完全状態JSON SHA-256: ${manifest.importVerification?.resultSha256 ?? ''}\n\n`
    + `## 質的評価\n\n`
    + `このファイルはランナーが生成する機械集計の土台です。判断品質、キャラクター差、判断更新、COの妥当性、人狼戦術、秘密情報隔離、具体的なプロンプト改善点は、各ターンの実promptTextとrawResponseを読んだ実行AIが最終評価時に追記してください。1ゲームのみから一般性能は断定しません。\n`;
}

export async function verifyWrittenResult(resultPath, expectedState) {
  const text = await readFile(resultPath, 'utf8');
  const resultSha256 = sha256Text(text);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      jsonParseOk: false,
      rawValidationOk: false,
      prepareImportedStateOk: false,
      preparedValidationOk: false,
      resultSha256,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const rawValidation = validateImportedState(raw);
  let prepared;
  try {
    prepared = prepareImportedState(raw);
  } catch (error) {
    return {
      ok: false,
      jsonParseOk: true,
      rawValidationOk: rawValidation.ok,
      rawValidationErrors: rawValidation.errors,
      prepareImportedStateOk: false,
      preparedValidationOk: false,
      resultSha256,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const preparedValidation = validateImportedState(prepared);
  const expected = stateSummary(expectedState);
  const actual = stateSummary(prepared);
  const summaryMatches = stableStringify(expected) === stableStringify(actual);
  return {
    ok: rawValidation.ok && preparedValidation.ok && summaryMatches,
    jsonParseOk: true,
    rawValidationOk: rawValidation.ok,
    rawValidationErrors: rawValidation.errors,
    prepareImportedStateOk: true,
    preparedValidationOk: preparedValidation.ok,
    preparedValidationErrors: preparedValidation.errors,
    summaryMatches,
    expectedSummary: expected,
    actualSummary: actual,
    resultSha256,
    verifiedAt: new Date().toISOString(),
  };
}

export async function writePromptTestOutputs({ workspace, state, session }) {
  const outputDir = resolve(workspace, 'output');
  await mkdir(outputDir, { recursive: true });
  const resultState = createAutosaveState(state);
  const resultPath = join(outputDir, RESULT_FILENAMES.result);
  const beforeHash = checkpointStateHash(state);
  const resultText = `${JSON.stringify(resultState, null, 2)}\n`;
  await writeFile(resultPath, resultText, 'utf8');
  const afterHash = checkpointStateHash(state);
  if (beforeHash !== afterHash) throw new Error('成果物生成中に完全状態が変更されました。');

  const importVerification = await verifyWrittenResult(resultPath, state);
  if (!importVerification.ok) {
    throw new Error(`提出予定完全状態JSONの本番読込テストに失敗しました: ${importVerification.error ?? [...(importVerification.rawValidationErrors ?? []), ...(importVerification.preparedValidationErrors ?? [])].join(' / ')}`);
  }

  const evaluation = buildPromptTestEvaluation(state, session);
  const manifest = buildPromptTestManifest(state, session, importVerification);
  const artifacts = buildPromptTestArtifacts(session);
  const timeline = buildPromptTestTimeline(state);
  const writes = [
    [RESULT_FILENAMES.artifacts, artifacts],
    [RESULT_FILENAMES.timeline, timeline],
    [RESULT_FILENAMES.manifest, manifest],
    [RESULT_FILENAMES.evaluationJson, evaluation],
  ];
  await Promise.all(writes.map(([filename, value]) => writeFile(join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf8')));
  await writeFile(join(outputDir, RESULT_FILENAMES.evaluationMarkdown), evaluationMarkdown(state, evaluation, manifest), 'utf8');

  return {
    outputDir,
    files: Object.fromEntries(Object.values(RESULT_FILENAMES).map((filename) => [filename, join(outputDir, filename)])),
    evaluation,
    manifest,
    importVerification,
  };
}
