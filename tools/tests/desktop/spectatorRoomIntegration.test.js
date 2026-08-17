/**
 * 責務: 人狼観戦セッションのMain保存境界、追っかけ/リアルタイム統合UI配線、AI管理の共通1手進行APIへの委譲をデスクトップ統合として検証する。
 * 変更ルール: 再生盤面のDomainロジックはgame/spectatorReplay.test.jsへ委譲し、ここでは保存schema・Renderer配線・進行責務の一元化だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { SpectatorRoomStore, SPECTATOR_ROOM_SCHEMA_VERSION } = require('../../../app/main/spectatorRoomStore.js');

const projectRoot = join(__dirname, '..', '..', '..');
const read = (relativePath) => readFileSync(join(projectRoot, relativePath), 'utf8');

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
  const userData = mkdtempSync(join(tmpdir(), 'aiwm-spectator-store-'));
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

test('観戦の共通1手ボタンは追っかけ中だけReplayを進め、リアルタイム中はAI管理の共通1手APIへ委譲する', () => {
  const spectator = read('app/renderer/js/ui/controllers/spectatorRoomController.js');
  const management = read('app/renderer/js/automation/aiManagementController.js');
  const facade = read('app/renderer/js/automation/desktopAutomation.js');
  assert.match(spectator, /async function advanceHumanTableOne\(\)[\s\S]*if \(!state\.followingLive\)[\s\S]*nextHistoricalPublicEvent[\s\S]*buildPublicReplaySnapshot/u);
  assert.match(spectator, /const runSingleGameStep = window\.AiWerewolfDesktopAutomation\?\.runSingleGameStep/u);
  assert.match(spectator, /await runSingleGameStep\(\)/u);
  assert.match(management, /async function runSingleAutomaticStep\(/u);
  assert.match(management, /if \(action === 'step'\) \{[\s\S]*runSingleAutomaticStep/u);
  assert.match(facade, /runSingleGameStep: \(options = \{\}\) => aiManagementController\.runSingleAutomaticStep/u);
});

test('追っかけ中のゲームState変更は再生カーソルを自動前進させず、リアルタイム中だけ公開Snapshotを取り込む', () => {
  const spectator = read('app/renderer/js/ui/controllers/spectatorRoomController.js');
  assert.match(spectator, /if \(!state\.followingLive\) \{\s*renderIfVisible\(\);\s*return;\s*\}[\s\S]*buildPublicSnapshot\(current/u);
  assert.match(spectator, /async function jumpToLive\(\)[\s\S]*setAllObserverCursors[\s\S]*リアルタイム実況に合流しました/u);
});
