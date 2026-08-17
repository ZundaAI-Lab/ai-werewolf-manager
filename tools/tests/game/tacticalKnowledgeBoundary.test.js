/**
 * 責務: 局面戦術、公開差分、本人および他プレイヤーの公開能力結果整合性、襲撃候補ごとの公開主張上の注意事実が、対象本人の既知情報・陣営共有情報・公開情報だけで不変に計算されることを検証する。
 * 変更ルール: 公開盤面を固定したままGM内部役職や他者の非公開構造化判断だけを変更し、候補・戦略更新・生成プロンプトが変化しないことを確認する。白狼固有の占い候補分岐は白狼入り配役と通常配役を対にし、他者の矛盾は能力者COごとに検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCounterClaimOpportunity } from '../../../app/renderer/js/domain/claims/counterClaimOpportunityPolicy.js';
import { resolveOwnerClaimCorroborationOpportunity } from '../../../app/renderer/js/domain/claims/ownerClaimCorroborationPolicy.js';
import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import { resolveFactionStrategyUpdatePolicy } from '../../../app/renderer/js/domain/game/factionStrategyUpdatePolicy.js';
import { buildZashikiWarashiStrategy } from '../../../app/renderer/js/domain/game/zashikiWarashiStrategy.js';
import { createRoleState } from '../../../app/renderer/js/domain/roles/roleState.js';
import { applySetupRoles } from '../../../app/renderer/js/domain/setup/setupRoles.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { synchronizePlayerKnowledgeForTest } from './testStateHelpers.js';

function createDiscussionState(roleIds) {
  const state = createInitialState(roleIds.length);
  applySetupRoles(state.players, roleIds);
  state.game.status = 'running';
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.players.forEach((player) => { player.aiContextStatus = 'initialized'; });
  const ids = state.players.map((player) => player.id);
  state.discussion = {
    day: 1,
    mode: 'ordered',
    modeControl: null,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: [...ids],
    queue: [...ids],
    currentIndex: 0,
    designatedPlayerId: null,
    spokenInCurrentRound: [],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])),
    allDeferred: false,
    remainingByPlayer: Object.fromEntries(ids.map((id) => [id, 3])),
    reconsideration: {
      pending: false,
      active: false,
      items: [],
      reasons: [],
      sourceEventIds: [],
      affectedPlayerIds: [],
      updatedAt: null,
      handledRound: null,
    },
    completed: false,
  };
  synchronizePlayerKnowledgeForTest(state);
  return state;
}

function publishRoleClaim(state, actor, roleId, abilityClaims = []) {
  const event = createEvent(state, {
    type: 'public-speech',
    actorId: actor.id,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: {
      text: `${actor.name}が${roleId}をCOしました。`,
      pass: false,
      speechKind: 'normal',
      sourceQuestionEventId: null,
      round: 1,
      roundKind: 'normal',
      opportunityContext: { remainingByPlayerAtSpeechStart: {} },
      structured: {
        coOperation: { action: 'declare', roleId },
        interaction: { questionTargetIds: [], answersEventIds: [] },
        abilityClaims,
      },
    },
  });
  state.claims.push({
    id: `claim:${event.id}`,
    actorId: actor.id,
    roleId,
    day: 1,
    status: 'active',
    sourceEventId: event.id,
    withdrawnByEventId: null,
    voidedByEventId: null,
  });
  abilityClaims.forEach((claim, index) => {
    state.publicAbilityClaims.push({
      id: `ability-claim:${event.id}:${index}`,
      actorId: actor.id,
      claimedRoleId: roleId,
      actionType: claim.actionType,
      targetId: claim.targetId,
      result: claim.result,
      observedDay: 1,
      announcedDay: 1,
      selectionBasis: 'no-public-information',
      evidenceEventIds: [],
      selectionReasonAtTime: '公開済みテスト結果',
      sourceEventId: event.id,
      sourceClaimIndex: index,
      status: 'active',
      voidedByEventId: null,
    });
  });
  return event;
}

function publishPlainSpeech(state, actor, text) {
  return createEvent(state, {
    type: 'public-speech',
    actorId: actor.id,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: {
      text,
      pass: false,
      speechKind: 'normal',
      sourceQuestionEventId: null,
      round: 1,
      roundKind: 'normal',
      opportunityContext: { remainingByPlayerAtSpeechStart: {} },
      structured: {
        coOperation: { action: 'none', roleId: 'none' },
        interaction: { questionTargetIds: [], answersEventIds: [] },
        abilityClaims: [],
      },
    },
  });
}



test('公開配役人数が同じなら他者の秘密役職配置順を入れ替えてもプロンプト全文と配役構成順は変化しない', () => {
  const state = createDiscussionState(['villager', 'seer', 'medium', 'wolf', 'villager']);
  const actor = state.players[0];
  const before = buildPromptContext(state, actor.id, { taskType: 'speech' });

  [state.players[1].roleId, state.players[2].roleId] = [state.players[2].roleId, state.players[1].roleId];
  const after = buildPromptContext(state, actor.id, { taskType: 'speech' });

  assert.deepEqual(after.context.game.roleComposition, before.context.game.roleComposition);
  assert.equal(after.text, before.text);
});

test('人狼陣営の対抗CO候補は公開COと公開能力結果が同じなら他者の真役職変更で変化しない', () => {
  const state = createDiscussionState(['madman', 'seer', 'medium', 'villager', 'wolf', 'whiteWolf']);
  const [actor, seerClaimant, mediumClaimant, villager] = state.players;
  publishRoleClaim(state, seerClaimant, 'seer', [{
    actionType: 'inspect',
    targetId: mediumClaimant.id,
    result: 'wolf',
  }]);
  publishRoleClaim(state, mediumClaimant, 'medium');

  const before = resolveCounterClaimOpportunity(state, { playerId: actor.id, taskType: 'speech' });
  [seerClaimant.roleId, villager.roleId] = [villager.roleId, seerClaimant.roleId];

  assert.deepEqual(resolveCounterClaimOpportunity(state, { playerId: actor.id, taskType: 'speech' }), before);
  const afterPrompt = buildPromptContext(state, actor.id, { taskType: 'speech' }).text;
  assert.match(afterPrompt, /霊能対抗COで単独確定を防ぎ/u);
  assert.match(afterPrompt, /単独COを放置すると村側の推理軸が固定されやすく/u);
  assert.match(afterPrompt, /潜伏する場合は何を温存し、どの局面で使うか明確に/u);
});


test('白狼不在時の過剰な人狼結果は通常ルールの文言だけで警告する', () => {
  const state = createDiscussionState(['seer', 'wolf', 'villager', 'villager']);
  const [seer, , firstBlack, secondBlack] = state.players;
  publishRoleClaim(state, seer, 'seer', [
    { actionType: 'inspect', targetId: firstBlack.id, result: 'wolf' },
    { actionType: 'inspect', targetId: secondBlack.id, result: 'wolf' },
  ]);

  const built = buildPromptContext(state, seer.id, { taskType: 'speech' });
  assert.deepEqual(built.decision.ownPublicClaimConsistency.contradictionWarnings, [
    '公開済み人狼結果が、配役上の人狼数を超えています。',
  ]);
  assert.doesNotMatch(built.text, /白狼/u);
});


test('終盤戦術は公開配役の人狼枠と狂人枠だけで表示判定し、全陣営の戦術的COを許可する', () => {
  const early = createDiscussionState(['villager', 'villager', 'villager', 'villager', 'wolf', 'madman']);
  const earlyPrompt = buildPromptContext(early, early.players[0].id, { taskType: 'speech' }).text;
  assert.doesNotMatch(earlyPrompt, /## 終盤の陣営戦術/u);
  assert.doesNotMatch(earlyPrompt, /roleIdは本人の真役職ではなく今回publicSpeechで名乗る役職/u);

  const endgame = createDiscussionState(['villager', 'villager', 'wolf', 'madman']);
  const villagePrompt = buildPromptContext(endgame, endgame.players[0].id, { taskType: 'speech' }).text;
  assert.match(villagePrompt, /## 終盤の陣営戦術/u);
  assert.match(villagePrompt, /村人陣営.*人狼CO.*PP・RPPを崩す/u);
  assert.match(villagePrompt, /roleIdは本人の真役職ではなく今回publicSpeechで名乗る役職/u);
  assert.match(villagePrompt, /villager.*madman.*wolf/u);

  const wolfPrompt = buildPromptContext(endgame, endgame.players[2].id, { taskType: 'speech' }).text;
  assert.match(wolfPrompt, /人狼枠.*狂人枠候補.*票を接続/u);

  const madmanPrompt = buildPromptContext(endgame, endgame.players[3].id, { taskType: 'speech' }).text;
  assert.match(madmanPrompt, /狂人枠.*狂人CO・人狼CO.*推定人狼/u);

  const madmanVotePrompt = buildPromptContext(endgame, endgame.players[3].id, { taskType: 'vote' }).text;
  assert.match(madmanVotePrompt, /## 終盤の狂人枠投票/u);
  assert.match(madmanVotePrompt, /従来主張と矛盾する投票も選べ/u);

  const wolfVotePrompt = buildPromptContext(endgame, endgame.players[2].id, { taskType: 'vote' }).text;
  assert.doesNotMatch(wolfVotePrompt, /## 終盤の狂人枠投票/u);

  const snowEndgame = createDiscussionState(['villager', 'villager', 'wolf', 'snowWoman']);
  const snowVotePrompt = buildPromptContext(snowEndgame, snowEndgame.players[3].id, { taskType: 'vote' }).text;
  assert.match(snowVotePrompt, /## 終盤の狂人枠投票/u);
});


test('人狼陣営化した座敷わらし本人は終盤戦術で狂人枠として扱う', () => {
  const state = createDiscussionState(['zashikiWarashi', 'villager', 'wolf', 'madman']);
  const [zashiki, , wolf] = state.players;
  zashiki.roleState = createRoleState('zashikiWarashi', {
    ownerId: wolf.id,
    ownerRoleId: 'wolf',
    resolvedTeam: 'wolf',
  });
  synchronizePlayerKnowledgeForTest(state);

  const prompt = buildPromptContext(state, zashiki.id, { taskType: 'speech' }).text;
  assert.match(prompt, /## 終盤の陣営戦術/u);
  assert.match(prompt, /狂人枠.*狂人CO・人狼CO.*推定人狼/u);
  assert.doesNotMatch(prompt, /村人陣営では/u);

  const votePrompt = buildPromptContext(state, zashiki.id, { taskType: 'vote' }).text;
  assert.match(votePrompt, /## 終盤の狂人枠投票/u);
});
