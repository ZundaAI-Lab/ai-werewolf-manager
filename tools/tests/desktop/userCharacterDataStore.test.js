/**
 * 責務: ユーザーキャラクター保存境界のID規約、原子的保存権限、ライブラリ総サイズ上限を検証する。
 * 変更ルール: 文字数規則やカタログ表示内容は固定せず、Main保存境界の共有ポリシーと永続化契約だけを扱う。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CharacterLibraryService } = require('../../../app/main/characterLibraryService.js');
const { USER_CHARACTER_LIBRARY_MAX_BYTES } = require('../../../app/shared/userCharacterLibraryPolicy.js');
const { UserCharacterDataStore, normalizeStoredData } = require('../../../app/main/userCharacterDataStore.js');

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


test('ユーザーキャラクター保存はPOSIXで0600の原子的保存を使用する', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-user-character-store-'));
  const store = new UserCharacterDataStore(directory);
  store.replace(libraryWithIds());
  const storedPath = path.join(directory, 'character-library.json');
  assert.equal(fs.statSync(storedPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(storedPath, 'utf8')).groups[0].id, 'user-group');
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
});


test('組み込みキャラクターカタログはService初回読込後にディスクへ再アクセスしない', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-builtin-character-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builtinDataRoot = path.join(root, 'characters');
  const groupRoot = path.join(builtinDataRoot, 'builtin-test');
  fs.mkdirSync(groupRoot, { recursive: true });
  fs.writeFileSync(path.join(groupRoot, 'group.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'builtin-test',
    name: '組み込みテスト',
    characters: ['character.json'],
  }), 'utf8');
  fs.writeFileSync(path.join(groupRoot, 'character.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'builtin-character',
    name: '組み込みキャラクター',
    character: {},
    callNames: {},
  }), 'utf8');
  const service = new CharacterLibraryService({
    builtinDataRoot,
    userStore: {
      snapshot: () => normalizeStoredData({ schemaVersion: 1 }, { enforceTextLimits: false }),
      replace: () => {},
    },
  });

  const first = service.loadCatalog();
  fs.rmSync(builtinDataRoot, { recursive: true, force: true });
  const second = service.loadCatalog();

  assert.deepEqual(second, first);
});

test('Rendererから受け取るユーザーキャラクターJSONは共有8MB上限を超える前に拒否する', () => {
  const service = new CharacterLibraryService({
    builtinDataRoot: path.join(__dirname, '..', '..', '..', 'app', 'renderer', 'data', 'characters'),
    userStore: {
      snapshot: () => normalizeStoredData({ schemaVersion: 1 }, { enforceTextLimits: false }),
      replace: () => {
        throw new Error('サイズ超過時は保存処理へ到達してはいけません。');
      },
    },
  });
  const payload = {
    format: 'ai-werewolf-character-library',
    schemaVersion: 1,
    groups: [],
    padding: 'x'.repeat(USER_CHARACTER_LIBRARY_MAX_BYTES),
  };
  assert.throws(
    () => service.replaceUserLibrary(payload),
    /8MB以下/u,
  );
});
