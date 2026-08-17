/**
 * 責務: 組み込みキャラクターJSONの権利元メタデータがMain読込境界で欠落せずRenderer向けカタログへ渡ることを検証する。
 * 変更ルール: 個別キャラクター文言や表示順は固定せず、group.jsonを正本とする公式サイト・利用規約・確認日の伝搬契約だけを検査する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
