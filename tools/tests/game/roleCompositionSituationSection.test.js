/**
 * 責務: Day2以降の通常昼議論第1巡だけに、初期公開役職構成から夜明け結果の追加解釈候補を必要な見出しだけ提示する契約を検証する。
 * 変更ルール: 現在の生存者・死亡者・CO・内部配役を表示条件へ持ち込まず、人狼の存在はゲーム成立条件として個別判定しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoleCompositionSituationGuide,
  roleCompositionSituationSection,
} from '../../../app/renderer/js/prompts/sections/roleCompositionSituationSection.js';

function context(roleComposition, { day = 2, round = 1, roundKind = 'normal' } = {}) {
  return {
    game: {
      day,
      roleComposition,
      discussion: { round, roundKind },
    },
  };
}

test('夜明け状況ガイドはDay2以降の通常昼議論第1巡だけに表示する', () => {
  const roles = { wolf: 1, guard: 1 };
  assert.equal(roleCompositionSituationSection(context(roles, { day: 1 }), 'speech'), '');
  assert.equal(roleCompositionSituationSection(context(roles, { round: 2 }), 'speech'), '');
  assert.equal(roleCompositionSituationSection(context(roles, { roundKind: 'reconsideration' }), 'speech'), '');
  assert.equal(roleCompositionSituationSection(context(roles), 'priority-answer'), '');
  assert.match(roleCompositionSituationSection(context(roles), 'speech'), /死亡者なし/u);
  assert.match(roleCompositionSituationSection(context(roles), 'speech-designated'), /死亡者なし/u);
  assert.match(roleCompositionSituationSection(context(roles), 'speech-free'), /死亡者なし/u);
});

test('追加解釈候補がない構成ではガイド全体を表示しない', () => {
  const roles = { wolf: 1, villager: 3, seer: 1, medium: 1, madman: 1 };
  assert.equal(buildRoleCompositionSituationGuide(context(roles), 'speech'), null);
  assert.equal(roleCompositionSituationSection(context(roles), 'speech'), '');
});

test('各見出しは初期役職構成から意味がある場合だけ表示する', () => {
  const guardOnly = roleCompositionSituationSection(context({ wolf: 1, guard: 1 }), 'speech');
  assert.doesNotMatch(guardOnly, /死亡者が2人以上/u);
  assert.match(guardOnly, /死亡者なし/u);
  assert.match(guardOnly, /護衛による襲撃阻止/u);
  assert.doesNotMatch(guardOnly, /凍結なし/u);

  const catOnly = roleCompositionSituationSection(context({ wolf: 1, cat: 1 }), 'speech');
  assert.match(catOnly, /死亡者が2人以上/u);
  assert.match(catOnly, /人狼による襲撃/u);
  assert.match(catOnly, /猫又の道連れ/u);
  assert.doesNotMatch(catOnly, /死亡者なし/u);
  assert.doesNotMatch(catOnly, /凍結なし/u);

  const foxWithoutSeer = roleCompositionSituationSection(context({ wolf: 1, fox: 1 }), 'speech');
  assert.doesNotMatch(foxWithoutSeer, /死亡者が2人以上/u);
  assert.match(foxWithoutSeer, /死亡者なし/u);
  assert.match(foxWithoutSeer, /妖狐への襲撃/u);
  assert.doesNotMatch(foxWithoutSeer, /妖狐の呪殺/u);
});

test('複合役職構成では存在する事象だけを列挙し現在の生存情報を参照しない', () => {
  const roles = {
    wolf: 2,
    seer: 1,
    fox: 1,
    guard: 1,
    namahage: 1,
    snowWoman: 1,
    zashikiWarashi: 1,
    cat: 1,
  };
  const base = context(roles);
  base.board = { alive: [], dead: [{ roleId: 'guard' }, { roleId: 'fox' }] };
  const text = roleCompositionSituationSection(base, 'speech');
  assert.match(text, /死亡者が2人以上/u);
  assert.match(text, /妖狐の呪殺/u);
  assert.match(text, /座敷わらしの後追い/u);
  assert.match(text, /猫又の道連れ/u);
  assert.match(text, /死亡者なし/u);
  assert.match(text, /護衛による襲撃阻止/u);
  assert.match(text, /なまはげの訪問による襲撃阻害/u);
  assert.match(text, /妖狐への襲撃/u);
  assert.match(text, /凍結なし/u);
  assert.match(text, /護衛による凍結阻止/u);
  assert.match(text, /なまはげの訪問による凍結阻害/u);
  assert.match(text, /凍結対象の同夜死亡/u);
  assert.match(text, /雪女が夜開始時点ですでに死亡、または同夜死亡/u);
  assert.match(text, /死亡者が1人の場合でも/u);
});
