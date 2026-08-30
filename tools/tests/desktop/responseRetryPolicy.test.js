/**
 * 責務: AI応答失敗時の状態再同期、投票専用形式修復、通常・修復・再生成・通信再試行で共有する呼び出し予算を確認する。
 * 変更ルール: 一般タスクの個別バリデータ文言は固定せず、投票は既存判断を保持してrepair後に再生成へ進まない契約を明示的に検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../../app/renderer/js/ai/responseRetryPolicy.js');

test('状態不一致は回答修復せず最新プロンプト再生成へ進む', () => {
  const decision = policy.decideNext({
    recoveryMode: 'stop',
    phase: 'normal',
    commitResult: { issues: [{ code: 'STALE_PROMPT', category: 'state', message: '状態更新' }] },
  });
  assert.equal(decision.action, 'regenerate-prompt');
});

test('通常・修復・再生成とAPI通信再試行は最大4呼び出しを共有する', () => {
  assert.equal(policy.canGenerate(0), true);
  assert.equal(policy.canGenerate(3), true);
  assert.equal(policy.canGenerate(4), false);
  assert.equal(policy.DEFAULT_CALL_BUDGET, 4);
});



test('投票は形式修復を1回失敗したら新しい判断を再生成せず停止する', () => {
  const first = policy.decideNext({
    recoveryMode: 'repair-regenerate',
    phase: 'normal',
    taskType: 'vote',
    commitResult: { issues: [{ code: 'INVALID_JSON', category: 'syntax', path: '', message: 'invalid' }] },
  });
  assert.equal(first.action, 'repair');

  const second = policy.decideNext({
    recoveryMode: 'repair-regenerate',
    phase: 'repair',
    taskType: 'vote',
    commitResult: { issues: [{ code: 'INVALID_ACTION_TARGET', category: 'validation', path: 'response.actionAnswer', message: 'invalid' }] },
  });
  assert.equal(second.action, 'stop');
  assert.equal(second.reason, 'vote-repair-limit');
});

test('投票形式修復は既存投票予定と処刑候補を保持しactionAnswerだけを要求する', () => {
  const prompt = policy.buildRepairPrompt({
    originalPrompt: '長い元プロンプト',
    failedResponse: '{"actionAnswer":"無効対象","decisionPatch":{"intendedVote":"別候補"}}',
    issues: [{ code: 'INVALID_ACTION_TARGET', category: 'validation', path: 'response.actionAnswer', message: 'invalid' }],
    taskType: 'vote',
    validTargetNames: ['大江戸ちゃんこ', 'ずんだもん'],
    rejectedActionAnswer: '無効対象',
    intendedVoteName: '大江戸ちゃんこ',
    executionCandidateNames: ['大江戸ちゃんこ', 'ずんだもん'],
  });
  assert.match(prompt, /投票回答の形式修復/u);
  assert.match(prompt, /大江戸ちゃんこ/u);
  assert.match(prompt, /新しいゲーム推理や疑い先の再評価を行わず/u);
  assert.doesNotMatch(prompt, /長い元プロンプト/u);
  assert.match(prompt, /decisionPatch、factionStrategy、rationale、memoAddその他の追加項目は出力しません/u);
});

test('投票repair候補はactionAnswer以外を決定的に破棄する', () => {
  assert.deepEqual(policy.projectVoteRetryCandidate({
    actionAnswer: '大江戸ちゃんこ',
    decisionPatch: { intendedVote: 'ずんだもん' },
    rationale: '再判断',
  }), { actionAnswer: '大江戸ちゃんこ' });
  assert.equal(policy.projectVoteRetryCandidate({ rationale: '対象なし' }), null);
});
