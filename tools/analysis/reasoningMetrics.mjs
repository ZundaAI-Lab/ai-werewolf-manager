/**
 * 責務: 保存済みゲームStateだけから、現行の推理レンズ選択分布を決定的に集計する。
 * 変更ルール: ゲーム状態・AIターン・プロンプトを変更せず、LLMを呼び出さない。候補順位は製品側reasoningModePolicy.jsを正本とし、発言本文の意味分類や理由カテゴリ推定は行わない。現行候補外を率の分母へ混ぜず、比較対象0件は0%ではなくn/aとして表示する。evidenceFocusごとの候補構造差を性能差と誤読させない注記を維持する。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNormalSpeechTask } from '../../app/renderer/js/config/discussionAiTaskTypes.js';
import { getReasoningModeCandidates } from '../../app/renderer/js/config/reasoningModePolicy.js';

const FORCED_MODES = new Set(['respond-directly', 'evaluate-response']);
const FALLBACK_MODE = 'hold-judgment';
const CATEGORIES = ['personality', 'forced', 'fallback'];

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function increment(map, key, amount = 1) {
  const normalized = String(key ?? 'unknown');
  map[normalized] = Number(map[normalized] ?? 0) + amount;
}

function sortedObject(source, keyOrder = null) {
  const keys = keyOrder ?? Object.keys(source).sort((left, right) => left.localeCompare(right, 'ja'));
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

function playerEvidenceFocus(player) {
  return String(player?.character?.reasoningProfile?.evidenceFocus ?? 'balanced');
}

function classifyDirective(modeId, evidenceFocus) {
  if (!modeId) return { category: null, modeRank: null, policyComparable: false, issue: null };
  if (FORCED_MODES.has(modeId)) return { category: 'forced', modeRank: null, policyComparable: true, issue: null };
  if (modeId === FALLBACK_MODE) return { category: 'fallback', modeRank: null, policyComparable: true, issue: null };
  const candidates = getReasoningModeCandidates(evidenceFocus);
  const index = candidates.indexOf(modeId);
  if (index < 0) return { category: null, modeRank: null, policyComparable: true, issue: 'mode-not-in-current-evidence-focus-policy' };
  return { category: 'personality', modeRank: index + 1, policyComparable: true, issue: null };
}

function createBucket() {
  return {
    normalSpeechTurns: 0,
    directiveTurns: 0,
    withoutDirectiveTurns: 0,
    unexpectedDirectiveTurns: 0,
    categoryCounts: { personality: 0, forced: 0, fallback: 0 },
    modeDistribution: {},
    selectedModeRankDistribution: {},
    personalityTurns: 0,
    primaryModeSelections: 0,
  };
}

function addTurnToBucket(bucket, turnMetric) {
  bucket.normalSpeechTurns += 1;
  if (!turnMetric.modeId) {
    bucket.withoutDirectiveTurns += 1;
    return;
  }
  bucket.directiveTurns += 1;
  increment(bucket.modeDistribution, turnMetric.modeId);
  if (turnMetric.issue) {
    bucket.unexpectedDirectiveTurns += 1;
    return;
  }
  if (CATEGORIES.includes(turnMetric.category)) bucket.categoryCounts[turnMetric.category] += 1;
  if (turnMetric.category === 'personality') {
    bucket.personalityTurns += 1;
    increment(bucket.selectedModeRankDistribution, turnMetric.modeRank);
    if (turnMetric.modeRank === 1) bucket.primaryModeSelections += 1;
  }
}

function finalizeBucket(bucket) {
  const comparableDirectiveTurns = bucket.directiveTurns - bucket.unexpectedDirectiveTurns;
  return {
    ...bucket,
    comparableDirectiveTurns,
    categoryCounts: sortedObject(bucket.categoryCounts, CATEGORIES),
    modeDistribution: sortedObject(bucket.modeDistribution),
    selectedModeRankDistribution: sortedObject(bucket.selectedModeRankDistribution, ['1', '2', '3']),
    forcedRate: ratio(bucket.categoryCounts.forced, comparableDirectiveTurns),
    fallbackRate: ratio(bucket.categoryCounts.fallback, comparableDirectiveTurns),
    primaryModeSelectionRate: ratio(bucket.primaryModeSelections, bucket.personalityTurns),
  };
}

function aggregateBy(turnMetrics, keySelector) {
  const buckets = new Map();
  for (const turn of turnMetrics) {
    const key = String(keySelector(turn));
    if (!buckets.has(key)) buckets.set(key, createBucket());
    addTurnToBucket(buckets.get(key), turn);
  }
  return Object.fromEntries([...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'ja', { numeric: true }))
    .map(([key, bucket]) => [key, finalizeBucket(bucket)]));
}

export function analyzeReasoningMetrics(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('保存ゲームStateがオブジェクトではありません。');
  const players = Array.isArray(state.players) ? state.players : [];
  const playerById = new Map(players.map((player) => [String(player?.id ?? ''), player]));
  const rosterEvidenceFocusSet = [...new Set(players.map(playerEvidenceFocus))].sort((left, right) => left.localeCompare(right, 'ja'));
  const promptSpecVersions = [...new Set((state.aiTurns ?? []).map((turn) => Number(turn?.promptSpecVersion)).filter(Number.isFinite))].sort((a, b) => a - b);

  const turnMetrics = (state.aiTurns ?? [])
    .filter((turn) => isNormalSpeechTask(turn?.taskType))
    .map((turn) => {
      const playerId = String(turn?.playerId ?? '');
      const evidenceFocus = playerEvidenceFocus(playerById.get(playerId));
      const directive = turn?.resolvedInternalReasoningDirective ?? null;
      const modeId = directive?.modeId ? String(directive.modeId) : null;
      const classification = classifyDirective(modeId, evidenceFocus);
      return {
        turnId: String(turn?.id ?? ''),
        playerId,
        playerName: String(playerById.get(playerId)?.name ?? playerId),
        day: Number(turn?.day ?? 0),
        phase: String(turn?.phase ?? ''),
        taskType: String(turn?.taskType ?? ''),
        promptSpecVersion: Number(turn?.promptSpecVersion ?? 0),
        evidenceFocus,
        modeId,
        lens: directive?.lens ? String(directive.lens) : null,
        category: classification.category,
        modeRank: classification.modeRank,
        policyComparable: classification.policyComparable,
        issue: classification.issue,
      };
    });

  const overallBucket = createBucket();
  turnMetrics.forEach((turn) => addTurnToBucket(overallBucket, turn));

  return {
    gameId: String(state.game?.id ?? ''),
    gameTitle: String(state.game?.title ?? ''),
    promptSpecVersions,
    rosterEvidenceFocusSet,
    summary: finalizeBucket(overallBucket),
    byEvidenceFocus: aggregateBy(turnMetrics, (turn) => turn.evidenceFocus),
    byDay: aggregateBy(turnMetrics, (turn) => turn.day),
    byTaskType: aggregateBy(turnMetrics, (turn) => turn.taskType),
    turns: turnMetrics,
  };
}

function percent(value) {
  return value === null || value === undefined
    ? 'n/a'
    : `${(Number(value) * 100).toFixed(1)}%`;
}

function appendBucket(lines, label, bucket, indent = '  ') {
  lines.push(`${label}: ${bucket.normalSpeechTurns}`);
  lines.push(`${indent}personality ${bucket.categoryCounts.personality} / forced ${bucket.categoryCounts.forced} / fallback ${bucket.categoryCounts.fallback} / no-directive ${bucket.withoutDirectiveTurns}`);
  lines.push(`${indent}comparable directives ${bucket.comparableDirectiveTurns} / unexpected ${bucket.unexpectedDirectiveTurns}`);
  lines.push(`${indent}primary ${percent(bucket.primaryModeSelectionRate)} (${bucket.primaryModeSelections}/${bucket.personalityTurns} personality) / forced ${percent(bucket.forcedRate)} (${bucket.categoryCounts.forced}/${bucket.comparableDirectiveTurns} comparable) / fallback ${percent(bucket.fallbackRate)} (${bucket.categoryCounts.fallback}/${bucket.comparableDirectiveTurns} comparable)`);
  const ranks = Object.entries(bucket.selectedModeRankDistribution).map(([rank, count]) => `${rank}位=${count}`).join(' / ');
  if (ranks) lines.push(`${indent}rank: ${ranks}`);
  const modes = Object.entries(bucket.modeDistribution).map(([mode, count]) => `${mode}=${count}`).join(' / ');
  if (modes) lines.push(`${indent}modes: ${modes}`);
}

export function formatReasoningMetricsReport(report) {
  const lines = [
    `Reasoning Metrics / ${report.gameTitle || report.gameId || '(unknown game)'}`,
    `Prompt specs: ${report.promptSpecVersions.join(', ') || 'none'}`,
    `Roster evidenceFocus: ${report.rosterEvidenceFocusSet.join(', ') || 'none'}`,
    '',
  ];
  appendBucket(lines, 'Normal speech turns', report.summary, '  ');
  lines.push('', 'By evidenceFocus');
  for (const [focus, bucket] of Object.entries(report.byEvidenceFocus)) appendBucket(lines, `- ${focus}`, bucket, '    ');
  lines.push('', 'By day');
  for (const [day, bucket] of Object.entries(report.byDay)) appendBucket(lines, `- Day ${day}`, bucket, '    ');
  lines.push('', 'By task type');
  for (const [taskType, bucket] of Object.entries(report.byTaskType)) appendBucket(lines, `- ${taskType}`, bucket, '    ');
  if (Object.hasOwn(report.byEvidenceFocus, 'social-reaction')) {
    lines.push('', 'Interpretation note: fallbackRate is not directly comparable across evidenceFocus values because candidate sets and preconditions differ. social-reaction includes challenge-consensus, which structurally prevents hold-judgment fallback once that candidate is reached.');
  }
  if (report.summary.unexpectedDirectiveTurns) lines.push(`Unexpected directives: ${report.summary.unexpectedDirectiveTurns}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((arg) => arg !== '--json');
  return { file, json };
}

function runCli() {
  const { file, json } = parseArgs(process.argv);
  if (!file) {
    console.error('Usage: node tools/analysis/reasoningMetrics.mjs <saved-game.json> [--json]');
    process.exitCode = 2;
    return;
  }
  const resolved = path.resolve(file);
  const raw = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/u, '');
  const report = analyzeReasoningMetrics(JSON.parse(raw));
  console.log(json ? JSON.stringify(report, null, 2) : formatReasoningMetricsReport(report));
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli();
