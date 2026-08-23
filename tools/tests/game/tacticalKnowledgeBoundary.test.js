/**
 * 責務: 局面戦術、公開差分、本人および他プレイヤーの公開能力結果整合性、襲撃候補ごとの公開主張上の注意事実が、対象本人の既知情報・陣営共有情報・公開情報だけで不変に計算されることを検証する。
 * 変更ルール: 公開盤面を固定したままGM内部役職や他者の非公開構造化判断だけを変更し、候補・戦略更新・生成プロンプトが変化しないことを確認する。白狼固有の占い候補分岐は白狼入り配役と通常配役を対にし、他者の矛盾は能力者COごとに検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';


import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';



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
      actionDay: 0,
      actionPhase: 'night',
      availableDay: 1,
      availablePhase: 'day',
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

test('公開配役人数が同じなら他者の秘密役職配置順を入れ替えてもプロンプト全文と配役構成順は変化しない', () => {
  const state = createDiscussionState(['villager', 'seer', 'medium', 'wolf', 'villager']);
  const actor = state.players[0];
  const before = buildPromptContext(state, actor.id, { taskType: 'speech' });

  [state.players[1].roleId, state.players[2].roleId] = [state.players[2].roleId, state.players[1].roleId];
  const after = buildPromptContext(state, actor.id, { taskType: 'speech' });

  assert.deepEqual(after.context.game.roleComposition, before.context.game.roleComposition);
  assert.equal(after.text, before.text);
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


