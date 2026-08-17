/**
 * 責務: 完全機械契約・静的網羅性検査・常時システム契約・フェーズ別重点契約の責務分離を確認する。
 * 変更ルール: 原則出力項目の欠落を回答合否条件にせず、プロンプト掲載・JSON例・条件付き出力との分離を検証する。外部JSONキーと内部保存キーを混在させず、局面依存列挙値を動的ポリシーどおり案内する。静的網羅性検査は本番プロンプトへ混入させず、現在必須・公開通知・動的必須項目はフェーズ契約として検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_PROFILE_PROMPT_DESCRIPTIONS } from '../../../app/renderer/js/config/constants.js';
import {
  buildResponseConditionalExamples,
  buildResponseContractExample,
  getDecisionChangeKeys,
  getDecisionPatchKeys,
  getFactionStrategyResponseFields,
  getRequiredResponseTopLevelKeys,
  getResponseModeForTask,
  getResponseTopLevelKeys,
  getRoleCompatibleResponseTopLevelKeys,
} from '../../../app/renderer/js/prompts/response/responseContract.js';
import {
  buildActiveResponseContractExample,
  renderActiveResponseContract,
  renderActiveResponseFinalConfirmation,
} from '../../../app/renderer/js/prompts/response/activeResponseContract.js';
import {
  PERSISTENT_AI_SYSTEM_INSTRUCTION,
  validateResponseContractCatalogCoverage,
} from '../../../app/renderer/js/prompts/response/responseContractCatalog.js';
import { buildResponseExampleReferences } from '../../../app/renderer/js/prompts/response/responseExampleReferences.js';
import { buildStructuredOutputContract } from '../../../app/renderer/js/prompts/response/structuredOutputContract.js';
import {
  ROLE_BRIEFING_TEMPLATE,
  renderPublicSpeechGuidance,
  renderTaskInvariantInstruction,
  renderTaskVariableInstruction,
  renderWolfDayStrategyInstruction,
  renderEndgameFactionTacticsInstruction,
  renderTwoSeerExecutionInstruction,
  renderFinalResponseReminder,
  renderOpeningConversationSection,
} from '../../../app/renderer/js/prompts/templates/promptTemplates.js';
import {
  PUBLIC_SPEECH_LENGTH_OPTIONS,
  resolvePublicSpeechLengthPolicy,
} from '../../../app/renderer/js/domain/policies/publicSpeechLengthPolicy.js';
import { DECISION_ASSESSMENT_LEVELS } from '../../../app/renderer/js/domain/game/decisionState.js';
import { renderPublicSpeechSemanticRules, renderExecutionValueSemanticRules, renderFactionExecutionValueSemanticRules, renderWolfAttackSemanticRules } from '../../../app/renderer/js/prompts/policies/taskInstructionPolicy.js';
import { buildVoteDecisionPatchGuidanceRows } from '../../../app/renderer/js/prompts/policies/voteResponseGuidancePolicy.js';
import { renderRuntimeReasoningPolicy } from '../../../app/renderer/js/prompts/templates/reasoningPolicyTemplates.js';
import { latestDecisionState } from '../../../app/renderer/js/prompts/sections/privateInformationSection.js';

const claimRolePolicy = Object.freeze({
  coRoleIds: Object.freeze(['seer', 'medium']),
  abilityClaimRoleIds: Object.freeze(['seer', 'medium']),
});

function renderTaskInstructionForTest(options = {}) {
  return [
    renderTaskInvariantInstruction(options),
    renderTaskVariableInstruction(options),
  ].filter(Boolean).join('\n\n');
}

const partnerDispositionPolicy = Object.freeze({
  allowedValues: Object.freeze(['independent', 'support', 'separate']),
});

function parseLastJson(prompt) {
  const line = String(prompt).trim().split(/\r?\n/u).at(-1);
  return JSON.parse(line);
}



test('雪女のfreezeは専用応答モードを保ったまま個人夜行動として分類する', () => {
  assert.equal(getResponseModeForTask('freeze'), 'freeze-action');
});

test('実行時許可キーとフェーズ表示は本人役職に応じて陣営戦略更新を切り替える', () => {
  for (const mode of ['speech', 'priority-answer', 'vote']) {
    assert.equal(getRoleCompatibleResponseTopLevelKeys(mode, 'villager').includes('factionStrategyUpdate'), false, mode);
    assert.equal(getRoleCompatibleResponseTopLevelKeys(mode, 'seer').includes('factionStrategyUpdate'), false, mode);
    assert.equal(getRoleCompatibleResponseTopLevelKeys(mode, 'wolf').includes('factionStrategyUpdate'), true, mode);
    assert.equal(getRoleCompatibleResponseTopLevelKeys(mode, 'madman').includes('factionStrategyUpdate'), true, mode);
    assert.equal(getRoleCompatibleResponseTopLevelKeys(mode, 'fox').includes('factionStrategyUpdate'), true, mode);
  }

  const villagerPrompt = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'villager',
    factionStrategyUpdatePolicy: { required: true },
  });
  assert.match(villagerPrompt, /トップレベルキーは publicSpeech .* memoAdd 以外/u);
  assert.doesNotMatch(villagerPrompt, /factionStrategyUpdate/u);
  assert.equal(Object.hasOwn(buildActiveResponseContractExample({
    mode: 'speech',
    roleId: 'villager',
    factionStrategyUpdatePolicy: { required: true },
  }), 'factionStrategyUpdate'), false);

  const wolfPrompt = renderActiveResponseContract({ mode: 'speech', roleId: 'wolf' });
  assert.match(wolfPrompt, /トップレベルキーは .*factionStrategyUpdate/u);
  assert.match(wolfPrompt, /factionStrategyUpdateは、現在の局面から本人限定の陣営戦略を変更・具体化/u);
});


test('通常公開発言のフェーズ契約は原則出力を主形式へ掲載し事実操作だけ条件付きで案内する', () => {
  const example = buildActiveResponseContractExample({
    mode: 'speech',
    roleId: 'wolf',
    claimRolePolicy,
    partnerDispositionPolicy,
  });
  assert.deepEqual(Object.keys(example), [
    'publicSpeech', 'decisionPatch', 'factionStrategyUpdate', 'heartVoice', 'memoAdd',
  ]);
  for (const key of ['speechInteraction', 'coOperation', 'abilityClaims']) {
    assert.equal(Object.hasOwn(example, key), false, key);
  }
  const contractPrompt = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'wolf',
    claimRolePolicy,
    partnerDispositionPolicy,
  });
  const finalConfirmation = renderActiveResponseFinalConfirmation({
    mode: 'speech',
    roleId: 'wolf',
    claimRolePolicy,
    partnerDispositionPolicy,
  });
  assert.deepEqual(parseLastJson(finalConfirmation), example);
  assert.doesNotMatch(contractPrompt, /今回の必須出力/u);
  assert.match(finalConfirmation, /今回の必須出力: publicSpeech/u);
  const prompt = contractPrompt;
  assert.match(prompt, /CO条件付き形式/u);
  assert.match(prompt, /CO条件付き形式: \{"coOperation":\{/u);
  assert.match(prompt, /能力結果条件付き形式/u);
  assert.match(prompt, /能力結果条件付き形式: \{"abilityClaims":\[/u);
  assert.match(prompt, /speechInteraction直下で使用できるキーはquestionTargets \/ answerEventSequencesだけ/u);
  assert.match(prompt, /内部保存名のquestionTargetNames.*出力しません/u);
  assert.match(prompt, /publicSpeechで直接質問する場合は必ず追加/u);
  assert.match(prompt, /speechInteraction自体を省略/u);
  assert.match(prompt, /### 原則出力/u);
  assert.match(prompt, /生成できる限り出力/u);
  assert.match(prompt, /heartVoiceは原則出力/u);
  assert.match(prompt, /### 条件付き出力/u);
  assert.match(prompt, /memoAddは、今回得た仮説・警戒点・予定など次ターン以降も残す価値がある新規内容/u);
  assert.match(prompt, /factionStrategyUpdateは、現在の局面から本人限定の陣営戦略を変更・具体化/u);
  assert.match(prompt, /partnerDispositionの有効値は independent \/ support \/ separate/u);
  assert.match(prompt, /independent=仲間を特別扱いせず公開根拠で評価/u);
  assert.doesNotMatch(prompt, /初期完全契約/u);
});


test('夜行動・襲撃・雪女は理由と比較をフェーズ主形式に維持する', () => {
  assert.deepEqual(Object.keys(buildActiveResponseContractExample({ mode: 'night-action', roleId: 'seer' })), [
    'actionAnswer', 'actionRationale',
  ]);
  assert.deepEqual(Object.keys(buildActiveResponseContractExample({ mode: 'attack-action', roleId: 'wolf' })), [
    'actionAnswer', 'attackAssessment', 'actionRationale',
  ]);
  assert.deepEqual(Object.keys(buildActiveResponseContractExample({
    mode: 'freeze-action', roleId: 'snowWoman', freezeEstimateLimit: { min: 1, max: 3 },
  })), ['estimate', 'actionAnswer', 'actionRationale']);
});


test('全モードの完全例キーは機械許可キーの範囲内にある', () => {
  for (const [mode, roleId] of [
    ['speech', 'wolf'], ['speech-designated', 'wolf'], ['speech-free', 'wolf'],
    ['discussion-opening-preference', 'villager'], ['priority-answer', 'seer'], ['testament', 'seer'],
    ['vote', 'wolf'], ['wolf', 'wolf'], ['mason', 'mason'], ['graveyard', 'villager'],
    ['attack-action', 'wolf'], ['freeze-action', 'snowWoman'], ['night-action', 'seer'],
    ['none', 'villager'], ['public-only', 'villager'], ['memo', 'villager'],
  ]) {
    const example = buildResponseContractExample({ mode, roleId, claimRolePolicy, partnerDispositionPolicy });
    const allowed = new Set(getResponseTopLevelKeys(mode));
    assert.equal(Object.keys(example).every((key) => allowed.has(key)), true, mode);
  }
});


test('常時契約と網羅性検査は原則出力の生成を促し欠落をエラーへ昇格させない', () => {
  assert.match(PERSISTENT_AI_SYSTEM_INSTRUCTION, /原則出力は意味のある内容がある限り/u);
  assert.match(PERSISTENT_AI_SYSTEM_INSTRUCTION, /情報不足・該当なしだけ省略できます/u);
  assert.match(PERSISTENT_AI_SYSTEM_INSTRUCTION, /条件付き出力は実際に条件を満たす時だけ/u);

  assert.equal(validateResponseContractCatalogCoverage().ok, true);
  assert.equal(getResponseTopLevelKeys('speech').includes('heartVoice'), true);
});


test('decisionPatchを持たないタスクへ前回判断の再記録指示を出さない', () => {
  for (const mode of ['public-only', 'night-action', 'attack-action']) {
    const prompt = renderActiveResponseContract({
      mode,
      roleId: mode === 'attack-action' ? 'wolf' : 'villager',
      hasPreviousDecision: false,
      decisionPatchRequired: true,
    });
    assert.doesNotMatch(prompt, /現在の公開情報から記録してください/u, mode);
  }
  const speechPrompt = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'villager',
    hasPreviousDecision: false,
    decisionPatchRequired: true,
  });
  const speechFinalConfirmation = renderActiveResponseFinalConfirmation({
    mode: 'speech',
    roleId: 'villager',
    hasPreviousDecision: false,
    decisionPatchRequired: true,
  });
  assert.doesNotMatch(speechPrompt, /現在の公開情報から記録してください/u);
  assert.match(speechFinalConfirmation, /現在の公開情報から記録してください/u);
});


test('単独人狼には存在しない仲間の支援・距離取り・救出票計算を指示しない', () => {
  const soloPrompt = renderWolfDayStrategyInstruction({
    alivePartnerNames: [],
    allowedPartnerDispositions: ['not-applicable'],
    voteRequired: true,
  });
  assert.doesNotMatch(soloPrompt, /partnerDisposition/u);
  assert.match(soloPrompt, /仲間への公開上の扱い方は今回の戦略項目に含めません/u);
  assert.match(soloPrompt, /以降は単独で票数/u);
  assert.doesNotMatch(soloPrompt, /通常の既定値はindependent/u);
  assert.doesNotMatch(soloPrompt, /support \/ separate/u);
  assert.doesNotMatch(soloPrompt, /仲間救出に必要な票数/u);
  assert.doesNotMatch(soloPrompt, /仲間と同じ対象を疑う/u);

  const partneredPrompt = renderWolfDayStrategyInstruction({
    alivePartnerNames: ['プレイヤー2'],
    allowedPartnerDispositions: ['independent', 'support', 'separate'],
    voteRequired: true,
  });
  assert.match(partneredPrompt, /通常の既定値はindependent/u);
  assert.match(partneredPrompt, /仲間救出に必要な票数/u);
});



test('フェーズ契約は生存仲間がいない場合partnerDisposition自体をAI出力候補から外す', () => {
  const partneredPolicy = { hasAlivePartner: true, allowedValues: ['independent', 'support', 'separate'] };
  const partnered = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'wolf',
    partnerDispositionPolicy: partneredPolicy,
  });
  assert.match(partnered, /independent \/ support \/ separate/u);
  assert.equal(getFactionStrategyResponseFields('wolf', partneredPolicy).includes('partnerDisposition'), true);

  const soloPolicy = { hasAlivePartner: false, allowedValues: ['not-applicable'], requiredValue: 'not-applicable' };
  const solo = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'wolf',
    partnerDispositionPolicy: soloPolicy,
  });
  const soloExample = buildActiveResponseContractExample({
    mode: 'speech',
    roleId: 'wolf',
    partnerDispositionPolicy: soloPolicy,
  });
  assert.equal(getFactionStrategyResponseFields('wolf', soloPolicy).includes('partnerDisposition'), false);
  assert.doesNotMatch(solo, /partnerDisposition/u);
  assert.equal(Object.hasOwn(soloExample.factionStrategyUpdate.changes, 'partnerDisposition'), false);
  assert.doesNotMatch(solo, /support=公開上/u);
});



test('投票の陣営戦略更新ポリシーがrequiredでも機械必須でなければ必須表示へ昇格しない', () => {
  const prompt = renderActiveResponseContract({
    mode: 'vote',
    roleId: 'wolf',
    hasPreviousFactionStrategy: false,
    factionStrategyUpdatePolicy: {
      required: true,
      keepAllowed: false,
    },
    partnerDispositionPolicy,
  });

  const finalConfirmation = renderActiveResponseFinalConfirmation({
    mode: 'vote',
    roleId: 'wolf',
    hasPreviousFactionStrategy: false,
    factionStrategyUpdatePolicy: {
      required: true,
      keepAllowed: false,
    },
    partnerDispositionPolicy,
  });
  assert.doesNotMatch(prompt, /今回の必須出力/u);
  assert.match(finalConfirmation, /今回の必須出力: actionAnswer。/u);
  assert.doesNotMatch(finalConfirmation, /今回は陣営戦略更新が必須です/u);
  assert.match(prompt, /factionStrategyUpdateは、現在の局面から本人限定の陣営戦略を変更・具体化/u);
  assert.deepEqual(Object.keys(parseLastJson(finalConfirmation)), [
    'actionAnswer', 'actionRationale', 'decisionPatch', 'factionStrategyUpdate', 'memoAdd',
  ]);
});


test('公開発言量は数値を最終確認へ委ね、人間向けラベルを表示せず局面固有の指示だけ残す', () => {
  for (const option of PUBLIC_SPEECH_LENGTH_OPTIONS) {
    const normalPolicy = resolvePublicSpeechLengthPolicy(option, { conversationMode: 'normal' });
    assert.equal(Object.hasOwn(normalPolicy, 'label'), false, option);
    assert.equal(renderPublicSpeechGuidance(normalPolicy), '', option);
  }

  const openingPolicy = resolvePublicSpeechLengthPolicy('標準', { conversationMode: 'first-speaker' });
  const openingGuidance = renderPublicSpeechGuidance(openingPolicy);
  assert.match(openingGuidance, /選択された導入意図に沿った短い自然な一言/u);
  assert.match(openingGuidance, /COまたは能力履歴公開/u);
  assert.doesNotMatch(openingGuidance, /表現方針|標準/u);

  const earlyPolicy = resolvePublicSpeechLengthPolicy('標準', { conversationMode: 'early-reaction' });
  const earlyGuidance = renderPublicSpeechGuidance(earlyPolicy);
  assert.match(earlyGuidance, /既存発言への反応と、自分が加える短い差分/u);
  assert.doesNotMatch(earlyGuidance, /表現方針|標準/u);

  const instruction = renderTaskInstructionForTest({
    taskType: 'speech',
    publicSpeechGuidance: earlyGuidance,
  });
  assert.match(instruction, /### 公開発言のルール/u);
  assert.equal(instruction.includes(renderPublicSpeechSemanticRules()), true, '深度1の公開発言意味ルールは共通Policyを正本とする');
  assert.match(instruction, /直接質問への回答と、公開情報によって生じた評価の変更を優先/u);
  assert.doesNotMatch(instruction, /未提示の観点・比較・仮説・具体的質問|新規性のために/u);
  assert.match(instruction, /対象・結論・根拠・質問・展開が実質同じ発言や、その単なる言い換えを繰り返さない/u);
  assert.match(instruction, /同意だけなら短く/u);
  assert.doesNotMatch(instruction, /追加するなら未提示の観点/u);
  assert.match(instruction, /処刑判断や勝敗に直結する重要論点.*必要な部分を短く再提示/u);
  assert.match(instruction, /論点追加や文字数より重複回避を優先/u);
  assert.match(instruction, /現在の判断はdecisionPatchへ記録/u);
  assert.doesNotMatch(instruction, /判断手順、比較軸、今後見る情報、疑いを変える条件/u);
  assert.match(instruction, /処刑候補は、人狼らしさだけでなく処刑・残す価値も必要に応じて/u);
  assert.doesNotMatch(instruction, /各候補について、誤処刑だった場合に失うもの/u);
  assert.match(instruction, /根拠として発言番号を列挙しない/u);
  assert.match(instruction, /公開情報で説明できる差が処刑優先度を分けるときだけ一人へ差を付け.*差がない場合は同程度/u);
  assert.match(instruction, /他者について言及できるのは公開履歴に記録された反応・発言だけ/u);
  assert.doesNotMatch(instruction, /実質的な差分を持たせ|評価変更は公開根拠がある場合だけ/u);
  assert.doesNotMatch(instruction, /公開発言の組み立て|表現方針:/u);

  const earlyConversation = renderOpeningConversationSection({ conversationMode: 'early-reaction' });
  assert.match(earlyConversation, /現在の公開情報と非公開の参考視点から必要な内容だけ/u);
  assert.doesNotMatch(earlyConversation, /公開履歴にない論点・比較・具体的質問を優先/u);
});


test('投票指示は新情報がなければ最終判断を維持し必要時だけ候補を再比較する', () => {
  const vote = renderTaskInstructionForTest({ taskType: 'vote' });
  assert.match(vote, /前回判断後の新しい公開情報だけを確認/u);
  assert.match(vote, /intendedVoteが現在も有効で新情報がなければ維持/u);
  assert.match(vote, /未定・無効、または新情報がある場合だけ.*候補を再比較/u);
  assert.match(vote, /失効した根拠を投票理由へ再利用しない/u);

  const runoff = renderTaskInstructionForTest({ taskType: 'vote', voteType: 'runoff' });
  assert.match(runoff, /同票で明らかになった投票分布/u);
  assert.match(runoff, /新情報がなければ維持/u);
  assert.match(runoff, /失効した根拠を投票理由へ再利用しない/u);
});

test('回答フェーズは説明可能な処刑差がある場合だけ一人へ差を付ける', () => {
  const answer = renderTaskInstructionForTest({ taskType: 'priority-answer' });
  assert.match(answer, /最疑い・一番気になる人物.*公開情報で説明できる差が処刑優先度を分けるときだけ一人へ差を付け.*差がない場合は同程度/u);
});

test('初日材料不足時だけ通常の処刑差ルールを暫定差ルールへ差し替える', () => {
  const speech = renderTaskInstructionForTest({ taskType: 'speech', firstDaySparseEvidence: true });
  assert.match(speech, /差が小さくても公開情報で説明できるなら暫定差/u);
  assert.doesNotMatch(speech, /公開情報で説明できる差が処刑優先度を分けるときだけ一人へ差を付け/u);
});

test('speechは処刑価値を必要時の公開材料に留めvoteへ詳細比較を集約する', () => {
  const speech = renderPublicSpeechSemanticRules();
  assert.match(speech, /処刑候補は、人狼らしさだけでなく処刑・残す価値も必要に応じて/u);
  assert.doesNotMatch(speech, /各候補について、誤処刑だった場合に失うもの/u);

  const vote = renderExecutionValueSemanticRules();
  const village = renderFactionExecutionValueSemanticRules({ team: 'village' });
  assert.match(vote, /疑い順位と今日処刑する価値は別/u);
  assert.match(vote, /処刑した場合・残した場合が自陣営の勝利条件と翌日以降の盤面にどう影響/u);
  assert.match(vote, /最有力の別候補との差/u);
  assert.match(village, /対象が人狼でなかった場合の損失/u);
  assert.match(village, /人狼本体を減らせる可能性/u);
  assert.match(village, /確定人外でも人狼本体と確定していない場合/u);
  assert.equal(renderFactionExecutionValueSemanticRules({ team: 'wolf' }), '');
});

test('vote decisionPatchは既存3比較項目へ処刑価値を集約し新規キーを要求しない', () => {
  const rows = buildVoteDecisionPatchGuidanceRows(getDecisionPatchKeys('vote')).join('\n');
  assert.match(rows, /leaveAliveBenefitには対象を残すことで自陣営が得る利益/u);
  assert.match(rows, /misexecutionCostにはその処刑が自陣営に不利だった場合の主要損失/u);
  assert.match(rows, /selectionDifferenceには最有力の別候補との今日の処刑価値の差/u);
  assert.doesNotMatch(rows, /wolfReduction|executionWolfReduction/u);
});

test('wolf-attackは対象を残すことで増える確定情報も候補差として扱い襲撃理由として案内する', () => {
  const instruction = renderWolfAttackSemanticRules();
  assert.match(instruction, /翌日以降へ新しい確定情報・能力結果・役職確定材料が増えるか/u);
  assert.match(instruction, /候補ごとの護衛リスクと襲撃成功後の盤面価値/u);
  assert.match(instruction, /襲撃理由をactionRationale/u);
  assert.match(instruction, /他の人狼の襲撃先投票は参照せず/u);
  assert.doesNotMatch(instruction, /投票理由をactionRationale/u);
});

test('少数候補へ絞る推理傾向も十分な差がない局面では順位を強制しない', () => {
  assert.match(
    REASONING_PROFILE_PROMPT_DESCRIPTIONS.hypothesisBreadth.narrow,
    /十分な差がある場合.*差が薄い場合は無理に順位を付けず保留/u,
  );
});


test('終盤戦術は陣営分類ごとに真CO・偽CO・票合わせの勝ち筋を一つの共通区画で案内する', () => {
  const wolf = renderEndgameFactionTacticsInstruction({ strategyProfile: 'wolf', team: 'wolf' });
  assert.match(wolf, /真CO・偽CO・撤回・票合わせ/u);
  assert.match(wolf, /役職主張は真実である必要はありません/u);
  assert.match(wolf, /人狼枠.*狂人枠候補.*票を接続/u);

  const madman = renderEndgameFactionTacticsInstruction({ strategyProfile: 'madman', team: 'wolf' });
  assert.match(madman, /狂人枠.*狂人CO・人狼CO.*推定人狼/u);
  assert.match(madman, /人狼位置は既知として扱いません/u);

  const madmanVote = renderEndgameFactionTacticsInstruction({ strategyProfile: 'madman', team: 'wolf', taskType: 'vote' });
  assert.match(madmanVote, /終盤の狂人枠投票/u);
  assert.match(madmanVote, /騙り結果や前回投票予定との整合性より陣営勝率を優先/u);
  assert.match(madmanVote, /従来主張と矛盾する投票も選べ/u);
  assert.equal(renderEndgameFactionTacticsInstruction({ strategyProfile: 'wolf', team: 'wolf', taskType: 'vote' }), '');

  const village = renderEndgameFactionTacticsInstruction({ strategyProfile: null, team: 'village' });
  assert.match(village, /村人陣営.*人狼CO.*PP・RPPを崩す/u);
});

test('briefingは応答不要modeへ明示対応し未知taskTypeと未知modeは即時拒否する', () => {
  assert.equal(getResponseModeForTask('briefing'), 'none');
  assert.deepEqual(getResponseTopLevelKeys('none'), []);

  assert.throws(() => getResponseModeForTask('night-action'), /未定義のAIタスク種別/u);
  assert.throws(() => getResponseModeForTask(''), /未定義のAIタスク種別/u);
  assert.throws(() => getResponseTopLevelKeys('action'), /未定義のAI応答モード/u);
});

test('共通判断は反応・訂正・発言量・投票時期を判断材料として残し単独評価へ寄せない', () => {
  const prompt = renderRuntimeReasoningPolicy();
  assert.match(prompt, /反応・印象・訂正・謝罪・発言量・立場や投票先の時期も判断材料/u);
  assert.match(prompt, /前後の公開情報や他候補との差と合わせて/u);
  assert.match(prompt, /未CO・未公開という事実だけから役職や能力の有無を確定しない/u);
  assert.match(prompt, /以前の根拠が弱まる・失効する場合/u);
  assert.doesNotMatch(prompt, /指摘後でも作れる後付け/u);
});

test('2CO指示は処刑損益を残し灰の評価軸を全員へ指定しない', () => {
  const prompt = renderTwoSeerExecutionInstruction({ seerNames: ['A', 'B'] });
  assert.match(prompt, /真占い師を失う損失/u);
  assert.match(prompt, /偽が狂人なら生存人狼数が減らない可能性/u);
  assert.match(prompt, /追加結果が得られる一方で偽結果も増える可能性/u);
  assert.doesNotMatch(prompt, /灰の相互評価/u);
  assert.doesNotMatch(prompt, /結果への反応・投票理由/u);
});

test('heartVoiceのAI生成は通常昼発言系とpriority-answerだけに限定する', () => {
  for (const mode of ['speech', 'speech-designated', 'speech-free', 'priority-answer']) {
    assert.equal(getResponseTopLevelKeys(mode).includes('heartVoice'), true, mode);
    assert.equal(Object.hasOwn(buildResponseContractExample({ mode, roleId: 'villager', claimRolePolicy, partnerDispositionPolicy }), 'heartVoice'), true, mode);
    assert.match(renderActiveResponseContract({ mode, roleId: 'villager' }), /heartVoiceは原則出力/u);
  }
  for (const mode of ['testament', 'graveyard']) {
    assert.equal(getResponseTopLevelKeys(mode).includes('heartVoice'), false, mode);
    assert.equal(Object.hasOwn(buildResponseContractExample({ mode, roleId: 'villager', claimRolePolicy, partnerDispositionPolicy }), 'heartVoice'), false, mode);
    assert.doesNotMatch(renderActiveResponseContract({ mode, roleId: 'villager' }), /heartVoice/u);
  }

  const speechReminder = renderFinalResponseReminder({
    taskType: 'speech',
    roleId: 'villager',
    publicSpeechPolicy: { targetChars: 120, claimOverride: null },
    maxPublicSpeechLength: 450,
    maxHeartVoiceLength: 120,
  });
  assert.match(speechReminder, /心の声: 1～2文・120文字以内/u);

  const testamentReminder = renderFinalResponseReminder({
    taskType: 'testament',
    roleId: 'villager',
    publicSpeechPolicy: { targetChars: 120, claimOverride: null },
    maxPublicSpeechLength: 450,
    maxHeartVoiceLength: 120,
  });
  assert.match(testamentReminder, /遺言: 450文字以内/u);
  assert.doesNotMatch(testamentReminder, /心の声/u);

  const graveyardReminder = renderFinalResponseReminder({
    taskType: 'graveyard-conversation',
    roleId: 'villager',
    maxGraveyardMessageLength: 450,
    maxHeartVoiceLength: 120,
  });
  assert.match(graveyardReminder, /墓場会話: 450文字以内/u);
  assert.doesNotMatch(graveyardReminder, /心の声/u);
});

test('JSON例へ現在ゲームの公開シーケンス番号を流用しない', () => {
  const exampleReferences = {
    answerEventSequences: [77],
    correctedSpeechSequences: [88],
    decisionEvidenceEventSequences: [99],
    abilityEvidenceEventSequences: [66],
    abilityResultDay: 2,
  };
  const example = buildActiveResponseContractExample({
    mode: 'speech',
    roleId: 'seer',
    claimRolePolicy: { coRoleIds: ['seer'], abilityClaimRoleIds: ['seer'] },
    exampleReferences,
  });
  assert.deepEqual(example.decisionPatch.correctedSpeechSequences, []);
  assert.deepEqual(example.decisionPatch.evidenceEventSequences, []);
  assert.equal(Object.hasOwn(example, 'speechInteraction'), false);

  const prompt = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'seer',
    claimRolePolicy: { coRoleIds: ['seer'], abilityClaimRoleIds: ['seer'] },
    exampleReferences,
  });
  for (const sequence of ['66', '77', '88', '99']) assert.equal(prompt.includes(sequence), false, `実シーケンス${sequence}をJSON例へ流用しない`);
  assert.match(prompt, /answerEventSequencesへcurrent-taskで示された質問元の公開発言番号/u);
  assert.match(prompt, /selectionBasis=public-evidence/u);
});

test('voteの前回判断表示はintendedVoteとdecisionReasonを再提示せず比較材料だけを残す', () => {
  const context = {
    task: { type: 'vote' },
    player: {
      decisionState: {
        updatedAt: '2026-08-12T00:00:00Z',
        suspicionCandidateIds: ['p2'],
        executionCandidateIds: ['p2'],
        intendedVoteId: 'p2',
        assessmentLevel: 'moderate',
        keyPublicEvidenceEventIds: [],
        leaveAliveBenefit: '追加情報',
        misexecutionCost: '誤処刑損失',
        selectionDifference: '候補差',
        uncertainty: '未確定',
        nextDiscriminatingInformation: '次の情報',
        decisionReason: '前回の投票理由',
      },
      decisionInvalidation: null,
    },
    board: {
      alive: [{ id: 'p2', name: '候補A' }],
      dead: [],
      publicTimeline: {},
    },
  };
  const voteState = latestDecisionState(context, null, { taskType: 'vote' });
  assert.equal(Object.hasOwn(voteState, 'intendedVote'), false);
  assert.equal(Object.hasOwn(voteState, 'decisionReason'), false);
  assert.equal(voteState.selectionDifference, '候補差');

  const speechState = latestDecisionState(context, null, { taskType: 'speech' });
  assert.equal(speechState.intendedVote, '候補A');
  assert.equal(speechState.decisionReason, '前回の投票理由');
});

test('投票はAI向けに理由・比較を主JSON例へ掲載しつつ回答検証必須はactionAnswerだけに保つ', () => {
  const prompt = renderActiveResponseContract({ mode: 'vote', roleId: 'wolf' });
  const finalConfirmation = renderActiveResponseFinalConfirmation({ mode: 'vote', roleId: 'wolf' });
  const example = buildActiveResponseContractExample({ mode: 'vote', roleId: 'wolf' });
  assert.deepEqual(getRequiredResponseTopLevelKeys('vote'), ['actionAnswer']);
  assert.doesNotMatch(prompt, /今回の必須出力/u);
  assert.match(finalConfirmation, /今回の必須出力: actionAnswer。/u);
  assert.doesNotMatch(finalConfirmation, /これだけで投票回答として成立/u);
  assert.deepEqual(Object.keys(example), [
    'actionAnswer', 'actionRationale', 'decisionPatch', 'factionStrategyUpdate', 'memoAdd',
  ]);
  assert.deepEqual(parseLastJson(finalConfirmation), example);
  assert.match(prompt, /対象: actionRationale \/ decisionPatch \/ factionStrategyUpdate \/ memoAdd。生成できる限り出力します/u);
  assert.match(prompt, /投票先はactionAnswer、投票理由はactionRationaleだけに記録します/u);
  assert.match(prompt, /decisionPatchはmode\/changesで包まず/u);
  buildVoteDecisionPatchGuidanceRows(getDecisionPatchKeys('vote')).forEach((row) => {
    assert.equal(prompt.includes(row), true, `深度1/2は共通vote decisionPatchガイダンスを使用する: ${row}`);
  });
  assert.match(prompt, /actionRationale.*具体的理由を1～2文/u);
  assert.doesNotMatch(finalConfirmation, /actionRationaleとdecisionPatchは原則出力/u);
  assert.match(finalConfirmation, /actionAnswerへ投票先の正式表示名を一つだけ必ず指定/u);
  assert.deepEqual(Object.keys(example.decisionPatch), [
    'suspicionCandidates', 'executionCandidates', 'assessmentLevel', 'leaveAliveBenefit',
    'misexecutionCost', 'selectionDifference', 'uncertainty', 'nextDiscriminatingInformation',
    'correctedSpeechSequences', 'evidenceEventSequences',
  ]);
});

test('vote structured schemaも単独狼のpartnerDispositionをchanges候補へ含めない', () => {
  const state = {
    players: [
      { id: 'wolf-1', name: '狼A', roleId: 'wolf', alive: true },
      { id: 'village-1', name: '村A', roleId: 'villager', alive: true },
    ],
    playerKnowledge: { 'wolf-1': { knownWolfIds: ['wolf-1'] } },
    game: { rules: { vote: { abstentionAllowed: false } } },
  };
  const contract = buildStructuredOutputContract(state, {
    taskType: 'vote',
    playerId: 'wolf-1',
    validTargetIds: ['village-1'],
  });
  const changes = contract.schema.properties.factionStrategyUpdate.properties.changes.properties;
  assert.equal(Object.hasOwn(changes, 'partnerDisposition'), false);
  assert.equal(Object.hasOwn(changes, 'dayWinPath'), true);
});

test('行動理由の長さ指針は前方契約へ置き最終確認の既存文面を変更しない', () => {
  const night = renderActiveResponseContract({ mode: 'night-action', roleId: 'seer' });
  assert.match(night, /actionRationale.*1～2文/u);
  const nightFinal = renderActiveResponseFinalConfirmation({ mode: 'night-action', roleId: 'seer' });
  assert.match(nightFinal, /他候補よりその対象を選んだ具体的理由を記録します/u);
  assert.doesNotMatch(nightFinal, /1～2文/u);

  const freeze = renderActiveResponseContract({ mode: 'freeze-action', roleId: 'snow-woman' });
  assert.match(freeze, /actionRationale.*1～3文/u);
  const freezeFinal = renderActiveResponseFinalConfirmation({ mode: 'freeze-action', roleId: 'snow-woman' });
  assert.match(freezeFinal, /人狼推定、襲撃予想、凍結対象の関係を説明します/u);
  assert.doesNotMatch(freezeFinal, /1～3文/u);
});

test('条件不成立のCO・能力公開だけを省き、適用時は説明とJSON例を完全維持する', () => {
  const unavailable = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'villager',
    claimRolePolicy: { coRoleIds: [], abilityClaimRoleIds: [] },
  });
  assert.doesNotMatch(unavailable, /CO条件付き形式/u);
  assert.doesNotMatch(unavailable, /能力結果条件付き形式/u);
  assert.match(unavailable, /speechInteraction直下で使用できるキー/u);

  const available = renderActiveResponseContract({
    mode: 'speech',
    roleId: 'seer',
    claimRolePolicy: { coRoleIds: ['seer'], abilityClaimRoleIds: ['seer'] },
  });
  assert.match(available, /COを実際に公開する場合だけcoOperation/u);
  assert.match(available, /roleIdは本人の真役職ではなく今回publicSpeechで名乗る役職/u);
  assert.match(available, /CO条件付き形式: \{"coOperation":\{"action":"declare","roleId":"許可された役職ID"\}\}/u);
  assert.match(available, /能力結果を実際に公開する場合だけabilityClaims/u);
  assert.match(available, /"selectionBasis":"no-public-information"/u);
  assert.match(available, /"evidenceEventSequences":\[\]/u);
  assert.match(available, /"selectionReasonAtTime":"能力対象を選んだ時点での具体的な理由"/u);
});

test('通常発言JSON例は軽量化後も判断項目を省略せずdecisionPatchをflat形式で案内する', () => {
  const prompt = renderActiveResponseContract({ mode: 'speech', roleId: 'villager' });
  const example = buildActiveResponseContractExample({ mode: 'speech', roleId: 'villager' });
  assert.match(prompt, /decisionPatchはmode\/changesで包まず許可キーを直下/u);
  assert.deepEqual(Object.keys(example.decisionPatch), [
    'suspicionCandidates', 'executionCandidates', 'intendedVote', 'assessmentLevel',
    'leaveAliveBenefit', 'misexecutionCost', 'selectionDifference', 'uncertainty',
    'nextDiscriminatingInformation', 'reason', 'correctedSpeechSequences', 'evidenceEventSequences',
  ]);
  assert.equal(typeof example.heartVoice, 'string');
  assert.equal(typeof example.memoAdd, 'string');
});
