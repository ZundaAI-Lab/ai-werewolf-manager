/**
 * 責務: アプリ同梱のキャラクターデータディレクトリ直下にある各グループのgroup.jsonとcharacter JSONを同期読込し、Rendererへ渡す正規化済みカタログを構築する。
 * 変更ルール: 読込対象はapp/renderer/data/characters直下のグループディレクトリと、そのgroup.jsonから参照される同一グループ内JSONだけに限定する。トップレベルcatalog.jsonを索引の正本にせず、所属と権利情報はgroup.jsonを正本とする。任意ファイル参照・ゲーム規則・DOM操作を追加せず、公式URL・利用規約URL・確認日はRendererへ渡す。キャラクターJSONへ重複した所属情報を要求しない。
 */

'use strict';

const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

const CATALOG_SCHEMA_VERSION = 1;
const GROUP_SCHEMA_VERSION = 1;
const CHARACTER_SCHEMA_VERSION = 1;

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label}を読み込めません: ${error.message}`);
  }
}

function resolveInside(baseDirectory, relativePath, label) {
  const value = String(relativePath ?? '').trim();
  if (!value) throw new Error(`${label}のパスが空です。`);
  const base = resolve(baseDirectory);
  const absolute = resolve(base, value);
  const baseRelative = relative(base, absolute);
  if (isAbsolute(baseRelative) || baseRelative === '..' || baseRelative.startsWith(`..${sep}`)) {
    throw new Error(`${label}が同一キャラクターグループ外を参照しています。`);
  }
  return absolute;
}

function cleanCredits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value : value ?? ''])
      .filter(([key]) => key),
  ));
}

function cleanSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    ['officialUrl', 'termsUrl', 'classificationVerifiedAt', 'sourceClass']
      .map((key) => [key, String(raw[key] ?? '').trim()])
      .filter(([, value]) => value),
  ));
}

function builtinGroupPaths(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, 'ja'))
    .map((entry) => join(root, entry.name, 'group.json'))
    .filter((groupPath) => existsSync(groupPath));
}

function readCharacterDataCatalog(dataRoot) {
  const root = resolve(dataRoot);
  const groupPaths = builtinGroupPaths(root);
  if (groupPaths.length === 0) throw new Error('組み込みキャラクターグループが見つかりません。');

  const groupIds = new Set();
  const characterIds = new Set();
  const groups = groupPaths.map((groupPath, groupIndex) => {
    const groupDirectory = dirname(groupPath);
    const group = parseJson(groupPath, `グループ${groupIndex + 1}`);
    if (group?.schemaVersion !== GROUP_SCHEMA_VERSION) throw new Error(`グループ${groupIndex + 1}のschemaVersionが不正です。`);
    const id = String(group?.id ?? '').trim();
    const name = String(group?.name ?? '').trim();
    if (!id || !name || !Array.isArray(group?.characters)) throw new Error(`グループ${groupIndex + 1}の形式が不正です。`);
    if (groupIds.has(id)) throw new Error(`グループIDが重複しています: ${id}`);
    groupIds.add(id);

    const characters = group.characters.map((characterRef, characterIndex) => {
      const characterPath = resolveInside(groupDirectory, characterRef, `${name}.characters[${characterIndex}]`);
      const character = parseJson(characterPath, `${name}のキャラクター${characterIndex + 1}`);
      if (character?.schemaVersion !== CHARACTER_SCHEMA_VERSION) throw new Error(`${name}のキャラクター${characterIndex + 1}のschemaVersionが不正です。`);
      const characterId = String(character?.id ?? '').trim();
      if (!characterId || String(character?.name ?? '').trim() === '') throw new Error(`${name}のキャラクター${characterIndex + 1}のIDまたは名前が空です。`);
      if (characterIds.has(characterId)) throw new Error(`キャラクターIDが重複しています: ${characterId}`);
      characterIds.add(characterId);
      return Object.freeze({
        ...character,
        aliases: Object.freeze([...(Array.isArray(character.aliases) ? character.aliases : [])]),
        character: Object.freeze({ ...(character.character ?? {}) }),
        callNames: Object.freeze({ ...(character.callNames ?? {}) }),
      });
    });

    return Object.freeze({
      schemaVersion: GROUP_SCHEMA_VERSION,
      id,
      name,
      sortOrder: Number.isFinite(Number(group.sortOrder)) ? Number(group.sortOrder) : groupIndex,
      credits: cleanCredits(group.credits),
      source: cleanSource(group.source),
      characters: Object.freeze(characters),
    });
  });

  return Object.freeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    groups: Object.freeze(groups),
  });
}

module.exports = Object.freeze({
  CATALOG_SCHEMA_VERSION,
  GROUP_SCHEMA_VERSION,
  CHARACTER_SCHEMA_VERSION,
  readCharacterDataCatalog,
});
