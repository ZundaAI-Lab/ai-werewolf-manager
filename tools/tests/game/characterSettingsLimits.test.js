/**
 * 責務: ユーザーが編集するキャラクター識別情報・話し方設定の共有文字数上限を、共有Policyの受理／拒否挙動で検証する。
 * 変更ルール: CSSのpx値、DOM配置、class名、ラベル文言など表示細部を固定しない。入力制約の意味契約だけをcharacterTextPolicy経由で確認する。
 */

import './testEnvironment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_TEXT_LIMITS,
  validateCharacterTextPayload,
} from '../../../app/renderer/js/characters/config/characterTextPolicyAdapter.js';

function characterPayload(overrides = {}) {
  return {
    name: 'テスト',
    aliases: [],
    character: {
      profile: '',
      firstPerson: '',
      genericSecondPerson: '',
      speakingStyle: '',
      defaultEndings: '',
      avoidedExpressions: '',
      speechExamples: '',
      discussionBehavior: '',
      conversationSeeds: [],
      ...overrides.character,
    },
    callNames: {},
    ...overrides,
  };
}

test('ユーザーキャラクターの表示名・別名・避ける表現は共有上限で受理／拒否する', () => {
  assert.equal(CHARACTER_TEXT_LIMITS.name, 30);
  assert.equal(CHARACTER_TEXT_LIMITS.alias, 30);
  assert.equal(CHARACTER_TEXT_LIMITS.aliasesMax, 5);
  assert.equal(CHARACTER_TEXT_LIMITS.avoidedExpressions, 30);

  const valid = characterPayload({
    name: '名'.repeat(30),
    aliases: Array.from({ length: 5 }, (_, index) => `${index}${'別'.repeat(29)}`),
    character: { avoidedExpressions: '避'.repeat(30) },
  });
  assert.deepEqual(validateCharacterTextPayload(valid), []);

  assert.ok(validateCharacterTextPayload(characterPayload({ name: '名'.repeat(31) })).length > 0);
  assert.ok(validateCharacterTextPayload(characterPayload({ aliases: ['別'.repeat(31)] })).length > 0);
  assert.ok(validateCharacterTextPayload(characterPayload({ aliases: Array.from({ length: 6 }, (_, index) => `別名${index}`) })).length > 0);
  assert.ok(validateCharacterTextPayload(characterPayload({ character: { avoidedExpressions: '避'.repeat(31) } })).length > 0);
});
