/**
 * 責務: ユーザー作成キャラクターグループ、キャラクター単位の使用状態、組み込み側の使用状態・グループ順・キャラクター順をuserData配下へ原子的に保存する。明示的に指定されたキャラクター保存・JSON取込だけ共有文字数規則を検証する。
 * 変更ルール: 組み込みキャラクターJSONを書き換えない。製品schema互換層で旧ライブラリschemaを現行へ一方向migrationし、未来schemaは拒否する。具体的なグループ名・キャラクター名・ゲーム規則・文字数定数を持たず、ID規則はapp/shared/entityIdPolicy.js、文字数規則はapp/shared/characterTextPolicy.jsを正本とする。起動読込・削除・並び替え・使用切替・複製・グループ編集では既存キャラクターの文字数超過を理由に処理を止めない。キャラクター保存とJSON取込では対象キャラクターだけ現行上限を検証する。ユーザーキャラクターのcharacter省略は空設定として保存し、実行用既定値の補完はRenderer側カタログ正規化へ委譲する。
 */

'use strict';

const { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { requireCharacterTextPayload } = require('../shared/characterTextPolicy.js');
const { requireEntityId } = require('../shared/entityIdPolicy.js');
const { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = require('../shared/dataCompatibility/schemaVersions.js');
const { migratePersistedDocument, writeMigratedJsonSync } = require('./dataCompatibilityPersistence.js');

const USER_CHARACTER_LIBRARY_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.USER_CHARACTER_LIBRARY);
const USER_CHARACTER_LIBRARY_FILENAME = 'character-library.json';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanName(value, label) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error(`${label}の名前が空です。`);
  if (name.length > 120) throw new Error(`${label}の名前が長すぎます。`);
  return name;
}

function normalizeCallNames(raw) {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error('callNamesが不正です。');
  return Object.fromEntries(Object.entries(raw).flatMap(([targetId, entry]) => {
    if (!isObject(entry)) return [];
    const preferred = String(entry.preferred ?? '').trim();
    if (!preferred) return [];
    return [[requireEntityId(targetId, '呼称先キャラクターID'), { preferred }]];
  }));
}

function normalizeIdList(values, label) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .map((value) => requireEntityId(value, label)))];
}

function normalizeUserCharacter(raw, label, { enforceTextLimits = true } = {}) {
  if (!isObject(raw) || raw.schemaVersion !== 1) throw new Error(`${label}の形式が不正です。`);
  if (raw.character !== undefined && !isObject(raw.character)) throw new Error(`${label}のcharacterが不正です。`);
  const normalized = {
    schemaVersion: 1,
    id: requireEntityId(raw.id, `${label}のID`),
    name: String(raw.name ?? '').trim(),
    aliases: Array.isArray(raw.aliases)
      ? [...new Set(raw.aliases.map((value) => String(value ?? '').trim()).filter(Boolean))]
      : [],
    enabled: raw.enabled !== false,
    character: clone(raw.character ?? {}),
    callNames: normalizeCallNames(raw.callNames),
  };
  if (enforceTextLimits) requireCharacterTextPayload(normalized, { label, requireName: true });
  return normalized;
}

function normalizeUserGroup(raw, index, { enforceTextLimits = true } = {}) {
  const label = `ユーザーグループ${index + 1}`;
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.characters)) {
    throw new Error(`${label}の形式が不正です。`);
  }
  return {
    schemaVersion: 1,
    id: requireEntityId(raw.id, `${label}のID`),
    name: cleanName(raw.name, label),
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : index,
    enabled: raw.enabled !== false,
    characters: raw.characters.map((character, characterIndex) => normalizeUserCharacter(character, `${label}のキャラクター${characterIndex + 1}`, { enforceTextLimits })),
  };
}

