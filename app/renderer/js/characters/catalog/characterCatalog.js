/**
 * 責務: 組み込み/ユーザーJSONキャラクターデータを正規化した可変スナップショットへ変換し、グループ・カード・呼称の検索APIを提供する。
 * 変更ルール:
 * - グループ名・キャラクター名・権利情報をソースコードへ直書きしない。組み込み正本はapp/renderer/data/characters配下、ユーザー正本はMainのユーザーキャラクターストアとする。組み込みグループのsource/creditsは表示用メタデータとして保持し、ユーザーグループへ権利URLを混入させない。
 * - groupId / characterIdはapp/shared/entityIdPolicy.jsの共通ID規約に従い、characterIdは全グループで一意とし、グループ移動で変更しない。
 * - 呼称はspeakerCharacterId→targetCharacterIdの有向関係として扱い、グループ境界で参照を制限しない。
 * - 所属はgroup.jsonを正本とし、キャラクターJSONへgroupIdを重複保持しない。ユーザーキャラクターは名前以外を未設定にでき、未指定の実行必須項目は共通既定値で正規化する。
 * - JSONの型不備は読込時に拒否し、組み込みデータの共有characterTextPolicy違反も拒否する。ユーザーデータの文字数検証はMainの保存・取込境界を正本とし、既存userDataの文字数超過だけでRenderer起動を停止しない。省略可能項目の欠落はDEFAULT_CHARACTER等の共通既定値で補完する。組み込み生データの読込責務はMainのloadCharacterCatalogSyncだけに置き、RendererへNode専用の別ローダーを持たせない。グループとキャラクターの使用状態を保持し、ゲーム向け取得APIでは両方が有効なカードだけを返す。管理画面保存後はカタログ全体を原子的に差し替える。
 */

import { DEFAULT_CHARACTER, DEFAULT_REASONING_PROFILE, REASONING_PROFILE_OPTION_LABELS } from '../../config/constants.js';
import { requireEntityId } from '../../domain/policies/entityIdPolicyAdapter.js';
import { isPublicSpeechLengthOption } from '../../domain/policies/publicSpeechLengthPolicy.js';
import { validateCharacterConversationSeeds } from '../cards/characterConversationSeeds.js';
import { requireCharacterTextPayload } from '../config/characterTextPolicyAdapter.js';

