/**
 * 責務: ユーザーキャラクター保存境界が共有entityIdPolicyを使用し、グループID・キャラクターID・参照IDへ同一規約を適用することを検証する。
 * 変更ルール: 文字数規則やカタログ統合は検証せず、Main保存境界のID規約だけを扱う。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStoredData } = require('../../../app/main/userCharacterDataStore.js');

function libraryWithIds(groupId = 'user-group', characterId = 'user-character') {
  return {
    schemaVersion: 1,
    groups: [{
      schemaVersion: 1,
      id: groupId,
      name: 'ユーザーグループ',
      characters: [{
        schemaVersion: 1,
        id: characterId,
        name: 'ユーザーキャラクター',
        character: {},
      }],
    }],
  };
}

test('ユーザーキャラクターのグループIDとキャラクターIDへ共有ID規約を適用する', () => {
  const valid = normalizeStoredData(libraryWithIds(), { enforceTextLimits: false });
  assert.equal(valid.groups[0].id, 'user-group');
  assert.equal(valid.groups[0].characters[0].id, 'user-character');

  ['bad id with spaces', '__proto__', '<script>', 'a/b'].forEach((invalidId) => {
    assert.throws(
      () => normalizeStoredData(libraryWithIds(invalidId, 'user-character'), { enforceTextLimits: false }),
      /半角英数字/u,
      `groupId=${invalidId}を拒否する`,
    );
    assert.throws(
      () => normalizeStoredData(libraryWithIds('user-group', invalidId), { enforceTextLimits: false }),
      /半角英数字/u,
      `characterId=${invalidId}を拒否する`,
    );
  });
});

test('ユーザーキャラクター保存メタデータの参照IDにも共有ID規約を適用する', () => {
  const invalidMetadata = {
    ...libraryWithIds(),
    disabledBuiltinGroupIds: ['bad id with spaces'],
  };
  assert.throws(
    () => normalizeStoredData(invalidMetadata, { enforceTextLimits: false }),
    /半角英数字/u,
  );
});
