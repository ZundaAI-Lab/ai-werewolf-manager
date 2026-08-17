/**
 * 責務: AIへ渡す役職説明が現在配役・公開ルール・本人限定知識だけから、特殊役職の実装仕様を短く正確に説明することを検証する。
 * 変更ルール: UIヘルプ文面は検証せず、一般的な人狼知識へ委ねると誤解しやすい相互作用、通知境界、勝敗上の人数属性だけを固定する。配役に存在しない相互作用をプロンプトへ増やさない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initialGameRulesSection, initialRoleRulesSection } from '../../../app/renderer/js/prompts/sections/promptFormatters.js';
import { renderRoleGuidance } from '../../../app/renderer/js/prompts/templates/rolePromptTemplates.js';

function context({
  roleComposition,
  roleId = 'villager',
  knownWolfIds = [],
  wolfCommunicationEnabled = false,
  wolfCommunicationParticipantMode = 'wolves-only',
} = {}) {
  return {
    game: {
      roleComposition: { ...(roleComposition ?? {}) },
      rules: {
        wolfCommunication: {
          enabled: wolfCommunicationEnabled,
          participantMode: wolfCommunicationParticipantMode,
        },
      },
    },
    player: {
      roleId,
      strategyProfile: roleId === 'whiteWolf' || roleId === 'wolf' ? 'wolf' : roleId === 'snowWoman' ? 'madman' : null,
      knowledge: { knownWolfIds: [...knownWolfIds] },
      zashikiStrategy: null,
    },
    task: { type: 'speech' },
  };
}

test('初夜占いルール表示は実際のseerModeと一致しランダム白を占いなしへ落とさない', () => {
  const gameRulesContext = (seerMode) => ({
    game: {
      roleComposition: { villager: 2, seer: 1, wolf: 1 },
      rules: {
        vote: {
          selfVoteAllowed: false,
          abstentionAllowed: false,
          revealExecutedRole: false,
          runoffLimit: 1,
          tieResolution: 'no-execution',
        },
        firstNight: {
          wolfCommunicationEnabled: true,
          wolfAttackEnabled: false,
          seerMode,
          guardEnabled: false,
        },
      },
    },
  });

  const choose = initialGameRulesSection(gameRulesContext('choose'));
  assert.match(choose, /初夜=.*占い対象選択/u);

  const randomWhite = initialGameRulesSection(gameRulesContext('random-non-wolf'));
  assert.match(randomWhite, /初夜=.*占いランダム白（非人狼を自動選択）/u);
  assert.doesNotMatch(randomWhite, /初夜=.*占いなし/u);

  const disabled = initialGameRulesSection(gameRulesContext('disabled'));
  assert.match(disabled, /初夜=.*占いなし/u);
});

test('共通役職説明は配役に存在する特殊相互作用だけを短く説明する', () => {
  const withoutFox = initialRoleRulesSection(context({
    roleComposition: { villager: 2, seer: 1, wolf: 1 },
  }));
  assert.match(withoutFox, /占い師×1[^\n]*夜に1人を占い、人狼かを知る。/u);
  assert.doesNotMatch(withoutFox, /妖狐を占うと死亡/u);

  const withFox = initialRoleRulesSection(context({
    roleComposition: { villager: 1, seer: 1, fox: 1, wolf: 1 },
  }));
  assert.match(withFox, /占い師×1[^\n]*妖狐を占うと死亡させる/u);
});

test('なまはげ説明は悪い子を現在配役から列挙し恐怖の共同襲撃仕様を正しく示す', () => {
  const prompt = initialRoleRulesSection(context({
    roleComposition: { villager: 1, namahage: 1, madman: 1, snowWoman: 1, whiteWolf: 1 },
  }));
  assert.match(prompt, /なまはげ×1[^\n]*悪い子（今回: 雪女・白狼）/u);
  assert.match(prompt, /生存人狼全員が恐怖時のみ阻害/u);
  assert.match(prompt, /恐怖は阻害成立時だけ解除/u);
  assert.doesNotMatch(prompt, /狂人.*悪い子/u);
  assert.doesNotMatch(prompt, /恐怖は行動後解除/u);
});

test('雪女説明は生存人狼数・人狼認識・翌朝公開・不成立条件を現在ルールに合わせる', () => {
  const hiddenWolves = initialRoleRulesSection(context({
    roleComposition: { villager: 1, guard: 1, snowWoman: 1, wolf: 1 },
  }));
  assert.match(hiddenWolves, /雪女×1[^\n]*生存人狼数に数えず、人狼を知らない/u);
  assert.match(hiddenWolves, /成功時は翌日昼会話・投票不可[^\n]*翌朝公開/u);
  assert.match(hiddenWolves, /護衛・同夜死亡などで不発/u);
  assert.doesNotMatch(hiddenWolves, /成否非通知|恐怖で行動阻害/u);

  const sharedWolves = initialRoleRulesSection(context({
    roleComposition: { namahage: 1, snowWoman: 1, wolf: 1 },
    wolfCommunicationEnabled: true,
    wolfCommunicationParticipantMode: 'wolves-and-madman',
  }));
  assert.match(sharedWolves, /雪女×1[^\n]*人狼を知る/u);
  assert.doesNotMatch(sharedWolves, /恐怖で行動阻害される場合あり/u);
});

test('白狼・猫又・座敷わらしは単独説明だけで特殊仕様を理解できる', () => {
  const prompt = initialRoleRulesSection(context({
    roleComposition: { whiteWolf: 1, cat: 1, zashikiWarashi: 1, villager: 1 },
  }));
  assert.match(prompt, /白狼×1[^\n]*生存人狼数にも数える[^\n]*占いでは非人狼、霊能では人狼判定/u);
  assert.doesNotMatch(prompt, /通常の人狼と同じ/u);
  assert.match(prompt, /猫又×1[^\n]*道連れで死亡した猫又の能力は連鎖しない/u);
  assert.match(prompt, /座敷わらし×1[^\n]*家主側には関係非通知[^\n]*人狼陣営でも生存人狼数に数えず/u);
});

test('狂人本人向け判断文も実際の人狼認識設定と矛盾しない', () => {
  const unknown = context({ roleComposition: { madman: 1, wolf: 1 }, roleId: 'madman' });
  assert.match(renderRoleGuidance(unknown, { taskType: 'speech' }), /人狼の正体は分かりません/u);
  assert.match(renderRoleGuidance(unknown, { taskType: 'vote' }), /人狼を知らない場合は候補を既知情報として扱わない/u);

  const known = context({
    roleComposition: { madman: 1, wolf: 1 },
    roleId: 'madman',
    knownWolfIds: ['wolf-1'],
    wolfCommunicationEnabled: true,
    wolfCommunicationParticipantMode: 'wolves-and-madman',
  });
  assert.match(renderRoleGuidance(known, { taskType: 'speech' }), /人狼の正体は本人の確定情報です/u);
  assert.doesNotMatch(renderRoleGuidance(known, { taskType: 'vote' }), /標準設定では人狼の正体は分かりません/u);
});

test('雪女本人向け判断文は凍結成功の公開結果と実際の既知人狼だけを確定扱いする', () => {
  const unknownContext = context({
    roleComposition: { guard: 1, snowWoman: 1, wolf: 1 },
    roleId: 'snowWoman',
  });
  const day = renderRoleGuidance(unknownContext, { taskType: 'speech' });
  assert.match(day, /生存人狼数には数えません/u);
  assert.match(day, /人狼の正体は分かりません/u);
  assert.match(day, /凍結成功は翌朝の凍結表示で確認できます/u);
  assert.doesNotMatch(day, /成否.*通知され/u);

  const knownContext = context({
    roleComposition: { snowWoman: 1, wolf: 1 },
    roleId: 'snowWoman',
    knownWolfIds: ['wolf-1'],
  });
  assert.match(renderRoleGuidance(knownContext, { taskType: 'speech' }), /人狼の正体は本人の確定情報です/u);
  assert.match(renderRoleGuidance(knownContext, { taskType: 'vote' }), /凍結成功は翌朝の公開結果で更新/u);
});

test('雪女凍結と なまはげ訪問の本人用説明は不成立条件を一般知識へ委ねない', () => {
  const snow = context({
    roleComposition: { namahage: 1, guard: 1, snowWoman: 1, wolf: 1 },
    roleId: 'snowWoman',
  });
  const freeze = renderRoleGuidance(snow, { taskType: 'freeze' });
  assert.match(freeze, /護衛されるか同夜に死亡すると翌日の凍結は発生せず/u);
  assert.match(freeze, /成功時は翌朝に公開/u);
  assert.match(freeze, /なまはげの恐怖で凍結行動自体が阻害/u);
  assert.match(freeze, /襲撃で対象が死亡すると凍結効果は残らない/u);
  assert.doesNotMatch(freeze, /襲撃先と凍結先が重なると対象は翌日に生存せず/u);

  const namahage = context({
    roleComposition: { namahage: 1, madman: 1, snowWoman: 1, wolf: 1 },
    roleId: 'namahage',
  });
  const visit = renderRoleGuidance(namahage, { taskType: 'visit' });
  assert.match(visit, /人狼・雪女の「悪い子」/u);
  assert.match(visit, /悪い子以外には効果がなく/u);
  assert.doesNotMatch(visit, /村人陣営には効果がなく/u);
});

test('猫又本人向け昼・投票説明も道連れ能力の非連鎖を明示する', () => {
  const cat = context({ roleComposition: { cat: 1, wolf: 1, villager: 2 }, roleId: 'cat' });
  assert.match(renderRoleGuidance(cat, { taskType: 'speech' }), /道連れで死亡した猫又の能力は連鎖しません/u);
  assert.match(renderRoleGuidance(cat, { taskType: 'vote' }), /道連れで死亡した猫又の能力は連鎖しません/u);
});
