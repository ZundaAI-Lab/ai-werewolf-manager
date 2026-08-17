/**
 * 責務: 人狼観戦の任意ログ開始、1公開ログずつの追っかけ再生、再生時点盤面、訂正履歴、神視点の未来情報遮断、観戦State/UI契約を検証する。
 * 変更ルール: Game Stateを巻き戻さずpublicReplaySnapshotで再生する契約と、追っかけ/リアルタイムを明示selectorではなく再生位置で扱う契約だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, addCorrectionEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import {
  buildPublicReplaySnapshot,
  getHistoricalPublicTimeline,
  nextHistoricalPublicEvent,
  resolvePublicReplayStart,
} from '../../../app/renderer/js/public/publicReplaySnapshot.js';
import { buildSpectatorOmniscientFeed } from '../../../app/renderer/js/domain/spectator/spectatorOmniscientFeed.js';
import {
  createSpectatorRoomState,
  SPECTATOR_ROOM_SCHEMA_VERSION,
  setSpectatorPlayback,
  updateSpectatorSettings,
} from '../../../app/renderer/js/domain/spectator/spectatorRoomState.js';
import { renderSpectatorRoomLive, renderSpectatorRoomSetup } from '../../../app/renderer/js/ui/views/chat/spectatorRoomView.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';

function gameFixture() {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.players.forEach((player) => { player.roleId = 'villager'; });
  return state;
}

function publish(state, type, payload = {}, options = {}) {
  return createEvent(state, {
    type,
    actorId: options.actorId ?? null,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload,
  });
}

test('任意ログ番号は次に存在する公開ログへ解決し、未来番号はリアルタイムへ合流する', () => {
  const state = gameFixture();
  const first = publish(state, 'system', { text: '公開1' });
  createEvent(state, { type: 'private-result', audience: { type: 'player', targetIds: [state.players[0].id] }, payload: { text: '非公開' } });
  const third = publish(state, 'system', { text: '公開3' });
  assert.deepEqual(getHistoricalPublicTimeline(state).map((event) => event.sequence), [first.sequence, third.sequence]);
  const startAtGap = resolvePublicReplayStart(state, first.sequence + 1);
  assert.equal(startAtGap.followingLive, false);
  assert.equal(startAtGap.targetEventSequence, third.sequence);
  assert.equal(startAtGap.playbackEventSequence, third.sequence - 1);
  assert.equal(nextHistoricalPublicEvent(state, startAtGap.playbackEventSequence).sequence, third.sequence);
  const future = resolvePublicReplayStart(state, third.sequence + 1);
  assert.equal(future.followingLive, true);
  assert.equal(future.playbackEventSequence, third.sequence);
});

test('追っかけ公開盤面は処刑ログ到達後だけ死亡を反映し、未来ログを含めない', () => {
  const state = gameFixture();
  const actor = state.players[0];
  const target = state.players[1];
  const speech = publish(state, 'public-speech', {
    text: '最初の発言', structured: { coOperation: { action: 'declare', roleId: 'seer' }, abilityClaims: [] },
  }, { actorId: actor.id });
  state.game.phase = 'execution';
  const execution = publish(state, 'execution', {
    text: `${target.name}を処刑しました。`, targetId: target.id, collateralPlayerIds: [], deadPlayerIds: [target.id], revealedRoleId: null,
  });
  const before = buildPublicReplaySnapshot(state, execution.sequence - 1);
  assert.equal(before.players.find((player) => player.id === target.id).alive, true);
  assert.equal(before.claims.length, 1);
  assert.deepEqual(before.events.map((event) => event.sequence), [speech.sequence]);
  const after = buildPublicReplaySnapshot(state, execution.sequence);
  assert.equal(after.players.find((player) => player.id === target.id).alive, false);
  assert.deepEqual(after.events.map((event) => event.sequence), [speech.sequence, execution.sequence]);
});

test('訂正前は元公開発言を有効として再生し、訂正到達後にvoid状態を反映する', () => {
  const state = gameFixture();
  const actor = state.players[0];
  const original = publish(state, 'public-speech', {
    text: '占い師です。', structured: { coOperation: { action: 'declare', roleId: 'seer' }, abilityClaims: [] },
  }, { actorId: actor.id });
  const correction = addCorrectionEvent(state, {
    targetEventId: original.id,
    reason: '発言登録を訂正',
    replacementText: '先ほどの発言を訂正します。',
  });
  const replacement = publish(state, 'public-speech', {
    text: '霊能者です。', structured: { coOperation: { action: 'declare', roleId: 'medium' }, abilityClaims: [] },
  }, { actorId: actor.id });
  const beforeCorrection = buildPublicReplaySnapshot(state, original.sequence);
  assert.equal(beforeCorrection.events.some((event) => event.id === original.id), true);
  assert.equal(beforeCorrection.claims[0]?.roleId, 'seer');
  const atCorrection = buildPublicReplaySnapshot(state, correction.sequence);
  assert.equal(atCorrection.events.some((event) => event.id === original.id), false);
  assert.equal(atCorrection.events.some((event) => event.id === correction.id), true);
  const afterReplacement = buildPublicReplaySnapshot(state, replacement.sequence);
  assert.equal(afterReplacement.claims[0]?.roleId, 'medium');
});

test('神視点の動的陣営と生死は再生cutoff以前の状態だけを使う', () => {
  const state = gameFixture();
  const zashiki = state.players[0];
  zashiki.roleId = 'zashikiWarashi';
  zashiki.roleState = { ownerId: state.players[1].id, ownerRoleId: 'wolf', resolvedTeam: 'wolf' };
  const opening = publish(state, 'system', { text: '開始' });
  const resolution = createEvent(state, {
    type: 'private-result', actorId: zashiki.id, audience: { type: 'player', targetIds: [zashiki.id] },
    payload: { actionType: 'choose-owner', targetId: state.players[1].id, ownerRoleId: 'wolf', resolvedTeam: 'wolf' },
  });
  const death = publish(state, 'execution', { text: '処刑', deadPlayerIds: [zashiki.id], collateralPlayerIds: [] });
  const beforeResolutionSnapshot = buildPublicReplaySnapshot(state, opening.sequence);
  const beforeResolution = buildSpectatorOmniscientFeed(state, { publicSnapshot: beforeResolutionSnapshot, cutoffSequence: opening.sequence });
  assert.equal(beforeResolution.players.find((player) => player.name === zashiki.name).teamId, '');
  assert.equal(beforeResolution.players.find((player) => player.name === zashiki.name).alive, true);
  const afterResolutionSnapshot = buildPublicReplaySnapshot(state, resolution.sequence);
  const afterResolution = buildSpectatorOmniscientFeed(state, { publicSnapshot: afterResolutionSnapshot, cutoffSequence: resolution.sequence });
  assert.equal(afterResolution.players.find((player) => player.name === zashiki.name).teamId, 'wolf');
  const afterDeathSnapshot = buildPublicReplaySnapshot(state, death.sequence);
  const afterDeath = buildSpectatorOmniscientFeed(state, { publicSnapshot: afterDeathSnapshot, cutoffSequence: death.sequence });
  assert.equal(afterDeath.players.find((player) => player.name === zashiki.name).alive, false);
});

test('観戦Stateは追っかけ再生位置と観戦コメント自動生成を現行schemaで保存する', () => {
  const state = createSpectatorRoomState({ participants: [{ characterId: 'a', profileId: 'p1' }, { characterId: 'b', profileId: 'p2' }] });
  assert.equal(SPECTATOR_ROOM_SCHEMA_VERSION, 1);
  assert.equal(state.autoComment, true);
  assert.equal(Object.hasOwn(state, 'autoFollow'), false);
  updateSpectatorSettings(state, { autoComment: false, startLogNumber: 32 });
  setSpectatorPlayback(state, { followingLive: false, publicRevision: 12, eventSequence: 31, factSignature: 'x' });
  assert.equal(state.autoComment, false);
  assert.equal(state.startLogNumber, 32);
  assert.equal(state.followingLive, false);
  assert.equal(state.playbackEventSequence, 31);
});

test('観戦UIは任意開始ログ・共通1手ボタン・追っかけ時リアルタイム移動を表示する', () => {
  const state = createSpectatorRoomState({ participants: [{ characterId: 'a', profileId: 'p1' }, { characterId: 'b', profileId: 'p2' }] });
  const groups = [{ id: 'g', name: 'G', enabled: true, characters: [{ id: 'a', name: 'A', enabled: true }, { id: 'b', name: 'B', enabled: true }] }];
  const profiles = [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }];
  const setup = renderSpectatorRoomSetup({ state, groups, profiles, gameView: { status: 'running', title: 'T', day: 1, phaseLabel: '昼議論', latestEventSequence: 40 } });
  assert.match(setup, /data-spectator-field="start-log-number"/u);
  assert.match(setup, /現在の最新ログ: #40/u);
  assert.match(setup, /観戦コメントを自動生成/u);
  state.status = 'active';
  state.followingLive = false;
  state.playbackEventSequence = 31;
  const live = renderSpectatorRoomLive({ state, groups, profiles, publicView: { followingLive: false, nextEventSequence: 32, latestEventSequence: 40, day: 2, phaseLabel: '昼議論' } });
  assert.match(live, /人狼卓を1手進める/u);
  assert.match(live, /リアルタイムへ移動/u);
  assert.match(live, /追っかけ · 次 #32 \/ 最新 #40/u);
  assert.match(live, /再生中の公開盤面/u);
});
