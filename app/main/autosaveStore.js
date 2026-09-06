/**
 * 責務: ゲーム自動保存を非同期・原子的・順序保証付きで永続化する。
 * 変更ルール: ゲーム状態の意味解釈やmigration自体は行わない。読込時に旧製品schemaを検知した場合だけRenderer migration前のpre-schemaバックアップを残す。巨大状態のJSON.stringifyはRenderer側autosaveState.jsを正本とし、Main保存境界では直列化済みJSONオブジェクト文字列と最大サイズだけを検証する。書き込み中に新しい状態を受け取った場合は最新状態を優先し、途中状態を無制限に蓄積しない。各saveは自分の要求世代以上が実書込された後だけ完了し、pendingがない状態では新しいdrainを開始しない。書き込み失敗時は未保存の最新状態を保持して次回saveまたはflushから再処理できる状態に戻す。tmp本体をfsyncしてrenameし、対応環境では親ディレクトリもfsyncして電源断耐性を確保する。
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

function assertAutosaveSerialized(value) {
  if (typeof value !== 'string') {
    throw new TypeError('自動保存データは直列化済みJSON文字列で指定してください。');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_AUTOSAVE_BYTES) {
    throw new RangeError('自動保存データが上限サイズを超えています。');
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new TypeError('自動保存データはJSONオブジェクト文字列で指定してください。');
  }
  return value;
}

class AutosaveStore {
  #pendingSerialized = null;
  #drainPromise = null;
  #nextGeneration = 0;
  #writtenGeneration = 0;

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

  save(serializedState) {
    const generation = ++this.#nextGeneration;
    this.#pendingSerialized = { value: assertAutosaveSerialized(serializedState), generation };
    return this.#waitForGeneration(generation);
  }

  async flush() {
    while (this.#pendingSerialized !== null || this.#drainPromise) {
      const drainPromise = this.#drainPromise ?? this.#ensureDrain();
      await drainPromise;
    }
  }

  async #waitForGeneration(generation) {
    while (this.#writtenGeneration < generation) {
      const drain = this.#ensureDrain();
      if (!drain) throw new Error('自動保存キュー状態が不整合です。');
      await drain;
    }
  }

  #ensureDrain() {
    if (this.#drainPromise) return this.#drainPromise;
    if (this.#pendingSerialized === null) return null;
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
      const latest = this.#pendingSerialized;
      this.#pendingSerialized = null;
      try {
        await atomicWriteSerializedJson(this.autosavePath, latest.value);
        this.#writtenGeneration = Math.max(this.#writtenGeneration, latest.generation);
        await this.clearShutdownFlushFailure().catch(() => {});
      } catch (error) {
        if (this.#pendingSerialized === null || this.#pendingSerialized.generation < latest.generation) {
          this.#pendingSerialized = latest;
        }
        throw error;
      }
    }
  }
}

module.exports = { AutosaveStore };
