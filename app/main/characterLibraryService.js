/**
 * 責務: 読み取り専用の組み込みキャラクターと編集可能なユーザーキャラクターを統合し、使用状態・グループ順・キャラクター順・編集可否を付与したRenderer向けカタログを提供する。
 * 変更ルール: 具体的なグループ名・キャラクター名を持たない。Rendererから受け取るユーザーライブラリ全体は共有サイズ上限を超える前に拒否する。組み込みJSONの変更/削除を提供せず、使用状態と並び順だけをユーザー領域のメタデータとして保持する。文字数検証は明示的なキャラクター保存・JSON取込の対象IDだけUserCharacterDataStoreへ委譲し、管理操作では既存データを再検証しない。
 */

'use strict';

const { readCharacterDataCatalog } = require('./characterDataStore.js');
const { USER_CHARACTER_LIBRARY_SCHEMA_VERSION } = require('./userCharacterDataStore.js');
const { assertUserCharacterLibrarySerializedSize } = require('../shared/userCharacterLibraryPolicy.js');

const USER_LIBRARY_FORMAT = 'ai-werewolf-character-library';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function userGroupsFromPayload(payload) {
  if (!isObject(payload)) throw new Error('ユーザーキャラクターデータがありません。');
  if (payload.format !== undefined && payload.format !== USER_LIBRARY_FORMAT) {
    throw new Error('ユーザーキャラクターJSONのformatが不正です。');
  }
  if (payload.schemaVersion !== USER_CHARACTER_LIBRARY_SCHEMA_VERSION || !Array.isArray(payload.groups)) {
    throw new Error('ユーザーキャラクターJSONの形式が不正です。');
  }
  return clone(payload.groups);
}

function validateMergedCatalog(catalog) {
  const groupIds = new Set();
  const characterIds = new Set();
  for (const [groupIndex, group] of catalog.groups.entries()) {
    if (!group?.id || !group?.name || !Array.isArray(group.characters)) {
      throw new Error(`キャラクターグループ${groupIndex + 1}の形式が不正です。`);
    }
    if (groupIds.has(group.id)) throw new Error(`キャラクターグループIDが重複しています: ${group.id}`);
    groupIds.add(group.id);
    for (const [characterIndex, character] of group.characters.entries()) {
      if (character?.schemaVersion !== 1 || !character?.id || !character?.name || !isObject(character.character)) {
        throw new Error(`${group.name}のキャラクター${characterIndex + 1}の形式が不正です。`);
      }
      if (!isObject(character.callNames ?? {})) throw new Error(`${character.name}のcallNamesが不正です。`);
      if (characterIds.has(character.id)) throw new Error(`キャラクターIDが重複しています: ${character.id}`);
      characterIds.add(character.id);
    }
  }
  for (const group of catalog.groups) {
    for (const character of group.characters) {
      Object.entries(character.callNames ?? {}).forEach(([targetId, entry]) => {
        if (!characterIds.has(targetId)) throw new Error(`${character.name}の呼称が存在しないキャラクターを参照しています: ${targetId}`);
        if (!isObject(entry)) throw new Error(`${character.name}から${targetId}への呼称が不正です。`);
      });
    }
  }
}

