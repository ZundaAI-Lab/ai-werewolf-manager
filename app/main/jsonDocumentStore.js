/**
 * 責務: Main側の小規模JSONドキュメントを現行schema境界で検証し、migration・原子的保存・最新要求優先の直列化・flushを共通提供する。
 * 変更ルール:
 * - 保存対象固有の会話順・観戦方式・ゲーム状態などの意味解釈を行わず、filename・schemaKind・最大バイト数・表示ラベルを呼出側から受け取る。
 * - 読込時は対応Migrationがある旧schemaだけを製品schema管理層で一方向migrationし、Migrationのない旧schemaまたは読込・schema検証に失敗した既存ファイルは退避してから空状態へ戻す。退避に失敗した場合は元ファイル保護のため保存を禁止する。保存時は現行schemaVersionと最大サイズだけを検証する。
 * - 連続保存は最新要求だけを保持して直列化し、失敗した最新データは次回saveまたはflushで再試行できる状態へ戻す。
 */

'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { atomicWriteJson } = require('./atomicJsonFile.js');
const { getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { migratePersistedDocument, quarantineUnreadableJsonSync, writeMigratedJsonSync } = require('./dataCompatibilityPersistence.js');

function normalizeDocument(value, { schemaVersion, maxBytes, label }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}はオブジェクトで指定してください。`);
  }
  if (Number(value.schemaVersion) !== schemaVersion) {
    throw new RangeError(`${label}のschemaVersionが現行形式ではありません。`);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError(`${label}が上限サイズを超えています。`);
  }
  return JSON.parse(serialized);
}

class JsonDocumentStore {
  #pendingDocument = null;
  #drainPromise = null;
  #schemaKind;
  #schemaVersion;
  #maxBytes;
  #label;
  #writable = true;

  constructor(userDataPath, { filename, schemaKind, maxBytes, label }) {
    if (!filename || !schemaKind || !label) throw new TypeError('JSON保存設定が不足しています。');
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new RangeError('JSON保存上限サイズが不正です。');
    this.path = join(userDataPath, filename);
    this.#schemaKind = schemaKind;
    this.#schemaVersion = getCurrentDataSchemaVersion(schemaKind);
    this.#maxBytes = maxBytes;
    this.#label = label;
  }

  loadSync() {
    if (!existsSync(this.path)) return null;
    try {
      const migration = migratePersistedDocument(JSON.parse(readFileSync(this.path, 'utf8')), {
        kind: this.#schemaKind,
        label: this.#label,
        path: this.path,
      });
      const normalized = this.#normalize(migration.value);
      if (migration.migrated) writeMigratedJsonSync(this.path, normalized);
      return normalized;
    } catch (error) {
      try {
        const backupPath = quarantineUnreadableJsonSync(this.path);
        console.warn(`${this.#label}を読み込めないため${backupPath ? `「${backupPath}」へ退避しました。` : '空状態を使用します。'}`, error);
      } catch (quarantineError) {
        this.#writable = false;
        console.error(`${this.#label}を読み込めず、元ファイルの退避にも失敗したため保存を禁止します。`, quarantineError, error);
      }
      return null;
    }
  }

  save(value) {
    if (!this.#writable) {
      const error = new Error(`${this.#label}の元ファイルを保護しているため保存できません。`);
      error.code = 'JSON_DOCUMENT_READ_ONLY';
      return Promise.reject(error);
    }
    this.#pendingDocument = this.#normalize(value);
    return this.#ensureDrain().then(() => ({ ok: true }));
  }

  async flush() {
    while (this.#pendingDocument !== null || this.#drainPromise) {
      const drain = this.#ensureDrain();
      if (!drain) break;
      await drain;
    }
    return { ok: true };
  }

  #normalize(value) {
    return normalizeDocument(value, {
      schemaVersion: this.#schemaVersion,
      maxBytes: this.#maxBytes,
      label: this.#label,
    });
  }

  #ensureDrain() {
    if (this.#drainPromise) return this.#drainPromise;
    if (this.#pendingDocument === null) return null;
    const drain = this.#drain();
    this.#drainPromise = drain;
    const clear = () => {
      if (this.#drainPromise === drain) this.#drainPromise = null;
    };
    drain.then(clear, clear);
    return drain;
  }

  async #drain() {
    while (this.#pendingDocument !== null) {
      const latest = this.#pendingDocument;
      this.#pendingDocument = null;
      try {
        await atomicWriteJson(this.path, latest);
      } catch (error) {
        if (this.#pendingDocument === null) this.#pendingDocument = latest;
        throw error;
      }
    }
  }
}

module.exports = { JsonDocumentStore };
