/**
 * 責務: 外部LLMへゲーム・チャット等のデータを送信し得ることを利用者が確認したかを、AI設定とは独立したuserDataへ永続化する。
 * 変更ルール: AI設定・APIキー・ゲーム状態・送信データを保存しない。保存JSONのschemaVersionはdataCompatibilityを正本とし、説明の意味変更時はshared/dataTransmissionPolicy.jsのEXTERNAL_DATA_NOTICE_VERSIONを正本として再確認を要求する。
 */

'use strict';

const { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { EXTERNAL_DATA_NOTICE_VERSION } = require('../shared/dataTransmissionPolicy.js');
const { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { migratePersistedDocument, writeMigratedJsonSync } = require('./dataCompatibilityPersistence.js');

const PRIVACY_NOTICE_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.PRIVACY_NOTICE);

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'w', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function loadAcceptedVersion(path) {
  try {
    const migration = migratePersistedDocument(JSON.parse(readFileSync(path, 'utf8')), { kind: DATA_SCHEMA_KIND.PRIVACY_NOTICE, label: 'プライバシー確認データ', path });
    const parsed = migration.value;
    if (parsed.schemaVersion !== PRIVACY_NOTICE_SCHEMA_VERSION || !Number.isInteger(parsed.externalDataNoticeVersion)) return 0;
    if (migration.migrated) writeMigratedJsonSync(path, parsed);
    return parsed.externalDataNoticeVersion;
  } catch {
    return 0;
  }
}

class PrivacyNoticeStore {
  constructor(userDataPath) {
    this.path = join(userDataPath, 'privacy-notice.json');
    this.acceptedVersion = loadAcceptedVersion(this.path);
  }

  status() {
    return Object.freeze({
      externalDataNoticeVersion: EXTERNAL_DATA_NOTICE_VERSION,
      accepted: this.acceptedVersion === EXTERNAL_DATA_NOTICE_VERSION,
    });
  }

  accept(version) {
    if (Number(version) !== EXTERNAL_DATA_NOTICE_VERSION) {
      throw new RangeError(`外部LLMデータ送信確認の版が現行ではありません: ${version}`);
    }
    atomicWriteJson(this.path, { schemaVersion: PRIVACY_NOTICE_SCHEMA_VERSION, externalDataNoticeVersion: EXTERNAL_DATA_NOTICE_VERSION });
    this.acceptedVersion = EXTERNAL_DATA_NOTICE_VERSION;
    return this.status();
  }
}

module.exports = { PRIVACY_NOTICE_SCHEMA_VERSION, PrivacyNoticeStore };