function normalizeOrderIds(groupOrderIds, groups) {
  const validIds = new Set(groups.map((group) => group.id));
  const ordered = [];
  for (const id of Array.isArray(groupOrderIds) ? groupOrderIds : []) {
    if (validIds.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const group of groups) {
    if (!ordered.includes(group.id)) ordered.push(group.id);
  }
  return ordered;
}

class CharacterLibraryService {
  constructor({ builtinDataRoot, userStore }) {
    if (!builtinDataRoot) throw new TypeError('組み込みキャラクターデータのパスがありません。');
    if (!userStore) throw new TypeError('ユーザーキャラクターストアがありません。');
    this.builtinDataRoot = builtinDataRoot;
    this.userStore = userStore;
  }

  _builtinCatalog() {
    return readCharacterDataCatalog(this.builtinDataRoot);
  }

  _merge(storedData) {
    const builtin = this._builtinCatalog();
    const disabledBuiltinGroupIds = new Set(storedData.disabledBuiltinGroupIds ?? []);
    const disabledBuiltinCharacterIds = new Set(storedData.disabledBuiltinCharacterIds ?? []);
    const builtinGroups = builtin.groups.map((group) => {
      const characters = group.characters.map((character) => ({
        ...clone(character),
        enabled: !disabledBuiltinCharacterIds.has(character.id),
      }));
      const characterOrderIds = normalizeOrderIds(storedData.builtinCharacterOrderIdsByGroup?.[group.id], characters);
      const characterOrderIndex = new Map(characterOrderIds.map((id, index) => [id, index]));
      characters.sort((left, right) => characterOrderIndex.get(left.id) - characterOrderIndex.get(right.id));
      return {
        ...clone(group),
        origin: 'builtin',
        enabled: !disabledBuiltinGroupIds.has(group.id),
        editable: false,
        deletable: false,
        characters,
      };
    });
    const userGroups = (storedData.groups ?? []).map((group) => ({
      ...clone(group),
      credits: {},
      origin: 'user',
      enabled: group.enabled !== false,
      editable: true,
      deletable: true,
      characters: (group.characters ?? []).map((character) => ({
        ...clone(character),
        enabled: character.enabled !== false,
      })),
    }));
    const mergedGroups = [...builtinGroups, ...userGroups];
    const orderIds = normalizeOrderIds(storedData.groupOrderIds, mergedGroups);
    const orderIndex = new Map(orderIds.map((id, index) => [id, index]));
    mergedGroups.sort((left, right) => orderIndex.get(left.id) - orderIndex.get(right.id));
    mergedGroups.forEach((group, index) => { group.sortOrder = index; });
    const catalog = {
      schemaVersion: builtin.schemaVersion,
      groups: mergedGroups,
    };
    validateMergedCatalog(catalog);
    return catalog;
  }

  loadCatalog() {
    return this._merge(this.userStore.snapshot());
  }

  replaceUserLibrary(payload, { validateCharacterIds = [] } = {}) {
    assertUserCharacterLibrarySerializedSize(JSON.stringify(payload, null, 2));
    const current = this.userStore.snapshot();
    const candidate = {
      schemaVersion: USER_CHARACTER_LIBRARY_SCHEMA_VERSION,
      groups: userGroupsFromPayload(payload),
      disabledBuiltinGroupIds: current.disabledBuiltinGroupIds,
      disabledBuiltinCharacterIds: current.disabledBuiltinCharacterIds,
      groupOrderIds: current.groupOrderIds,
      builtinCharacterOrderIdsByGroup: current.builtinCharacterOrderIdsByGroup,
    };
    this._merge(candidate);
    this.userStore.replace(candidate, { validateCharacterIds });
    return this.loadCatalog();
  }

  setBuiltinGroupEnabled(groupId, enabled) {
    const id = String(groupId ?? '').trim();
    const builtin = this._builtinCatalog();
    const group = builtin.groups.find((item) => item.id === id);
    if (!group) throw new Error('指定された組み込みグループが見つかりません。');
    const current = this.userStore.snapshot();
    const disabledGroups = new Set(current.disabledBuiltinGroupIds ?? []);
    const disabledCharacters = new Set(current.disabledBuiltinCharacterIds ?? []);
    if (enabled) disabledGroups.delete(id);
    else disabledGroups.add(id);
    for (const character of group.characters) {
      if (enabled) disabledCharacters.delete(character.id);
      else disabledCharacters.add(character.id);
    }
    const candidate = {
      ...current,
      disabledBuiltinGroupIds: [...disabledGroups],
      disabledBuiltinCharacterIds: [...disabledCharacters],
    };
    this._merge(candidate);
    this.userStore.replace(candidate);
    return this.loadCatalog();
  }

  setBuiltinCharacterEnabled(characterId, enabled) {
    const id = String(characterId ?? '').trim();
    const builtin = this._builtinCatalog();
    const exists = builtin.groups.some((group) => group.characters.some((character) => character.id === id));
    if (!exists) throw new Error('指定された組み込みキャラクターが見つかりません。');
    const current = this.userStore.snapshot();
    const disabled = new Set(current.disabledBuiltinCharacterIds ?? []);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    const candidate = { ...current, disabledBuiltinCharacterIds: [...disabled] };
    this._merge(candidate);
    this.userStore.replace(candidate);
    return this.loadCatalog();
  }


  setCharacterOrder(groupId, characterIds) {
    const id = String(groupId ?? '').trim();
    const currentCatalog = this.loadCatalog();
    const group = currentCatalog.groups.find((item) => item.id === id);
    if (!group) throw new Error('対象キャラクターグループが見つかりません。');
    const requested = Array.isArray(characterIds) ? characterIds.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const expected = group.characters.map((character) => character.id);
    if (requested.length !== expected.length || new Set(requested).size !== expected.length || expected.some((characterId) => !requested.includes(characterId))) {
      throw new Error('キャラクターの並び順が不正です。');
    }

    const current = this.userStore.snapshot();
    if (group.origin === 'builtin') {
      const orderByGroup = { ...(current.builtinCharacterOrderIdsByGroup ?? {}), [id]: requested };
      const candidate = { ...current, builtinCharacterOrderIdsByGroup: orderByGroup };
      this._merge(candidate);
      this.userStore.replace(candidate);
      return this.loadCatalog();
    }

    const groups = clone(current.groups ?? []);
    const target = groups.find((item) => item.id === id);
    if (!target) throw new Error('対象ユーザーグループが見つかりません。');
    const byId = new Map(target.characters.map((character) => [character.id, character]));
    target.characters = requested.map((characterId) => byId.get(characterId));
    const candidate = { ...current, groups };
    this._merge(candidate);
    this.userStore.replace(candidate);
    return this.loadCatalog();
  }

  setGroupOrder(groupIds) {
    const currentCatalog = this.loadCatalog();
    const requested = Array.isArray(groupIds) ? groupIds.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const expected = currentCatalog.groups.map((group) => group.id);
    if (requested.length !== expected.length || new Set(requested).size !== expected.length || expected.some((id) => !requested.includes(id))) {
      throw new Error('キャラクターグループの並び順が不正です。');
    }
    const current = this.userStore.snapshot();
    const candidate = { ...current, groupOrderIds: requested };
    this._merge(candidate);
    this.userStore.replace(candidate);
    return this.loadCatalog();
  }
}

module.exports = Object.freeze({
  USER_LIBRARY_FORMAT,
  CharacterLibraryService,
  validateMergedCatalog,
});
