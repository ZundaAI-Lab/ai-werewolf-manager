/**
 * 責務: AI応答のtaskType/mode対応、機械許可キー、完全例、Structured Output Schema、保存済み判断の再提示境界を確認する。
 * 変更ルール: 自然言語の説明文を固定せず、外部JSONキー・Schema・許可値・内部保存表現の機械契約だけを直接検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResponseContractExample,
  getResponseModeForTask,
  getResponseTopLevelKeys,
} from '../../../app/renderer/js/prompts/response/responseContract.js';
import { buildActiveResponseContractExample } from '../../../app/renderer/js/prompts/response/activeResponseContract.js';
import { buildStructuredOutputContract } from '../../../app/renderer/js/prompts/response/structuredOutputContract.js';
import { latestDecisionState } from '../../../app/renderer/js/prompts/sections/privateInformationSection.js';

const claimRolePolicy = Object.freeze({
  coRoleIds: Object.freeze(['seer', 'medium']),
  abilityClaimRoleIds: Object.freeze(['seer', 'medium']),
});

const partnerDispositionPolicy = Object.freeze({
  allowedValues: Object.freeze(['independent', 'support', 'separate']),
});

test('雪女のfreezeは専用応答モードを保ったまま個人夜行動として分類する', () => {
  assert.equal(getResponseModeForTask('freeze'), 'freeze-action');
});

test('夜行動・襲撃・雪女は理由と比較をフェーズ主形式に維持する', () => {
  assert.deepEqual(Object.keys(buildActiveResponseContractExample({ mode: 'night-action', roleId: 'seer' })), [
    'actionAnswer', 'rationale',
  ]);
  assert.deepEqual(Object.keys(buildActiveResponseContractExample({ mode: 'attack-action', roleId: 'wolf' })), [
    'actionAnswer', 'attackAssessment', 'rationale',
  ]);
  assert.deepEqual(Object.keys(buildActiveResponseContractExample({
    mode: 'freeze-action', roleId: 'snowWoman', freezeEstimateLimit: { min: 1, max: 3 },
  })), ['estimate', 'actionAnswer', 'rationale']);
});

test('全モードの完全例キーは機械許可キーの範囲内にある', () => {
  for (const [mode, roleId] of [
    ['speech', 'wolf'], ['speech-designated', 'wolf'], ['speech-free', 'wolf'],
    ['discussion-opening-preference', 'villager'], ['priority-answer', 'seer'], ['testament', 'seer'],
    ['vote', 'wolf'], ['wolf', 'wolf'], ['mason', 'mason'], ['graveyard', 'villager'],
    ['attack-action', 'wolf'], ['freeze-action', 'snowWoman'], ['night-action', 'seer'],
    ['none', 'villager'], ['public-only', 'villager'], ['memo', 'villager'],
  ]) {
    const example = buildResponseContractExample({ mode, roleId, claimRolePolicy, partnerDispositionPolicy });
    const allowed = new Set(getResponseTopLevelKeys(mode));
    assert.equal(Object.keys(example).every((key) => allowed.has(key)), true, mode);
  }
});

test('briefingは応答不要modeへ明示対応し未知taskTypeと未知modeは即時拒否する', () => {
  assert.equal(getResponseModeForTask('briefing'), 'none');
  assert.deepEqual(getResponseTopLevelKeys('none'), []);

  assert.throws(() => getResponseModeForTask('night-action'), /未定義のAIタスク種別/u);
  assert.throws(() => getResponseModeForTask(''), /未定義のAIタスク種別/u);
  assert.throws(() => getResponseTopLevelKeys('action'), /未定義のAI応答モード/u);
});

test('voteの前回判断表示はintendedVoteとdecisionReasonを再提示せず比較材料だけを残す', () => {
  const context = {
    task: { type: 'vote' },
    player: {
      decisionState: {
        updatedAt: '2026-08-12T00:00:00Z',
        suspicionCandidateIds: ['p2'],
        executionCandidateIds: ['p2'],
        intendedVoteId: 'p2',
        assessmentLevel: 'moderate',
        keyPublicEvidenceEventIds: [],
        leaveAliveBenefit: '追加情報',
        misexecutionCost: '誤処刑損失',
        selectionDifference: '候補差',
        uncertainty: '未確定',
        nextDiscriminatingInformation: '次の情報',
        decisionReason: '前回の投票理由',
      },
      decisionInvalidation: null,
    },
    board: {
      alive: [{ id: 'p2', name: '候補A' }],
      dead: [],
      publicTimeline: {},
    },
  };
  const voteState = latestDecisionState(context, null, { taskType: 'vote' });
  assert.equal(Object.hasOwn(voteState, 'intendedVote'), false);
  assert.equal(Object.hasOwn(voteState, 'decisionReason'), false);
  assert.equal(voteState.selectionDifference, '候補差');

  const speechState = latestDecisionState(context, null, { taskType: 'speech' });
  assert.equal(speechState.intendedVote, '候補A');
  assert.equal(speechState.decisionReason, '前回の投票理由');
});

test('vote structured schemaも単独狼のpartnerDispositionをchanges候補へ含めない', () => {
  const state = {
    players: [
      { id: 'wolf-1', name: '狼A', roleId: 'wolf', alive: true },
      { id: 'village-1', name: '村A', roleId: 'villager', alive: true },
    ],
    playerKnowledge: { 'wolf-1': { knownWolfIds: ['wolf-1'] } },
    game: { rules: { vote: { abstentionAllowed: false } } },
  };
  const contract = buildStructuredOutputContract(state, {
    taskType: 'vote',
    playerId: 'wolf-1',
    validTargetIds: ['village-1'],
  });
  const changes = contract.schema.properties.factionStrategy.properties.changes.properties;
  assert.equal(Object.hasOwn(changes, 'partnerDisposition'), false);
  assert.equal(Object.hasOwn(changes, 'dayWinPath'), true);
});

