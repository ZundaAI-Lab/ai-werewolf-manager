/**
 * 責務: 人狼ゲームStateとは独立したチャットルーム最新セッションの保存先とschema境界を定義する。
 * 変更ルール:
 * - 会話順・質問優先・AI生成などRenderer側の意味解釈を行わない。
 * - 保存機構はJsonDocumentStoreへ委譲し、チャット固有のfilename・schemaKind・最大サイズ・表示ラベルだけを所有する。
 * - ゲーム自動保存ファイルや観戦ルーム保存へ混在させない。
 */

'use strict';

const { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { JsonDocumentStore } = require('./jsonDocumentStore.js');

const CHAT_ROOM_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.CHAT_ROOM);
const MAX_CHAT_ROOM_BYTES = 8 * 1024 * 1024;

class ChatRoomStore extends JsonDocumentStore {
  constructor(userDataPath) {
    super(userDataPath, {
      filename: 'chat-room-session.json',
      schemaKind: DATA_SCHEMA_KIND.CHAT_ROOM,
      maxBytes: MAX_CHAT_ROOM_BYTES,
      label: 'チャットルーム保存データ',
    });
  }
}

module.exports = { CHAT_ROOM_SCHEMA_VERSION, ChatRoomStore };