export const CHARACTER_CATALOG_SCHEMA_VERSION = 1;
export const CHARACTER_GROUP_SCHEMA_VERSION = 1;
export const CHARACTER_CARD_SCHEMA_VERSION = 1;
export const CALL_NAME_SNAPSHOT_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanStringArray(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function createReadonlyMap(entries) {
  const map = new Map(entries);
  const rejectMutation = () => {
    throw new TypeError('読み取り専用キャラクターカタログは変更できません。');
  };
  return new Proxy(map, {
    get(target, property, receiver) {
      if (property === 'set' || property === 'delete' || property === 'clear') return rejectMutation;
      if (property === 'forEach') {
        return (callback, thisArg) => target.forEach((value, key) => callback.call(thisArg, value, key, receiver));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set: rejectMutation,
    deleteProperty: rejectMutation,
  });
}

function loadRawCatalog() {
  const desktopLoad = globalThis.desktopWerewolf?.loadCharacterCatalogSync;
  if (typeof desktopLoad !== 'function') throw new Error('キャラクターデータを読み込むMainブリッジがありません。');
  return desktopLoad();
}

function normalizeCard(raw, group) {
  if (!isObject(raw) || raw.schemaVersion !== CHARACTER_CARD_SCHEMA_VERSION) {
    throw new Error(`${group.name}のキャラクターJSON形式が不正です。`);
  }
  const id = requireEntityId(raw.id, `${group.name}のキャラクターID`);
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error(`${group.name}のキャラクター名が不正です。`);
  const rawCharacter = raw.character === undefined ? {} : raw.character;
  if (!isObject(rawCharacter)) throw new Error(`${name}のキャラクター設定が不正です。`);
  if (group.origin === 'builtin') requireCharacterTextPayload(raw, { label: name, requireName: true });
  const textKeys = [
    'profile',
    'firstPerson',
    'genericSecondPerson',
    'speakingStyle',
    'defaultEndings',
    'avoidedExpressions',
    'speechExamples',
    'discussionBehavior',
  ];
  textKeys.forEach((key) => {
    if (rawCharacter[key] !== undefined && typeof rawCharacter[key] !== 'string') {
      throw new Error(`${name}の${key}が文字列ではありません。`);
    }
  });
  if (rawCharacter.speechLength !== undefined && !isPublicSpeechLengthOption(rawCharacter.speechLength)) {
    throw new Error(`${name}の発言量区分が不正です。`);
  }
  if (rawCharacter.reasoningProfile !== undefined && !isObject(rawCharacter.reasoningProfile)) {
    throw new Error(`${name}の推理傾向が不正です。`);
  }
  Object.entries(REASONING_PROFILE_OPTION_LABELS).forEach(([key, options]) => {
    const value = rawCharacter.reasoningProfile?.[key];
    if (value !== undefined && !Object.hasOwn(options, value)) throw new Error(`${name}の推理傾向${key}が不正です。`);
  });
  if (rawCharacter.conversationSeeds !== undefined && !Array.isArray(rawCharacter.conversationSeeds)) {
    throw new Error(`${name}の会話のきっかけが配列ではありません。`);
  }

  const character = {
    ...clone(DEFAULT_CHARACTER),
    ...clone(rawCharacter),
    reasoningProfile: {
      ...clone(DEFAULT_REASONING_PROFILE),
      ...clone(rawCharacter.reasoningProfile ?? {}),
    },
    conversationSeeds: clone(rawCharacter.conversationSeeds ?? []),
  };

  const card = {
    schemaVersion: CHARACTER_CARD_SCHEMA_VERSION,
    id,
    groupId: group.id,
    groupName: group.name,
    name,
    aliases: cleanStringArray(raw.aliases),
    enabled: raw.enabled !== false,
    character,
    callNames: isObject(raw.callNames) ? clone(raw.callNames) : {},
  };
  validateCharacterConversationSeeds(card);
  return card;
}

function normalizeCatalog(rawCatalog) {
  if (!isObject(rawCatalog)
    || rawCatalog.schemaVersion !== CHARACTER_CATALOG_SCHEMA_VERSION
    || !Array.isArray(rawCatalog.groups)) {
    throw new Error('キャラクターカタログの形式が不正です。');
  }

  const groupIds = new Set();
  const characterIds = new Set();
  const groups = rawCatalog.groups.map((rawGroup, groupIndex) => {
    if (!isObject(rawGroup) || rawGroup.schemaVersion !== CHARACTER_GROUP_SCHEMA_VERSION) {
      throw new Error(`キャラクターグループ${groupIndex + 1}の形式が不正です。`);
    }
    const id = requireEntityId(rawGroup.id, `キャラクターグループ${groupIndex + 1}のID`);
    const name = String(rawGroup.name ?? '').trim();
    if (!name || !Array.isArray(rawGroup.characters)) {
      throw new Error(`キャラクターグループ${groupIndex + 1}の名前またはcharactersが不正です。`);
    }
    if (groupIds.has(id)) throw new Error(`キャラクターグループIDが重複しています: ${id}`);
    groupIds.add(id);
    const origin = rawGroup.origin === 'user' ? 'user' : 'builtin';
    const group = {
      schemaVersion: CHARACTER_GROUP_SCHEMA_VERSION,
      id,
      name,
      sortOrder: Number.isFinite(Number(rawGroup.sortOrder)) ? Number(rawGroup.sortOrder) : groupIndex,
      credits: origin === 'builtin' && isObject(rawGroup.credits) ? clone(rawGroup.credits) : {},
      source: origin === 'builtin' && isObject(rawGroup.source) ? clone(rawGroup.source) : {},
      origin,
      enabled: rawGroup.enabled !== false,
      editable: origin === 'user',
      deletable: origin === 'user',
      characters: [],
    };
    group.characters = rawGroup.characters.map((rawCard) => {
      const card = normalizeCard(rawCard, group);
      if (characterIds.has(card.id)) throw new Error(`キャラクターIDが重複しています: ${card.id}`);
      characterIds.add(card.id);
      return card;
    });
    return group;
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ja'));

  const cards = groups.flatMap((group) => group.characters);
  const cardIdSet = new Set(cards.map((card) => card.id));
  cards.forEach((card) => {
    Object.entries(card.callNames).forEach(([targetId, entry]) => {
      if (!cardIdSet.has(targetId)) throw new Error(`${card.name}の呼称が存在しないキャラクターを参照しています: ${targetId}`);
      if (!isObject(entry)) throw new Error(`${card.name}から${targetId}への呼称が不正です。`);
      const preferred = String(entry.preferred ?? '').trim();
      if (!preferred) {
        delete card.callNames[targetId];
        return;
      }
      card.callNames[targetId] = { preferred };
    });
  });

  return deepFreeze({
    schemaVersion: CHARACTER_CATALOG_SCHEMA_VERSION,
    groups,
    cards,
    byId: createReadonlyMap(cards.map((card) => [card.id, card])),
    byName: createReadonlyMap(cards.map((card) => [card.name, card])),
  });
}

let CATALOG = normalizeCatalog(loadRawCatalog());

export let CHARACTER_GROUPS = CATALOG.groups;
export let CHARACTER_CARDS = CATALOG.cards;
export let CHARACTER_CARD_BY_ID = CATALOG.byId;
export let CHARACTER_CARD_BY_NAME = CATALOG.byName;

function publishCatalog(nextCatalog) {
  CATALOG = nextCatalog;
  CHARACTER_GROUPS = CATALOG.groups;
  CHARACTER_CARDS = CATALOG.cards;
  CHARACTER_CARD_BY_ID = CATALOG.byId;
  CHARACTER_CARD_BY_NAME = CATALOG.byName;
  return CATALOG;
}

export function validateCharacterCatalog(rawCatalog) {
  return normalizeCatalog(rawCatalog);
}

export function replaceCharacterCatalog(rawCatalog) {
  return publishCatalog(normalizeCatalog(rawCatalog));
}

export function getCharacterGroups() {
  return CHARACTER_GROUPS;
}

export function getBuiltinCharacterGroups() {
  return CHARACTER_GROUPS.filter((group) => group.origin === 'builtin');
}

export function getUserCharacterGroups() {
  return CHARACTER_GROUPS.filter((group) => group.origin === 'user');
}

export function getEnabledCharacterGroups() {
  return CHARACTER_GROUPS.filter((group) => group.enabled);
}

export function getEnabledCharacterCards() {
  return getEnabledCharacterGroups().flatMap((group) => group.characters.filter((card) => card.enabled !== false));
}

export function isCharacterCardEnabled(characterId) {
  const card = CHARACTER_CARD_BY_ID.get(String(characterId ?? ''));
  if (!card || card.enabled === false) return false;
  return CHARACTER_GROUPS.some((group) => group.id === card.groupId && group.enabled);
}
