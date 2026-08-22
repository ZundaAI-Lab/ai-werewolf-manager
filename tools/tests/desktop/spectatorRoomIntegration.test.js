/**
 * 責務: 人狼観戦セッションのMain保存境界が現行schemaと追っかけ再生位置を正しく永続化することを実挙動で検証する。
 * 変更ルール: Renderer内部の関数名・配線文字列を固定しない。再生Domainの挙動はgame/spectatorReplay.test.jsへ委譲し、ここではMain保存境界だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { SpectatorRoomStore, SPECTATOR_ROOM_SCHEMA_VERSION } = require('../../../app/main/spectatorRoomStore.js');

function sampleSpectator(overrides = {}) {
  return {
    schemaVersion: SPECTATOR_ROOM_SCHEMA_VERSION,
    id: 'spectator-test',
    status: 'active',
    followingLive: false,
    playbackEventSequence: 31,
    participants: [],
    messages: [],
    ...overrides,
  };
}

test('観戦保存は現行製品schemaで追っかけ再生位置を独立保存する', async () => {
  assert.equal(SPECTATOR_ROOM_SCHEMA_VERSION, 1);
  const userData = mkdtempSync(`${tmpdir()}/aiwm-spectator-store-`);
  try {
    const store = new SpectatorRoomStore(userData);
    await store.save(sampleSpectator());
    await store.flush();
    const loaded = store.loadSync();
    assert.equal(loaded.followingLive, false);
    assert.equal(loaded.playbackEventSequence, 31);
    assert.throws(() => store.save(sampleSpectator({ schemaVersion: 0 })), /schemaVersion/u);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
