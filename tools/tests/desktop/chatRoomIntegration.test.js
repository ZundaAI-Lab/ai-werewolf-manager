/**
 * 責務: チャットルームのデスクトップ保存境界が人狼ゲーム自動保存から独立し、現行schemaだけを永続化することを実挙動で検証する。
 * 変更ルール: Renderer内部のDOM配置・CSS値・関数名・IPC実装文字列を固定しない。会話Domainの仕様はgame/chatRoom.test.jsへ委譲し、ここではMain保存境界だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { ChatRoomStore, CHAT_ROOM_SCHEMA_VERSION } = require('../../../app/main/chatRoomStore.js');
const { AutosaveStore } = require('../../../app/main/autosaveStore.js');

function sampleChat(overrides = {}) {
  return {
    schemaVersion: CHAT_ROOM_SCHEMA_VERSION,
    id: 'chat-test',
    status: 'setup',
    participants: [],
    messages: [],
    ...overrides,
  };
}

test('チャット保存はゲーム自動保存と別ファイルを使用し現行製品schemaだけを受理する', async () => {
  const userData = mkdtempSync(`${tmpdir()}/aiwm-chat-store-`);
  try {
    const chatStore = new ChatRoomStore(userData);
    const autosaveStore = new AutosaveStore(userData);
    assert.notEqual(chatStore.path, autosaveStore.autosavePath);
    assert.match(chatStore.path, /chat-room-session\.json$/u);
    const saves = [
      chatStore.save(sampleChat({ topic: 'テスト1' })),
      chatStore.save(sampleChat({ topic: 'テスト2' })),
      chatStore.save(sampleChat({ topic: 'テスト3' })),
    ];
    await chatStore.flush();
    await Promise.all(saves);
    assert.equal(fs.existsSync(autosaveStore.autosavePath), false);
    assert.equal(chatStore.loadSync().topic, 'テスト3');
    assert.throws(() => chatStore.save(sampleChat({ schemaVersion: 0 })), /schemaVersion/u);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
