/**
 * 責務: Renderer上のキャラクターライブラリ編集要求、キャラ単位の使用状態、グループ順・キャラクター順をMainへ渡し、成功時だけカタログスナップショットを更新する。
 * 変更ルール: 組み込みJSONを編集対象へ変換しない。ユーザーライブラリ総サイズは共有userCharacterLibraryPolicyを正本とし、Main保存境界でも再検証する。具体的なグループ名・キャラクター名を持たず、ユーザーグループだけをJSON入出力対象とする。ユーザーキャラクター作成時は名前以外を任意とし、内部で必要な標準設定は共通既定値から生成する。文字数検証はキャラクター保存・JSON取込で指定した対象だけMainに要求し、削除・並び替え・使用切替・複製・グループ編集では既存キャラクターを再検証しない。組み込み側の変更は使用状態と並び順のメタデータに限定する。
 */

import { DEFAULT_CHARACTER } from '../../config/constants.js';
import { USER_CHARACTER_LIBRARY_MAX_BYTES } from '../config/userCharacterLibraryPolicyAdapter.js';
import {
  getBuiltinCharacterGroups,
  getCharacterGroups,
  getUserCharacterGroups,
  replaceCharacterCatalog,
  validateCharacterCatalog,
} from './characterCatalog.js';

export const USER_CHARACTER_LIBRARY_FORMAT = 'ai-werewolf-character-library';
export const USER_CHARACTER_LIBRARY_SCHEMA_VERSION = 1;
export { USER_CHARACTER_LIBRARY_MAX_BYTES };

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function toRawCharacter(card) {
  return {
    schemaVersion: 1,
    id: card.id,
    name: card.name,
    aliases: clone(card.aliases ?? []),
    enabled: card.enabled !== false,
    character: clone(card.character ?? {}),
    callNames: clone(card.callNames ?? {}),
  };
}

function toRawUserGroup(group, index = 0) {
  return {
    schemaVersion: 1,
    id: group.id,
    name: group.name,
    sortOrder: Number.isFinite(Number(group.sortOrder)) ? Number(group.sortOrder) : index,
    enabled: group.enabled !== false,
    characters: (group.characters ?? []).map(toRawCharacter),
  };
}

function toValidationGroup(group) {
  return {
    schemaVersion: 1,
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
    credits: clone(group.credits ?? {}),
    origin: group.origin,
    enabled: group.enabled !== false,
    characters: (group.characters ?? []).map(toRawCharacter),
  };
}

function assertDesktopApi(name) {
  const api = globalThis.window?.desktopWerewolf?.[name];
  if (typeof api !== 'function') throw new Error('この操作はデスクトップ版でのみ利用できます。');
  return api;
}

function validateUserGroups(groups) {
  const candidate = {
    schemaVersion: 1,
    groups: [
      ...getBuiltinCharacterGroups().map(toValidationGroup),
      ...groups.map((group, index) => ({ ...toRawUserGroup(group, index), origin: 'user', credits: {} })),
    ],
  };
  validateCharacterCatalog(candidate);
}

export function currentUserCharacterLibrary() {
  return {
    format: USER_CHARACTER_LIBRARY_FORMAT,
    schemaVersion: USER_CHARACTER_LIBRARY_SCHEMA_VERSION,
    groups: getUserCharacterGroups().map(toRawUserGroup),
  };
}

export async function saveUserCharacterGroups(groups, { validateCharacterIds = [] } = {}) {
  const rawGroups = groups.map(toRawUserGroup);
  validateUserGroups(rawGroups);
  const save = assertDesktopApi('saveUserCharacterLibrary');
  const catalog = await save({
    format: USER_CHARACTER_LIBRARY_FORMAT,
    schemaVersion: USER_CHARACTER_LIBRARY_SCHEMA_VERSION,
    groups: rawGroups,
  }, {
    validateCharacterIds: [...new Set((Array.isArray(validateCharacterIds) ? validateCharacterIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean))],
  });
  replaceCharacterCatalog(catalog);
  return getCharacterGroups();
}

