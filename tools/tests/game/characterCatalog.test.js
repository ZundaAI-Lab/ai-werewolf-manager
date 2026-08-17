/**
 * 責務: Mainのgroup.json正本ローダーから注入されたRendererカタログについて、ID/名前検索・権利メタデータ・読み取り専用Map境界を検証する。
 * 変更ルール: Renderer専用のテストローダーやトップレベル索引JSONを再導入しない。個別キャラクター内容や表示順を固定せず、Main→Rendererのデータ契約・権利メタデータ・検索境界だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_CARD_BY_ID,
  CHARACTER_CARD_BY_NAME,
  getCharacterCard,
} from '../../../app/renderer/js/characters/cards/characterCards.js';
import {
  getBuiltinCharacterGroups,
  validateCharacterCatalog,
} from '../../../app/renderer/js/characters/catalog/characterCatalog.js';

const OBJECT_PROTOTYPE_NAMES = Object.freeze([
  'toString',
  'hasOwnProperty',
  'constructor',
  '__proto__',
]);

test('キャラクター辞書はprototype名を未登録カードとして扱う', () => {
  assert.equal(CHARACTER_CARD_BY_ID instanceof Map, true);
  assert.equal(CHARACTER_CARD_BY_NAME instanceof Map, true);
  OBJECT_PROTOTYPE_NAMES.forEach((name) => {
    assert.equal(CHARACTER_CARD_BY_ID.has(name), false);
    assert.equal(getCharacterCard(name), null);
  });
});

test('公開キャラクター辞書は外部から変更できない', () => {
  assert.throws(
    () => CHARACTER_CARD_BY_ID.set('external-mutation', Object.freeze({ id: 'external-mutation' })),
    /読み取り専用キャラクターカタログ/u,
  );
  assert.equal(CHARACTER_CARD_BY_ID.has('external-mutation'), false);
  CHARACTER_CARD_BY_ID.forEach((_card, _id, readonlyMap) => {
    assert.throws(
      () => readonlyMap.set('for-each-mutation', Object.freeze({ id: 'for-each-mutation' })),
      /読み取り専用キャラクターカタログ/u,
    );
  });
  assert.equal(CHARACTER_CARD_BY_ID.has('for-each-mutation'), false);
});

test('組み込みキャラクターのgroup.json権利メタデータをMain経由でRendererカタログへ保持する', () => {
  const groups = getBuiltinCharacterGroups();
  assert.ok(groups.length > 0);
  groups.forEach((group) => {
    assert.match(group.source?.officialUrl ?? '', /^https:\/\//u, `${group.name}の公式サイトURL`);
    assert.match(group.source?.termsUrl ?? '', /^https:\/\//u, `${group.name}の利用規約URL`);
    assert.match(group.source?.classificationVerifiedAt ?? '', /^\d{4}-\d{2}-\d{2}$/u, `${group.name}の確認日`);
  });
});

test('ユーザーキャラクターグループへ外部権利URLを混入させない', () => {
  const catalog = validateCharacterCatalog({
    schemaVersion: 1,
    groups: [{
      schemaVersion: 1,
      id: 'user-group-license-test',
      name: 'ユーザーグループ',
      origin: 'user',
      source: { officialUrl: 'https://example.com/', termsUrl: 'https://example.com/terms' },
      credits: { holder: 'external' },
      characters: [],
    }],
  });
  assert.deepEqual(catalog.groups[0].source, {});
  assert.deepEqual(catalog.groups[0].credits, {});
});
