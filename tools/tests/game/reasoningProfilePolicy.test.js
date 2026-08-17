/**
 * 責務: 推理・議論傾向の選択肢と、ゲーム用プロンプトへ投影される意味が一致していることを確認する。
 * 変更ルール: キャラクター個別データの割当は固定せず、選択肢の責務・プロンプト意味・内部参考視点の境界だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REASONING_PROFILE,
  REASONING_PROFILE_OPTION_LABELS,
} from '../../../app/renderer/js/config/constants.js';
import { buildCharacterPromptProfile } from '../../../app/renderer/js/prompts/context/characterPromptProfile.js';
import { resolveInternalReasoningDirective } from '../../../app/renderer/js/prompts/policies/characterReasoningDirector.js';
import { renderInternalReasoningDirective } from '../../../app/renderer/js/prompts/templates/characterReasoningDirectiveTemplates.js';

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

test('固定本人プロンプトへ一貫性重視と立場重視の意味をそのまま投影する', () => {
  const consistency = buildCharacterPromptProfile({ reasoningProfile: profileWith('consistency') }, { mode: 'initial-full' });
  assert.match(consistency.reasoning, /公開した内容の前後整合性/u);

  const commitment = buildCharacterPromptProfile({ reasoningProfile: profileWith('commitment') }, { mode: 'initial-full' });
  assert.match(commitment.reasoning, /公開した立場の明確さと変化/u);
});

test('立場重視は公開COなど構造化された立場がある相手へ専用参考視点を生成する', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'reasoning-commitment-test',
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
      alive: [
        { id: 'p1', name: '本人', frozen: false },
        { id: 'p2', name: '相手', frozen: false },
      ],
      dead: [],
      claims: [{ actorId: 'p2', roleId: 'seer', sourceEventId: 'speech-1' }],
      publicAbilityClaims: [],
      publicTimeline: {
        speeches: [{
          id: 'speech-1',
          actorId: 'p2',
          day: 2,
          sequence: 1,
          payload: { structured: { coOperation: { action: 'declare', roleId: 'seer' }, interaction: { questionTargetIds: [], answersEventIds: [] }, abilityClaims: [] } },
        }],
        voteResults: [],
      },
    },
  };

  const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
  assert.equal(directive?.modeId, 'inspect-commitment');
  assert.equal(directive?.lens, 'commitment');
  assert.deepEqual(directive?.focusPlayerIds, ['p2']);
  assert.deepEqual(directive?.anchorEventSequences, [1]);

  const prompt = renderInternalReasoningDirective(directive);
  assert.match(prompt, /外部から確認できる立場の置き方と変化/u);
  assert.match(prompt, /後の説明・行動・投票がどう接続/u);
  assert.doesNotMatch(prompt, /役職内訳.*優先/u);
});

test('一貫性参考視点は新情報で説明できる変更を即矛盾扱いしない', () => {
  const prompt = renderInternalReasoningDirective({
    modeId: 'check-consistency',
    focusPlayerNames: ['相手'],
    anchorEventSequences: [3, 8],
    factionOverlay: null,
  });
  assert.match(prompt, /同時に成立できない説明/u);
  assert.match(prompt, /発言3と発言8/u);
  assert.doesNotMatch(prompt, /#3|#8/u);
  assert.match(prompt, /新情報による自然な判断変更や表現差は矛盾としません/u);
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

test('多数意見再検討は対象者判定なしでDay1から成立し、集中がある場合だけ使う条件文を出す', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'challenge-consensus-day1',
      day: 1,
      rules: { discussion: { answerPriorityEnabled: true } },
      discussion: { remainingByPlayer: { p2: 1 } },
    },
    discussion: { round: 1 },
    player: {
      id: 'p1', name: '本人', roleId: 'villager', strategyProfile: null,
      character: { reasoningProfile: { ...profileWith('social-reaction'), confrontationStyle: 'moderate', questionStyle: 'focused' } },
      decisionState: { suspicionCandidateIds: [], executionCandidateIds: [], intendedVoteId: null },
    },
    board: {
      alive: [{ id: 'p1', name: '本人', frozen: false }, { id: 'p2', name: '相手', frozen: false }],
      dead: [], claims: [], publicAbilityClaims: [],
      publicTimeline: { speeches: [], voteResults: [] },
    },
  };

  const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
  assert.equal(directive?.modeId, 'challenge-consensus');
  assert.deepEqual(directive?.focusPlayerIds, []);
  const prompt = renderInternalReasoningDirective(directive);
  assert.match(prompt, /同じ人物や同じ理由へ評価が集まっていると確認できる場合/u);
  assert.match(prompt, /評価の集中が確認できない場合/u);
  assert.doesNotMatch(prompt, /現在の候補を中心に繰り返されている多数意見/u);
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

test('仮説の広さは推理レンズを追加せず選択済みレンズの保持方針だけを変える', () => {
  const context = {
    task: { type: 'speech' },
    game: {
      id: 'hypothesis-breadth-does-not-select-lens',
      day: 2,
      rules: { discussion: { answerPriorityEnabled: true } },
      discussion: { remainingByPlayer: { p2: 1, p3: 1 } },
    },
    discussion: { round: 1 },
    player: {
      id: 'p1', name: '本人', roleId: 'villager', strategyProfile: null,
      character: { reasoningProfile: { ...profileWith('consistency'), hypothesisBreadth: 'wide' } },
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
          { id: 's1', actorId: 'p2', day: 2, sequence: 1, payload: { structured: { interaction: { questionTargetIds: [], answersEventIds: [] } } } },
          { id: 's2', actorId: 'p3', day: 2, sequence: 2, payload: { structured: { interaction: { questionTargetIds: [], answersEventIds: [] } } } },
        ],
        voteResults: [],
      },
    },
  };

  const directive = resolveInternalReasoningDirective({ aiTurns: [] }, context);
  assert.equal(directive?.modeId, 'hold-judgment');
  assert.notEqual(directive?.modeId, 'compare-candidates');
  assert.equal(Object.hasOwn(directive?.identity ?? {}, 'commitmentTiming'), false);
  assert.equal(directive?.identity?.hypothesisBreadth, 'wide');
  assert.match(renderInternalReasoningDirective(directive), /複数の候補や説明を並行して保持/u);
});

test('仮説の広さ3値は同じ参考視点へ異なる保持方針としてだけ文章化される', () => {
  const base = {
    modeId: 'hold-judgment',
    focusPlayerNames: ['相手'],
    anchorEventSequences: [1],
    factionOverlay: null,
  };
  const narrow = renderInternalReasoningDirective({ ...base, identity: { hypothesisBreadth: 'narrow' } });
  const balanced = renderInternalReasoningDirective({ ...base, identity: { hypothesisBreadth: 'balanced' } });
  const wide = renderInternalReasoningDirective({ ...base, identity: { hypothesisBreadth: 'wide' } });

  assert.match(narrow, /有力な一人または少数候補へ絞/u);
  assert.match(narrow, /差が薄い場合は無理に順位を作りません/u);
  assert.match(balanced, /段階的に候補を絞ります/u);
  assert.match(wide, /早い段階で切り捨てません/u);
});


test('Prompt 140の個性レンズは比較方法をレンズ側へ持ちprobe-responseだけ必要時の質問駆動を持つ', () => {
  const base = {
    focusPlayerNames: ['相手A', '相手B'],
    anchorEventSequences: [3, 8],
    identity: { hypothesisBreadth: 'balanced' },
    factionOverlay: null,
  };
  const expectations = [
    ['probe-response', /本人の説明によって候補間の差や判断が進む場合は、その一点を具体的に質問できます/u],
    ['evaluate-response', /元の行動まで自然に説明できたか/u],
    ['trace-change', /後から得た情報を以前から知っていた根拠のようには扱いません/u],
    ['check-consistency', /新情報による自然な判断変更や表現差は矛盾としません/u],
    ['inspect-commitment', /外部から確認できる立場の置き方と変化/u],
    ['compare-pair', /口調や会話量だけではなく、公開された相互作用/u],
    ['synthesize-claims', /一つの材料だけを絶対視せず/u],
    ['compare-candidates', /他候補にも同程度に当てはまらないか/u],
    ['hold-judgment', /現在の不確実性を保持/u],
    ['evaluate-information-gain', /情報が増える経路の違い/u],
  ];

  for (const [modeId, expected] of expectations) {
    const prompt = renderInternalReasoningDirective({ ...base, modeId });
    assert.match(prompt, expected, modeId);
    if (modeId === 'probe-response') {
      assert.match(prompt, /質問しても差が付かない場合は質問を作りません/u);
    }
    assert.equal(
      prompt.match(/確認できる差がなければ、この視点から材料を作る必要はありません。/gu)?.length,
      1,
      `${modeId}: 空振り許可は一度だけ`,
    );
  }
});
