/**
 * 責務: 保存Stateの推理レンズ計測が現行候補順位正本と一致し、forced/fallback/未割当・候補外を混同せず、比較不能な率を0%と誤表示しないことを確認する。
 * 変更ルール: 発言本文の意味評価は行わず、構造計測だけを固定する。evidenceFocus間の候補構造差は性能差として扱わない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeReasoningMetrics, formatReasoningMetricsReport } from '../../analysis/reasoningMetrics.mjs';

function player(id, name, evidenceFocus) {
  return { id, name, character: { reasoningProfile: { evidenceFocus } } };
}

function turn(id, playerId, day, taskType, modeId, promptSpecVersion = 1) {
  return {
    id,
    playerId,
    day,
    phase: 'discussion',
    taskType,
    promptSpecVersion,
    resolvedInternalReasoningDirective: modeId ? { modeId, lens: 'test' } : null,
  };
}

test('reasoning metrics classifies current personality, forced, fallback and rank distribution', () => {
  const state = {
    game: { id: 'game-metrics', title: '計測テスト' },
    players: [
      player('p1', '反応型', 'response'),
      player('p2', '関係型', 'social-reaction'),
      player('p3', '時系列型', 'chronology'),
    ],
    aiTurns: [
      turn('t1', 'p1', 1, 'speech', 'probe-response'),
      turn('t2', 'p1', 1, 'speech-designated', 'compare-candidates'),
      turn('t3', 'p2', 1, 'speech-free', 'respond-directly'),
      turn('t4', 'p2', 2, 'speech', 'hold-judgment'),
      turn('t5', 'p3', 2, 'speech', 'check-consistency'),
      turn('t6', 'p3', 2, 'speech', null),
      { ...turn('t7', 'p1', 2, 'vote', 'probe-response') },
    ],
  };

  const report = analyzeReasoningMetrics(state);
  assert.deepEqual(report.rosterEvidenceFocusSet, ['chronology', 'response', 'social-reaction']);
  assert.equal(report.summary.normalSpeechTurns, 6);
  assert.equal(report.summary.directiveTurns, 5);
  assert.equal(report.summary.withoutDirectiveTurns, 1);
  assert.deepEqual(report.summary.categoryCounts, { personality: 3, forced: 1, fallback: 1 });
  assert.deepEqual(report.summary.selectedModeRankDistribution, { 1: 1, 2: 2 });
  assert.equal(report.summary.primaryModeSelectionRate, 1 / 3);
  assert.equal(report.summary.forcedRate, 1 / 5);
  assert.equal(report.summary.comparableDirectiveTurns, 5);
  assert.equal(report.summary.fallbackRate, 1 / 5);
  assert.equal(report.byEvidenceFocus.response.modeDistribution['probe-response'], 1);
  assert.equal(report.byEvidenceFocus.response.modeDistribution['compare-candidates'], 1);
  assert.equal(report.byTaskType['speech-designated'].normalSpeechTurns, 1);
  assert.equal(report.byTaskType['speech-free'].normalSpeechTurns, 1);
  assert.match(formatReasoningMetricsReport(report), /primary 33\.3%/u);
});

test('reasoning metrics keeps comparable denominator explicit and warns against cross-focus fallback comparison', () => {
  const state = {
    game: { id: 'mixed' },
    players: [
      player('p1', '関係型', 'social-reaction'),
      player('p2', '反応型', 'response'),
    ],
    aiTurns: [
      turn('current-1', 'p1', 2, 'speech', 'challenge-consensus'),
      turn('current-2', 'p2', 2, 'speech', 'respond-directly'),
    ],
  };
  const report = analyzeReasoningMetrics(state);
  assert.equal(report.summary.directiveTurns, 2);
  assert.equal(report.summary.comparableDirectiveTurns, 2);
  assert.equal(report.summary.forcedRate, 1 / 2);
  const text = formatReasoningMetricsReport(report);
  assert.match(text, /forced 50\.0% \(1\/2 comparable\)/u);
  assert.match(text, /fallbackRate is not directly comparable across evidenceFocus/u);
  assert.match(text, /social-reaction includes challenge-consensus/u);
});
