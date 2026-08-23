/**
 * 責務: AI判断状態の現在盤面射影における候補可否と日跨ぎ失効の意味契約を検証する。
 * 変更ルール: 永続状態の形や表示文言を固定せず、疑い候補の継続・当日処刑候補と投票予定の失効・対象消滅との差だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { getCurrentDecisionProjection } from '../../../app/renderer/js/domain/game/decisionTargetPolicy.js';

test('日跨ぎでは疑い候補を維持し処刑価値候補と投票予定だけを当日判断としてリセットする', () => {
  const state = createInitialState(6);
  state.game.day = 2;
  const actor = state.players[0];
  const target = state.players[1];
  actor.decisionState = {
    ...actor.decisionState,
    suspicionCandidateIds: [target.id],
    executionCandidateIds: [target.id],
    intendedVoteId: target.id,
    assessmentLevel: 'moderate',
    keyPublicEvidenceEventIds: [],
    leaveAliveBenefit: '残す利益',
    misexecutionCost: '誤処刑損失',
    selectionDifference: '候補差',
    uncertainty: '継続中の不確実性',
    nextDiscriminatingInformation: '次の確認事項',
    decisionReason: '前日の判断理由',
    updatedAt: '2026-08-22T00:00:00.000Z',
    sourceDay: 1,
  };

  const projection = getCurrentDecisionProjection(state, actor.id, { taskType: 'speech' });

  assert.deepEqual(projection.state.suspicionCandidateIds, [target.id]);
  assert.deepEqual(projection.state.executionCandidateIds, []);
  assert.equal(projection.state.intendedVoteId, null);
  assert.equal(projection.state.assessmentLevel, 'moderate');
  assert.equal(projection.state.uncertainty, '継続中の不確実性');
  assert.equal(projection.invalidation.dailyComparisonReset, true);
  assert.equal(projection.invalidation.targetContextChanged, false);
  assert.deepEqual(projection.invalidation.removedTargetIds, []);
  assert.equal(projection.invalidation.invalidationReason, 'daily-comparison-reset');
  assert.equal(projection.invalidation.usablePreviousDecision, true);
  assert.equal(projection.invalidation.requiresReevaluation, true);
  assert.equal(projection.invalidation.invalidatedSemanticFields.includes('executionCandidateIds'), true);
});
