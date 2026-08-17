/**
 * 責務: ユーザーが編集するキャラクター識別情報・話し方設定の共有文字数上限と、両詳細画面で共用する短文入力レイアウト契約を検証する。
 * 変更ルール: characterTextPolicyの数値を別定義せず、現行の公開上限と共通Viewがゲーム準備・キャラクター管理の双方へ適用されることだけを確認する。
 */

import './testEnvironment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHARACTER_TEXT_LIMITS,
  validateCharacterTextPayload,
} from '../../../app/renderer/js/characters/config/characterTextPolicyAdapter.js';
import { renderCharacterEditor } from '../../../app/renderer/js/ui/views/characters/characterLibraryView.js';
import { renderPlayerDetailForm } from '../../../app/renderer/js/ui/views/setup/playerDetailView.js';
import { renderSetupPlayerRow } from '../../../app/renderer/js/ui/views/setup/setupPlayerRowView.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

function setupPlayer() {
  return {
    id: 'player-test',
    name: 'テスト',
    aliases: [],
    characterCardId: null,
    controller: 'human',
    roleId: 'villager',
    privateInfo: '',
    callNameOverrides: {},
    character: characterPayload().character,
  };
}

test('ユーザーキャラクターの表示名・別名・避ける表現は30文字を上限とする', () => {
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

  assert.match(
    validateCharacterTextPayload(characterPayload({ name: '名'.repeat(31) })).join('\n'),
    /表示名は30文字以内/u,
  );
  assert.match(
    validateCharacterTextPayload(characterPayload({ aliases: ['別'.repeat(31)] })).join('\n'),
    /別名1は30文字以内/u,
  );
  assert.match(
    validateCharacterTextPayload(characterPayload({ aliases: Array.from({ length: 6 }, (_, index) => `別名${index}`) })).join('\n'),
    /別名は最大5件/u,
  );
  assert.match(
    validateCharacterTextPayload(characterPayload({ character: { avoidedExpressions: '避'.repeat(31) } })).join('\n'),
    /避ける表現は30文字以内/u,
  );
});

test('ゲーム準備とキャラクター詳細は同じ上限表示と短文1行レイアウトを使用する', () => {
  const player = setupPlayer();
  const setupHtml = renderPlayerDetailForm({ player, players: [player] });
  const editorHtml = renderCharacterEditor({
    group: { id: 'user-test', name: 'ユーザー', origin: 'user' },
    card: { id: 'card-test', name: 'テスト', aliases: [], character: player.character, callNames: {} },
  });

  for (const html of [setupHtml, editorHtml]) {
    assert.match(html, /別名（各最大30文字・5件まで）/u);
    assert.match(html, /class="field full character-standard-text-field">\s*<span>基本語尾（最大30文字）/u);
    assert.match(html, /class="field full character-standard-text-field">\s*<span>避ける表現（最大30文字）/u);
    assert.match(html, /textarea name="speechExamples" maxlength="120"/u);
  }

  assert.match(editorHtml, /表示名（最大30文字）[\s\S]*?<input name="name" maxlength="30"/u);

  const setupRowHtml = renderSetupPlayerRow({ players: [player], player, index: 0, locked: false });
  assert.match(setupRowHtml, /class="player-name-input"[^>]*maxlength="30"/u);
});

test('共通詳細CSSは口調例を10px拡張し基本語尾・避ける表現を各行の全幅にする', () => {
  const css = readFileSync(join(projectRoot, 'app', 'renderer', 'css', 'styles.css'), 'utf8');
  assert.match(css, /textarea\[name="speechExamples"\]\s*\{\s*min-height:\s*102px;/u);
  assert.match(css, /\.player-detail-section \.character-standard-text-field > input\s*\{\s*width:\s*100%;\s*\}/u);
  assert.doesNotMatch(css, /character-standard-text-field[\s\S]{0,180}calc\(\(100% - 12px\) \/ 2\)/u);
});