export async function setCharacterGroupEnabled(groupId, enabled) {
  const id = String(groupId ?? '');
  const group = getCharacterGroups().find((item) => item.id === id);
  if (!group) throw new Error('対象グループが見つかりません。');
  if (group.origin === 'builtin') {
    const setBuiltinEnabled = assertDesktopApi('setBuiltinCharacterGroupEnabled');
    replaceCharacterCatalog(await setBuiltinEnabled(id, enabled === true));
    return;
  }
  const groups = getUserCharacterGroups().map(toRawUserGroup);
  const target = groups.find((item) => item.id === id);
  if (!target) throw new Error('対象ユーザーグループが見つかりません。');
  target.enabled = enabled === true;
  target.characters.forEach((card) => { card.enabled = enabled === true; });
  await saveUserCharacterGroups(groups);
}

export function parseImportedUserCharacterLibrary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('JSONルートがオブジェクトではありません。');
  if (raw.format !== USER_CHARACTER_LIBRARY_FORMAT) throw new Error(`formatは「${USER_CHARACTER_LIBRARY_FORMAT}」である必要があります。`);
  if (raw.schemaVersion !== USER_CHARACTER_LIBRARY_SCHEMA_VERSION || !Array.isArray(raw.groups)) {
    throw new Error('ユーザーキャラクターJSONの形式が不正です。');
  }
  const imported = raw.groups.map(toRawUserGroup);
  validateUserGroups([...getUserCharacterGroups().map(toRawUserGroup), ...imported]);
  return imported;
}

export async function importUserCharacterLibrary(raw) {
  const imported = parseImportedUserCharacterLibrary(raw);
  const merged = [...getUserCharacterGroups().map(toRawUserGroup), ...imported];
  await saveUserCharacterGroups(merged, {
    validateCharacterIds: imported.flatMap((group) => (group.characters ?? []).map((character) => character.id)),
  });
  return imported.length;
}

export function createUserGroupDraft(name = '') {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: String(name ?? '').trim(),
    sortOrder: getUserCharacterGroups().length,
    enabled: true,
    characters: [],
  };
}

export function createUserConversationSeedDraft() {
  return {
    id: crypto.randomUUID(),
    subject: '',
    tone: '',
  };
}

export function createUserCharacterDraft() {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: '',
    aliases: [],
    character: {
      ...clone(DEFAULT_CHARACTER),
      reasoningProfile: clone(DEFAULT_CHARACTER.reasoningProfile ?? {}),
      conversationSeeds: [],
    },
    enabled: true,
    callNames: {},
  };
}

export async function setCharacterEnabled(groupId, characterId, enabled) {
  const group = getCharacterGroups().find((item) => item.id === String(groupId ?? ''));
  const card = group?.characters.find((item) => item.id === String(characterId ?? ''));
  if (!group || !card) throw new Error('対象キャラクターが見つかりません。');
  if (group.origin === 'builtin') {
    const setBuiltinEnabled = assertDesktopApi('setBuiltinCharacterEnabled');
    replaceCharacterCatalog(await setBuiltinEnabled(card.id, enabled === true));
    return;
  }
  const groups = getUserCharacterGroups().map(toRawUserGroup);
  const targetGroup = groups.find((item) => item.id === group.id);
  const targetCard = targetGroup?.characters.find((item) => item.id === card.id);
  if (!targetCard) throw new Error('対象ユーザーキャラクターが見つかりません。');
  targetCard.enabled = enabled === true;
  await saveUserCharacterGroups(groups);
}

export async function setCharacterGroupOrder(groupIds) {
  const setOrder = assertDesktopApi('setCharacterGroupOrder');
  replaceCharacterCatalog(await setOrder(groupIds));
}

export async function setCharacterOrder(groupId, characterIds) {
  const setOrder = assertDesktopApi('setCharacterOrder');
  replaceCharacterCatalog(await setOrder(groupId, characterIds));
}

export function createUserCharacterFromCard(card) {
  const copy = toRawCharacter(card);
  copy.id = crypto.randomUUID();
  copy.enabled = true;
  return copy;
}

export function cloneUserGroupsForEdit() {
  return getUserCharacterGroups().map(toRawUserGroup);
}