function normalizeCurrentStoredData(source, { enforceTextLimits = true } = {}) {
  const groups = Array.isArray(source.groups)
    ? source.groups.map((group, index) => normalizeUserGroup(group, index, { enforceTextLimits }))
    : [];
  const disabledBuiltinGroupIds = normalizeIdList(source.disabledBuiltinGroupIds, '使用停止中の組み込みグループID');
  const disabledBuiltinCharacterIds = normalizeIdList(source.disabledBuiltinCharacterIds, '使用停止中の組み込みキャラクターID');
  const groupOrderIds = normalizeIdList(source.groupOrderIds, 'キャラクターグループ順ID');
  const builtinCharacterOrderIdsByGroup = Object.fromEntries(Object.entries(isObject(source.builtinCharacterOrderIdsByGroup) ? source.builtinCharacterOrderIdsByGroup : {})
    .map(([groupId, characterIds]) => [
      requireEntityId(groupId, '組み込みキャラクター順のグループID'),
      normalizeIdList(characterIds, '組み込みキャラクター順ID'),
    ]));

  const groupIds = new Set();
  const characterIds = new Set();
  groups.forEach((group) => {
    if (groupIds.has(group.id)) throw new Error(`ユーザーグループIDが重複しています: ${group.id}`);
    groupIds.add(group.id);
    group.characters.forEach((character) => {
      if (characterIds.has(character.id)) throw new Error(`ユーザーキャラクターIDが重複しています: ${character.id}`);
      characterIds.add(character.id);
    });
  });

  return {
    schemaVersion: USER_CHARACTER_LIBRARY_SCHEMA_VERSION,
    groups,
    disabledBuiltinGroupIds,
    disabledBuiltinCharacterIds,
    groupOrderIds,
    builtinCharacterOrderIdsByGroup,
  };
}

function normalizeStoredData(raw, { enforceTextLimits = true } = {}) {
  const migration = migratePersistedDocument(raw, { kind: DATA_SCHEMA_KIND.USER_CHARACTER_LIBRARY, label: 'ユーザーキャラクターデータ' });
  return normalizeCurrentStoredData(migration.value, { enforceTextLimits });
}

class UserCharacterDataStore {
  constructor(userDataPath) {
    this.directory = userDataPath;
    this.path = join(userDataPath, USER_CHARACTER_LIBRARY_FILENAME);
    this.data = this._loadSync();
  }

  _loadSync() {
    try {
      const migration = migratePersistedDocument(JSON.parse(readFileSync(this.path, 'utf8')), { kind: DATA_SCHEMA_KIND.USER_CHARACTER_LIBRARY, label: 'ユーザーキャラクターデータ', path: this.path });
      const normalized = normalizeCurrentStoredData(migration.value, { enforceTextLimits: false });
      if (migration.migrated) writeMigratedJsonSync(this.path, normalized);
      return normalized;
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeStoredData({ schemaVersion: USER_CHARACTER_LIBRARY_SCHEMA_VERSION });
      throw new Error(`ユーザーキャラクターデータを読み込めません: ${error.message}`);
    }
  }

  snapshot() {
    return clone(this.data);
  }

  replace(next, { validateCharacterIds = [] } = {}) {
    const normalized = normalizeStoredData(next, { enforceTextLimits: false });
    const requestedIds = new Set(normalizeIdList(validateCharacterIds, '文字数検証対象のユーザーキャラクターID'));
    if (requestedIds.size) {
      const foundIds = new Set();
      normalized.groups.forEach((group, groupIndex) => {
        group.characters.forEach((character, characterIndex) => {
          if (!requestedIds.has(character.id)) return;
          foundIds.add(character.id);
          requireCharacterTextPayload(character, {
            label: `ユーザーグループ${groupIndex + 1}のキャラクター${characterIndex + 1}`,
            requireName: true,
          });
        });
      });
      requestedIds.forEach((id) => {
        if (!foundIds.has(id)) throw new Error(`文字数検証対象のユーザーキャラクターが見つかりません: ${id}`);
      });
    }
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      renameSync(temporaryPath, this.path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    this.data = normalized;
    return this.snapshot();
  }
}

module.exports = Object.freeze({
  USER_CHARACTER_LIBRARY_SCHEMA_VERSION,
  UserCharacterDataStore,
  normalizeStoredData,
});
