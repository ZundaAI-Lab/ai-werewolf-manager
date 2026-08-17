/**
 * 責務: 人狼ゲームState・自由チャットStateとは独立した観戦ルーム最新セッションの保存先とschema境界を定義する。
 * 変更ルール:
 * - 推理観戦/神視点観戦の意味解釈・秘密情報の生成・AI生成を行わない。
 * - 保存機構はJsonDocumentStoreへ委譲し、観戦固有のfilename・schemaKind・最大サイズ・表示ラベルだけを所有する。
 * - ゲーム自動保存ファイルや自由チャット保存へ混在させない。
 */

'use strict';

const { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { JsonDocumentStore } = require('./jsonDocumentStore.js');

const SPECTATOR_ROOM_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.SPECTATOR_ROOM);
const MAX_SPECTATOR_ROOM_BYTES = 8 * 1024 * 1024;

class SpectatorRoomStore extends JsonDocumentStore {
  constructor(userDataPath) {
    super(userDataPath, {
      filename: 'spectator-room-session.json',
      schemaKind: DATA_SCHEMA_KIND.SPECTATOR_ROOM,
      maxBytes: MAX_SPECTATOR_ROOM_BYTES,
      label: '観戦ルーム保存データ',
    });
  }
}

module.exports = { SPECTATOR_ROOM_SCHEMA_VERSION, SpectatorRoomStore };
