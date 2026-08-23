/**
 * 責務: 組み込みキャラクターJSONの権利元メタデータ伝搬と、group.jsonから同一グループ外JSONを参照できない読込境界を検証する。
 * 変更ルール: 個別キャラクター文言や表示順は固定せず、group.jsonを正本とするメタデータ伝搬と参照範囲だけを検査する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const { readCharacterDataCatalog } = require('../../../app/main/characterDataStore.js');

const projectRoot = join(__dirname, '..', '..', '..');
const characterDataRoot = join(projectRoot, 'app', 'renderer', 'data', 'characters');

test('Mainは組み込みグループの公式サイト・利用規約・確認日を保持する', () => {
  const catalog = readCharacterDataCatalog(characterDataRoot);
  assert.ok(catalog.groups.length > 0);
  catalog.groups.forEach((group) => {
    assert.match(group.source?.officialUrl ?? '', /^https:\/\//u, `${group.name}の公式サイトURL`);
    assert.match(group.source?.termsUrl ?? '', /^https:\/\//u, `${group.name}の利用規約URL`);
    assert.match(group.source?.classificationVerifiedAt ?? '', /^\d{4}-\d{2}-\d{2}$/u, `${group.name}の確認日`);
  });
});


test('group.jsonは同一グループ外のキャラクターJSONを参照できない', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'werewolf-character-path-'));
  const groupA = join(root, 'group-a');
  const groupB = join(root, 'group-b');
  fs.mkdirSync(groupA, { recursive: true });
  fs.mkdirSync(groupB, { recursive: true });
  fs.writeFileSync(join(groupA, 'group.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'group-a',
    name: 'Group A',
    characters: ['../group-b/character.json'],
  }), 'utf8');
  fs.writeFileSync(join(groupB, 'character.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'character-b',
    name: 'Character B',
    character: {},
  }), 'utf8');

  assert.throws(
    () => readCharacterDataCatalog(root),
    /同一キャラクターグループ外/u,
  );
});
