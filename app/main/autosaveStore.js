/**
 * 責務: ゲーム自動保存を非同期・原子的・順序保証付きで永続化する。
 * 変更ルール: ゲーム状態の意味解釈やmigration自体は行わない。読込時に旧製品schemaを検知した場合だけRenderer migration前のpre-schemaバックアップを残す。Main保存境界ではオブジェクト・JSON直列化可否・最大サイズだけを検証する。書き込み中に新しい状態を受け取った場合は最新状態を優先し、途中状態を無制限に蓄積しない。書き込み失敗時は未保存の最新状態を保持し、次回saveまたはflushから再処理できる状態に戻す。tmp本体をfsyncしてrenameし、対応環境では親ディレクトリもfsyncして電源断耐性を確保する。
 */

'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { join } = require('node:path');
const { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { backupBeforeMigrationSync } = require('./dataCompatibilityPersistence.js');
const { atomicWriteJson, atomicWriteSerializedJson } = require('./atomicJsonFile.js');

const GAME_STATE_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.GAME_STATE);

const MAX_AUTOSAVE_BYTES = 64 * 1024 * 1024;

function parseJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function serializeAutosaveDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('自動保存データはオブジェクトで指定してください。');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`自動保存データをJSONへ直列化できません: ${error.message}`);
  }
  if (typeof serialized !== 'string') {
    throw new TypeError('自動保存データをJSONへ直列化できません。');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AUTOSAVE_BYTES) {
    throw new RangeError('自動保存データが上限サイズを超えています。');
  }
  return serialized;
}

class AutosaveStore {
  #pendingSerialized = null;
  #drainPromise = null;

  constructor(userDataPath) {
    this.autosavePath = join(userDataPath, 'game-autosave.json');
    this.shutdownFailurePath = join(userDataPath, 'autosave-shutdown-warning.json');
  }

  loadSync() {
    const raw = parseJsonFile(this.autosavePath);
    if (Number.isInteger(raw?.schemaVersion) && raw.schemaVersion >= 1 && raw.schemaVersion < GAME_STATE_SCHEMA_VERSION) {
      backupBeforeMigrationSync(this.autosavePath, raw.schemaVersion);
    }
    return raw;
  }

  loadShutdownFlushFailureSync() {
    return parseJsonFile(this.shutdownFailurePath);
  }

  async recordShutdownFlushFailure(error) {
    await atomicWriteJson(this.shutdownFailurePath, {
      occurredAt: new Date().toISOString(),
      code: String(error?.code ?? 'AUTOSAVE_FLUSH_FAILED'),
      message: String(error?.message ?? error ?? '終了前の自動保存に失敗しました。'),
    });
  }

  async clearShutdownFlushFailure() {
    await rm(this.shutdownFailurePath, { force: true });
  }

  save(state) {
    this.#pendingSerialized = serializeAutosaveDocument(state);
    return this.#ensureDrain();
  }

  async flush() {
    while (this.#pendingSerialized !== null || this.#drainPromise) {
      const drainPromise = this.#drainPromise ?? this.#ensureDrain();
      await drainPromise;
    }
  }

  #ensureDrain() {
    if (this.#drainPromise) return this.#drainPromise;
    const drainPromise = this.#drain();
    this.#drainPromise = drainPromise;
    const clearCurrentDrain = () => {
      if (this.#drainPromise === drainPromise) this.#drainPromise = null;
    };
    drainPromise.then(clearCurrentDrain, clearCurrentDrain);
    return drainPromise;
  }

  async #drain() {
    while (this.#pendingSerialized !== null) {
      const latestSerialized = this.#pendingSerialized;
      this.#pendingSerialized = null;
      try {
        await atomicWriteSerializedJson(this.autosavePath, latestSerialized);
        await this.clearShutdownFlushFailure().catch(() => {});
      } catch (error) {
        if (this.#pendingSerialized === null) this.#pendingSerialized = latestSerialized;
        throw error;
      }
    }
  }
}

module.exports = { AutosaveStore };
