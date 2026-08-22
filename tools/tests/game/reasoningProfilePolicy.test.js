/**
 * 責務: 推理・議論傾向の選択肢と内部参考視点ポリシーの境界が一致していることを確認する。
 * 変更ルール: キャラクター個別データや自然言語表現を固定せず、選択肢集合、参考視点の選択条件、質問・対立傾向との責務分離だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REASONING_PROFILE,
  REASONING_PROFILE_OPTION_LABELS,
} from '../../../app/renderer/js/config/constants.js';

import { resolveInternalReasoningDirective } from '../../../app/renderer/js/prompts/policies/characterReasoningDirector.js';


function profileWith(evidenceFocus) {
  return { ...DEFAULT_REASONING_PROFILE, evidenceFocus };
}

test('evidenceFocusは人物由来の6種類だけを公開し旧人狼専門項目を残さない', () => {
  assert.deepEqual(Object.keys(REASONING_PROFILE_OPTION_LABELS.evidenceFocus), [
    'balanced',
    'response',
    'chronology',
    'consistency',
    'commitment',
    'social-reaction',
  ]);
  assert.equal(Object.hasOwn(REASONING_PROFILE_OPTION_LABELS.evidenceFocus, 'vote'), false);
  assert.equal(Object.hasOwn(REASONING_PROFILE_OPTION_LABELS.evidenceFocus, 'role-structure'), false);
});

test('指名制・発言希望制も通常発言と同じ非公開参考視点を解決する', () => {
  for (const taskType of ['speech-designated', 'speech-free']) {
    const context = {
      task: { type: taskType },
      game: {
        id: `reasoning-${taskType}`,
        day: 2,
        rules: { discussion: { answerPriorityEnabled: true } },
        discussion: { remainingByPlayer: { p2: 1 } },
      },
      discussion: { round: 1 },
      player: {
        id: 'p1',
        name: '本人',
        roleId: 'villager',
        strategyProfile: null,
        character: { reasoningProfile: profileWith('commitment') },
        decisionState: { suspicionCandidateIds: [], executionCandidateIds: [], intendedVoteId: null },
      },
      board: {
        alive: [{ id: 'p1', name: '本人', frozen: false }, { id: 'p2', name: '相手', frozen: false }],
        dead: [],
        claims: [{ actorId: 'p2', roleId: 'seer', sourceEventId: 'speech-1' }],
        publicAbilityClaims: [],
        publicTimeline: {
          speeches: [{
            id: 'speech-1', actorId: 'p2', day: 2, sequence: 1,
            payload: { structured: { coOperation: { action: 'declare', roleId: 'seer' }, interaction: { questionTargetIds: [], answersEventIds: [] }, abilityClaims: [] } },
          }],
          voteResults: [],
        },
      },
    };
    const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
    assert.equal(directive?.modeId, 'inspect-commitment', `${taskType}でも通常発言レンズを解決する`);
  }
});

test('関係性比較は前日までの構造化質問関係を日跨ぎで保持する', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'relationship-across-days-1',
      day: 2,
      rules: { discussion: { answerPriorityEnabled: true } },
      discussion: { remainingByPlayer: { p2: 1, p3: 1 } },
    },
    discussion: { round: 1 },
    player: {
      id: 'p1', name: '本人', roleId: 'villager', strategyProfile: null,
      character: { reasoningProfile: { ...profileWith('social-reaction'), confrontationStyle: 'moderate', questionStyle: 'focused' } },
      decisionState: { suspicionCandidateIds: [], executionCandidateIds: [], intendedVoteId: null },
    },
    board: {
      alive: [
        { id: 'p1', name: '本人', frozen: false },
        { id: 'p2', name: 'A', frozen: false },
        { id: 'p3', name: 'B', frozen: false },
      ],
      dead: [], claims: [], publicAbilityClaims: [],
      publicTimeline: {
        speeches: [
          { id: 'q1', actorId: 'p2', day: 1, sequence: 1, payload: { structured: { interaction: { questionTargetIds: ['p3'], answersEventIds: [] } } } },
          { id: 'a1', actorId: 'p3', day: 1, sequence: 2, payload: { structured: { interaction: { questionTargetIds: [], answersEventIds: ['q1'] } } } },
        ],
        voteResults: [],
      },
    },
  };

  const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
  assert.equal(directive?.modeId, 'compare-pair');
  assert.deepEqual(new Set(directive?.focusPlayerIds), new Set(['p2', 'p3']));
  assert.deepEqual(directive?.anchorEventSequences, [1, 2]);
});

test('回答評価はprobe-response直後に別の強制ターンを挟んでも未消化質問を追跡する', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'evaluate-response-chain',
      day: 2,
      rules: { discussion: { answerPriorityEnabled: true } },
      discussion: { remainingByPlayer: { p2: 1, p3: 1 } },
    },
    discussion: { round: 2 },
    player: {
      id: 'p1', name: '本人', roleId: 'villager', strategyProfile: null,
      character: { reasoningProfile: profileWith('response') },
      decisionState: { suspicionCandidateIds: [], executionCandidateIds: [], intendedVoteId: null },
    },
    board: {
      alive: [
        { id: 'p1', name: '本人', frozen: false },
        { id: 'p2', name: '質問先', frozen: false },
        { id: 'p3', name: '別質問者', frozen: false },
      ],
      dead: [], claims: [], publicAbilityClaims: [],
      publicTimeline: {
        speeches: [
          { id: 'question', actorId: 'p1', day: 2, sequence: 10, payload: { structured: { interaction: { questionTargetIds: ['p2'], answersEventIds: [] } } } },
          { id: 'interrupt', actorId: 'p3', day: 2, sequence: 11, payload: { structured: { interaction: { questionTargetIds: ['p1'], answersEventIds: [] } } } },
          { id: 'own-answer', actorId: 'p1', day: 2, sequence: 12, payload: { structured: { interaction: { questionTargetIds: [], answersEventIds: ['interrupt'] } } } },
          { id: 'response', actorId: 'p2', day: 2, sequence: 13, payload: { structured: { interaction: { questionTargetIds: [], answersEventIds: ['question'] } } } },
        ],
        voteResults: [],
      },
    },
  };
  const state = {
    aiTurns: [
      {
        taskType: 'speech', playerId: 'p1', day: 2,
        resolvedInternalReasoningDirective: {
          modeId: 'probe-response', focusPlayerIds: ['p2'], anchorEventSequences: [8], publicSequenceAtGeneration: 9,
        },
      },
      {
        taskType: 'speech', playerId: 'p1', day: 2,
        resolvedInternalReasoningDirective: {
          modeId: 'respond-directly', focusPlayerIds: ['p3'], anchorEventSequences: [11], publicSequenceAtGeneration: 11,
        },
      },
    ],
  };

  const directive = resolveInternalReasoningDirective(state, context);
  assert.equal(directive?.modeId, 'evaluate-response');
  assert.deepEqual(directive?.focusPlayerIds, ['p2']);
  assert.deepEqual(directive?.anchorEventSequences, [13]);
});

test('質問方法は推理レンズを追加せず関係性比較の選択元にならない', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'question-style-does-not-select-lens',
      day: 2,
      rules: { discussion: { answerPriorityEnabled: true } },
      discussion: { remainingByPlayer: { p2: 1, p3: 1 } },
    },
    discussion: { round: 1 },
    player: {
      id: 'p1', name: '本人', roleId: 'villager', strategyProfile: null,
      character: { reasoningProfile: { ...profileWith('consistency'), questionStyle: 'broad' } },
      decisionState: { suspicionCandidateIds: [], executionCandidateIds: [], intendedVoteId: null },
    },
    board: {
      alive: [
        { id: 'p1', name: '本人', frozen: false },
        { id: 'p2', name: 'A', frozen: false },
        { id: 'p3', name: 'B', frozen: false },
      ],
      dead: [], claims: [], publicAbilityClaims: [],
      publicTimeline: {
        speeches: [
          { id: 'q1', actorId: 'p2', day: 2, sequence: 1, payload: { structured: { interaction: { questionTargetIds: ['p3'], answersEventIds: [] } } } },
          { id: 'a1', actorId: 'p3', day: 2, sequence: 2, payload: { structured: { interaction: { questionTargetIds: [], answersEventIds: ['q1'] } } } },
        ],
        voteResults: [],
      },
    },
  };

  const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
  assert.equal(directive?.modeId, 'hold-judgment');
  assert.notEqual(directive?.modeId, 'compare-pair');
});

test('対立表現は推理レンズを追加せず多数意見再検討の選択元にならない', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'confrontation-style-does-not-select-lens',
      day: 2,
      rules: { discussion: { answerPriorityEnabled: true } },
      discussion: { remainingByPlayer: { p2: 1 } },
    },
    discussion: { round: 1 },
    player: {
      id: 'p1', name: '本人', roleId: 'villager', strategyProfile: null,
      character: { reasoningProfile: { ...profileWith('consistency'), confrontationStyle: 'direct' } },
      decisionState: { suspicionCandidateIds: [], executionCandidateIds: [], intendedVoteId: null },
    },
    board: {
      alive: [{ id: 'p1', name: '本人', frozen: false }, { id: 'p2', name: '相手', frozen: false }],
      dead: [], claims: [], publicAbilityClaims: [],
      publicTimeline: { speeches: [], voteResults: [] },
    },
  };

  const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
  assert.equal(directive, null);
});

