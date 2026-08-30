/**
 * 責務: 現在フェーズだけで完結するAI向けの必須出力・原則出力・条件付き出力とJSON例を、回答検証上の必須性とは独立して描画する。
 * 変更ルール:
 * - 回答検証契約の許可・必須キーを独自定義せずresponseContract.jsから取得するが、プロンプト掲載集合をrequiredTopLevelKeysと一致させない。
 * - voteのdecisionPatch具体化ガイダンスはvoteResponseGuidancePolicy.jsを正本とし、多段候補工程側と同じ文言・優先項目を使用する。
 * - vote以外の処刑比較ではexecutionCandidatesの先頭を第一処刑候補として、比較項目の対象を単一候補へ固定する。
 * - requiredTopLevelKeysは欠落時に進行を止める境界であり、検証上任意でもAIに生成してほしいrationale / decisionPatch / heartVoice / memoAdd等は原則出力の説明と主JSON例へ掲載する。
 * - 『プロンプトに掲載する』ことを理由に回答検証必須へ昇格してはならず、『検証上任意』を理由にプロンプトやJSON例から削除してはならない。
 * - decisionPatchの子項目はJSON例への掲載有無だけで思考観点を誘導し、掲載された子項目もすべて回答任意とする。推理モード・人物傾向・処刑判断局面による掲載選択はdecisionPromptFieldPolicy.jsを正本とする。
 * - 処刑比較項目の表示タイミングはpromptSituation / promptSectionPolicyで既に解決されたフラグを受け取り、本モジュールで残り発言回数やvote条件を再判定しない。
 * - 許可キーは本人役職へ適合済みの集合だけを表示する。
 * - 通常発言はpublicSpeechをAI向け必須出力とし、各モードの説明と今回のJSON例は最終確認用として一箇所から生成する。
 * - assessmentLevelの列挙値はdecisionState.js、partnerDispositionの列挙値はwolfPartnerDispositionPolicy.js由来の動的ポリシーを使用する。
 * - CO・能力結果・質問回答は実際に行う場合だけ条件付き形式を示し、空配列だけの項目を主形式へ掲載しない。能力結果公開時のpublicSpeechとabilityClaimsの一致規則はtaskInstructionPolicy.jsを正本とし、本モジュールではabilityClaimsの構造と状態更新上の役割だけを説明する。
 * - 外部JSONキーと内部保存キーを混在させず、speechInteractionは外部契約のquestionTargets / answerToRefsだけを明示する。
 * - 投票はactionAnswerをAI向け必須出力、rationale / decisionPatchを原則出力として主JSON例へ必ず掲載するが、後二者の欠落をエラーにしない。
 * - 夜行動理由、襲撃評価、雪女推定、初夜共有戦略、失効判断などの動的なAI向け必須性も本モジュールだけで決め、responseContract.jsの回答検証必須性へ逆流させない。
 * - heartVoiceは通常昼発言系とpriority-answerだけで原則出力とし、遺言・墓場会話へ生成指示を追加しない。墓場会話ではmemoAddを機械許可のまま保持してもプロンプト掲載・JSON例から外し、秘密共有・答え合わせ・感想へ誘導する。
 */

import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';
import { buildVoteDecisionPatchGuidanceRows } from '../policies/voteResponseGuidancePolicy.js';
import { resolveDecisionPromptFieldKeys } from '../policies/decisionPromptFieldPolicy.js';
import { getFactionStrategyFields, isFactionStrategyRole } from '../../domain/game/factionStrategyState.js';
import { getPublicAbilityClaimDefinition } from '../../domain/policies/publicAbilityClaimPolicy.js';
import {
  buildAbilityClaimsConditionalExample,
  buildDeceptionAbilityClaimsConditionalExample,
  buildCoOperationConditionalExample,
  buildDecisionPatchExample,
  buildResponseContractExample,
  buildSpeechInteractionConditionalExamples,
  getCoOperationRoleIds,
  getDecisionChangeKeys,
  getDecisionPatchKeys,
  getFactionStrategyResponseFields,
  getRequiredResponseTopLevelKeys,
  getRoleCompatibleResponseTopLevelKeys,
  normalizeResponseExampleReferences,
} from './responseContract.js';


const SPEECH_MODES = Object.freeze(new Set(['speech', 'speech-designated', 'speech-free']));

function isSpeechMode(mode) { return SPEECH_MODES.has(mode); }

const CONDITIONAL_OPTIONAL_KEYS = Object.freeze(new Set([
  'speechInteraction', 'coOperation', 'abilityClaims',
]));

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function selectExampleKeys(example, keys) {
  const selected = new Set(keys);
  return Object.fromEntries(Object.entries(example).filter(([key]) => selected.has(key)));
}

function activeDecisionPromptFieldKeys({
  mode,
  reasoningModeId = null,
  reasoningProfile = null,
  isExecutionDecisionWindow = false,
  isFinalDiscussionDecisionWindow = false,
  exampleReferences = null,
} = {}) {
  const allowed = new Set(getDecisionPatchKeys(mode));
  return resolveDecisionPromptFieldKeys({
    reasoningModeId,
    reasoningProfile,
    isExecutionDecisionWindow,
    isFinalDiscussionDecisionWindow,
    includeCorrectionReference: Boolean(
      normalizeResponseExampleReferences(exampleReferences).correctedSpeechRefs.length,
    ),
  }).filter((key) => allowed.has(key));
}

function dynamicRequiredKeys({ mode, roleId, decisionPatchRequired, factionStrategyPolicy, wolfConversationPurpose }) {
  const keys = [];
  if (decisionPatchRequired && [...SPEECH_MODES, 'priority-answer', 'mason'].includes(mode)) keys.push('decisionPatch');
  if (isFactionStrategyRole(roleId)
    && factionStrategyPolicy?.required
    && [...SPEECH_MODES, 'priority-answer'].includes(mode)) keys.push('factionStrategy');
  if (mode === 'wolf' && ['opening-strategy', 'opening-strategy-and-attack'].includes(wolfConversationPurpose)) {
    keys.push('sharedStrategy');
  }
  if (mode === 'attack-action') keys.push('attackAssessment', 'rationale');
  if (mode === 'freeze-action') keys.push('estimate', 'rationale');
  if (mode === 'night-action') keys.push('rationale');
  return unique(keys);
}

function promptRequiredKeysForPhase(options) {
  const allowedKeys = new Set(getRoleCompatibleResponseTopLevelKeys(options.mode, options.roleId));
  return unique([
    ...getRequiredResponseTopLevelKeys(options.mode),
    ...dynamicRequiredKeys(options),
  ]).filter((key) => allowedKeys.has(key));
}

function promptVisibleTopLevelKeys(mode, roleId) {
  return getRoleCompatibleResponseTopLevelKeys(mode, roleId)
    .filter((key) => !(mode === 'graveyard' && key === 'memoAdd'));
}

function availableOptionalKeys({ mode, roleId, claimRolePolicy, requiredKeys }) {
  const required = new Set(requiredKeys);
  return promptVisibleTopLevelKeys(mode, roleId)
    .filter((key) => !required.has(key))
    .filter((key) => !(isSpeechMode(mode) && key === 'publicSpeech'))
    .filter((key) => key !== 'coOperation' || getCoOperationRoleIds(claimRolePolicy).length > 0)
    .filter((key) => key !== 'abilityClaims' || Boolean(claimRolePolicy?.abilityClaimRoleIds?.length));
}

function splitOptionalKeys(optionalKeys) {
  return {
    recommendedKeys: optionalKeys.filter((key) => !CONDITIONAL_OPTIONAL_KEYS.has(key)),
    conditionalKeys: optionalKeys.filter((key) => CONDITIONAL_OPTIONAL_KEYS.has(key)),
  };
}

function coAndAbilityRules(claimRolePolicy, references) {
  const rows = [];
  const coRoleIds = getCoOperationRoleIds(claimRolePolicy);
  if (coRoleIds.length) {
    rows.push(`COを実際に公開する場合だけcoOperationを追加します。actionはdeclare / change / withdraw。declare・changeのroleIdは本人の真役職ではなく今回publicSpeechで名乗る役職で、${coRoleIds.join(' / ')} から選びます。withdrawではroleIdを省略します。`);
    rows.push(`CO条件付き形式: ${JSON.stringify({ coOperation: buildCoOperationConditionalExample(claimRolePolicy) })}`);
  }
  if (claimRolePolicy?.abilityClaimRoleIds?.length) {
    const normalizedReferences = normalizeResponseExampleReferences(references);
    const truthfulExample = buildAbilityClaimsConditionalExample(claimRolePolicy, normalizedReferences);
    const deceptionExample = buildDeceptionAbilityClaimsConditionalExample(claimRolePolicy, normalizedReferences);
    const hasTruthfulSource = Boolean(normalizedReferences.truthfulAbilitySourceRefs.length);
    rows.push('能力結果を実際に公開する場合だけabilityClaimsを追加します。真実として公開する場合はintent=truthfulとし、private-informationのabilityResultsまたはown-historyの該当能力行動P#をsourceRefで参照します。truthfulではroleId・actionDay・actionPhase・availableDay・availablePhase・target・resultをabilityClaimsへ出力せず、システムが正式記録から確定します。本人選択能力ではselectionBasis、evidenceRefs、selectionReasonAtTimeだけ任意で追加できます。abilityClaimsは公開する能力結果を構造化して記録します。');
    if (hasTruthfulSource && truthfulExample) rows.push(`truthful形式: ${JSON.stringify({ abilityClaims: truthfulExample })}`);
    const resultValuesByRole = claimRolePolicy.abilityClaimRoleIds
      .map((roleId) => `${roleId}=${(getPublicAbilityClaimDefinition(roleId)?.results ?? []).join(' / ')}`)
      .join('、');
    rows.push(`事実と異なる内容を意図的に主張する場合だけintent=deceptionを使用し、roleId・actionDay・actionPhase・availableDay・availablePhase・target・resultを明示します。deceptionのresult列挙値: ${resultValuesByRole}。本人選択能力は選択時点のselectionBasis、evidenceRefs、selectionReasonAtTimeも記録します。`);
    if (deceptionExample) rows.push(`deception形式: ${JSON.stringify({ abilityClaims: deceptionExample })}`);
  }
  return rows;
}

function speechInteractionRules(references) {
  const normalized = normalizeResponseExampleReferences(references);
  const examples = buildSpeechInteractionConditionalExamples();
  const rows = [
    'speechInteraction直下で使用できるキーはquestionTargets / answerToRefsだけです。内部保存名のquestionTargetNamesや、それ以外のキーは出力しません。',
    `publicSpeechで直接質問する場合は必ず追加: ${JSON.stringify(examples.questionOnly)}`,
  ];
  if (normalized.answerToRefs.length) {
    rows.push('今回未回答の本人宛て質問へ直接答える場合はanswerToRefsへcurrent-taskで示された質問元の公開発言番号を指定します。質問も同時に行う場合はquestionTargetsと同じspeechInteractionへ併記します。');
  }
  rows.push('質問も回答も行わない場合はspeechInteraction自体を省略してください。空配列だけのspeechInteractionは出力しません。');
  return rows;
}

function partnerDispositionRules(roleId, partnerDispositionPolicy) {
  if (!getFactionStrategyFields(roleId).includes('partnerDisposition')) return [];
  const allowedValues = [...(partnerDispositionPolicy?.allowedValues ?? [])];
  if (allowedValues.length === 1 && allowedValues[0] === 'not-applicable') return [];
  if (!allowedValues.length) return [];
  return [
    `factionStrategy.changes.partnerDispositionの有効値は ${allowedValues.join(' / ')} です。independent=仲間を特別扱いせず公開根拠で評価、support=公開上で仲間を支援、separate=公開上で仲間と距離を取る方針です。`,
  ];
}

function factionStrategyRules(roleId, updatePolicy, hasPreviousFactionStrategy, partnerDispositionPolicy, requiredKeys) {
  if (!isFactionStrategyRole(roleId) || !requiredKeys.includes('factionStrategy')) return [];
  const fields = getFactionStrategyResponseFields(roleId, partnerDispositionPolicy).join(' / ');
  const rows = [
    `今回は陣営戦略更新が必須です。factionStrategy.changesで使用できるキー: ${fields}。`,
    ...partnerDispositionRules(roleId, partnerDispositionPolicy),
  ];
  if (!hasPreviousFactionStrategy || updatePolicy?.keepAllowed === false) {
    rows.push('前回戦略がない、または維持できないためmodeはpatchを使用してください。');
  } else {
    rows.push('変更がなければmode=keep、変更があればmode=patchを使用してください。');
  }
  return rows;
}

function recommendedFieldRules(recommendedKeys, roleId, partnerDispositionPolicy) {
  const keys = new Set(recommendedKeys);
  const rows = [];
  if (keys.has('memoAdd')) {
    rows.push('memoAddは、今回得た仮説・警戒点・予定など次ターン以降も残す価値がある新規内容を記録します。生死・処刑・夜明け・自分の正式行動・公開COなどシステム管理済みの確定事実だけを再記録せず、新規内容がない場合は省略します。');
  }
  if (keys.has('factionStrategy') && isFactionStrategyRole(roleId)) {
    rows.push(`factionStrategyは、現在の局面から本人限定の陣営戦略を変更・具体化できる場合は原則として追加します。mode=patchとし、changesには ${getFactionStrategyResponseFields(roleId, partnerDispositionPolicy).join(' / ')} のうち今回更新する項目だけを入れます。変更不要または根拠不足の場合だけ省略できます。`);
    rows.push(...partnerDispositionRules(roleId, partnerDispositionPolicy));
  }
  if (keys.has('sharedStrategy')) {
    rows.push('sharedStrategyは、現在の局面から人狼共有戦略を変更・具体化できる場合は原則として追加します。mode=patchとし、changesへ今回の変更内容だけを入れます。変更不要または根拠不足の場合だけ省略できます。');
  }
  if (keys.has('rationale')) {
    rows.push('rationaleは結果判明前の時点で、その行動を選んだ具体的理由を1～2文で原則として記録します。');
  }
  return rows;
}

function decisionPatchRules(mode, decisionPatchRequired, decisionPromptKeys = []) {
  if (![...SPEECH_MODES, 'priority-answer', 'mason', 'vote'].includes(mode)) return [];
  const shownKeys = [...new Set((decisionPromptKeys ?? []).filter((key) => getDecisionPatchKeys(mode).includes(key)))];
  const assessmentLevelRule = shownKeys.includes('assessmentLevel')
    ? `decisionPatch.assessmentLevelは ${DECISION_ASSESSMENT_LEVELS.join(' / ')} のいずれかです。`
    : '';
  if (mode === 'vote') {
    return buildVoteDecisionPatchGuidanceRows(shownKeys);
  }
  const rows = [
    decisionPatchRequired
      ? `decisionPatchはmode/changesで包まず直下形式で出力してください。今回JSON例に表示する子項目: ${shownKeys.join(' / ') || 'なし'}。各子項目は回答任意で、使わなくてもエラーにはなりません。`
      : `本人の現在判断を変更・補足・具体化できる場合、decisionPatchはmode/changesで包まず直下形式で追加できます。今回JSON例に表示する子項目: ${shownKeys.join(' / ') || 'なし'}。各子項目は回答任意で、使わなくてもエラーにはなりません。`,
    assessmentLevelRule,
  ].filter(Boolean);
  if (decisionPatchRequired) {
    rows.push('前回判断が現在の候補構造では利用できないため、今回はdecisionPatch自体を出力してください。ただしJSON例内の個々の子項目は必要なものだけ使用し、未回答の子項目を埋めるために内容を作りません。');
  }
  if (shownKeys.some((key) => ['leaveAliveBenefit', 'misexecutionCost', 'selectionDifference'].includes(key))) {
    rows.push('処刑比較ではexecutionCandidatesの先頭を第一処刑候補とし、leaveAliveBenefit / misexecutionCost / selectionDifferenceはその第一候補だけを基準に記録します。intendedVoteを設定する場合は同じ対象を第一処刑候補にしてください。');
  }
  if (shownKeys.includes('correctedSpeechRefs') || shownKeys.includes('evidenceRefs')) {
    rows.push('decisionPatch.correctedSpeechRefsは自分の過去public-speechだけ、evidenceRefsは本人に見えているpublic-speech / vote-finalized / execution / dawnの#公開ログ番号だけを正整数で指定します。');
  }
  return rows;
}

function requiredModeRules({
  mode,
  roleId,
  hasPreviousDecision,
  hasPreviousFactionStrategy,
  factionStrategyPolicy,
  partnerDispositionPolicy,
  freezeEstimateLimit,
  wolfConversationPurpose,
  attackAlternativeAvailable,
  decisionPatchRequired,
  decisionPromptKeys = [],
  requiredKeys = [],
}) {
  const rows = [];
  if (mode === 'discussion-opening-preference') rows.push('openingPreferenceはEARLY / NORMAL / WAIT_COのいずれかです。公開発言はまだ生成しません。');
  if (mode === 'speech-designated') rows.push('nextSpeakerPreferenceは、この巡でまだ通常発言していない相手を前倒ししたい場合だけ正式表示名で指定します。指名しない場合は空文字にします。発言権そのものは増減しません。');
  if (mode === 'speech-free') rows.push('discussionPreferenceは次巡の自分の通常発言希望です。EARLY / NORMAL / WAIT_CO / DONEから選びます。DONEは「材料がない」ではなく、今回までに現時点で公開すべき内容をすべて話し切った場合だけ選びます。');
  if (mode === 'priority-answer') rows.push('publicSpeechはcurrent-taskの質問へ直接答える完成本文です。新しい質問は追加しません。');
  if (mode === 'vote') rows.push('actionAnswerへ投票先の正式表示名を一つだけ必ず指定します。');
  if (mode === 'mason') rows.push('masonMessageは共有者相方だけに見せる秘密会話です。');
  if (mode === 'graveyard') rows.push('graveyardMessageは現在の墓場参加者だけに見せる自然な秘密会話です。死亡時点までの記憶と墓場で実際に共有された内容を使い、生前の秘密・答え合わせ・感想を会話として表現します。');
  if (mode === 'testament') rows.push('publicSpeechは処刑直前に一度だけ残す完成済みの公開遺言です。質問や回答を追加せず、この発言後に議論が再開する前提で書きません。');
  if (mode === 'wolf') {
    rows.push('wolfMessageは人狼仲間だけに見せる秘密会話です。');
    if (['opening-strategy', 'opening-strategy-and-attack'].includes(wolfConversationPurpose)) {
      rows.push('今回は初夜作戦のためsharedStrategyも必須です。mode=patchで、騙り・黒受け・仲間処刑圏・主張崩壊・昼会話の方針を記録してください。');
      if (wolfConversationPurpose === 'opening-strategy') rows.push('初夜襲撃なしのためsharedStrategy.changesへattackPlanを出力しません。');
      else rows.push('今回の共有戦略にはattackPlanも含めます。');
    }
  }
  if (mode === 'attack-action') {
    rows.push('attackAssessmentのhunterAliveChance、guardRisk、otherGuardRiskはlow / medium / highです。');
    rows.push(attackAlternativeAvailable
      ? '最有力の別候補をotherTargetとotherGuardRiskへ記録し、rationaleで候補差を説明します。'
      : '有効な別候補がないため、rationaleへその事実を含めます。');
  }
  if (mode === 'freeze-action') {
    rows.push(`estimate.wolfCandidateIdsとpredictedAttackTargetIdsはcurrent-taskのプレイヤーIDを${freezeEstimateLimit?.min ?? 1}～${freezeEstimateLimit?.max ?? 3}件ずつ使用します。重複と雪女本人は禁止です。`);
    rows.push('rationaleで人狼推定、襲撃予想、凍結対象の関係を説明します。');
  }
  if (mode === 'night-action') rows.push('rationaleには結果判明前の時点で、他候補よりその対象を選んだ具体的理由を記録します。');
  if (decisionPatchRequired && mode !== 'vote') rows.push(...decisionPatchRules(mode, decisionPatchRequired, decisionPromptKeys));
  rows.push(...factionStrategyRules(roleId, factionStrategyPolicy, hasPreviousFactionStrategy, partnerDispositionPolicy, requiredKeys));
  if (!hasPreviousDecision && decisionPatchRequired && [...SPEECH_MODES, 'priority-answer', 'mason', 'vote'].includes(mode)) {
    rows.push('利用できる前回判断がないため、過去判断の維持ではなく現在の公開情報から記録してください。');
  }
  return rows;
}

function recommendedModeRules({ mode, decisionPatchRequired, decisionPromptKeys = [], recommendedKeys = [] }) {
  const rows = [];
  if (isSpeechMode(mode)) {
    rows.push('heartVoiceは原則出力します。公開本文の言い換えではない、本人とGMだけが読む局面固有の本音・迷い・警戒・期待を記録してください。現在の入力から公開本文とは別の内容を適切に生成できない場合に限り省略でき、未入力でもエラーにはなりません。');
  }
  if (mode === 'priority-answer') {
    rows.push('heartVoiceは原則出力します。本人とGMだけが読む、質問への回答時点の本音・迷い・警戒を記録してください。現在の入力から適切に生成できない場合に限り省略でき、未入力でもエラーにはなりません。');
  }
  if (mode === 'vote') {
    rows.push(...decisionPatchRules(mode, false, decisionPromptKeys));
  } else if (!decisionPatchRequired) {
    rows.push(...decisionPatchRules(mode, false, decisionPromptKeys));
    if ([...SPEECH_MODES, 'priority-answer', 'mason'].includes(mode)) {
      rows.push('decisionPatchは、現在判断を変更・補足・具体化できる内容がある場合は原則として追加します。判断の変更点がない、または公開根拠が不足する場合だけ省略できます。');
    }
  }
  return rows;
}

function conditionalModeRules({ mode, claimRolePolicy, exampleReferences }) {
  const rows = [];
  if (isSpeechMode(mode)) {
    rows.push(...speechInteractionRules(exampleReferences));
    rows.push(...coAndAbilityRules(claimRolePolicy, exampleReferences));
  }
  if (mode === 'priority-answer' || mode === 'testament') rows.push(...coAndAbilityRules(claimRolePolicy, exampleReferences));
  return rows;
}

function fieldWritingGuidance(mode) {
  if (mode === 'attack-action') return ['rationaleは結果判明前の候補比較として、最有力の別候補との差を1～2文で簡潔に記録します。'];
  if (mode === 'freeze-action') return ['rationaleは結果判明前の人狼推定・襲撃予想・凍結対象の関係を1～3文で簡潔に記録します。'];
  if (mode === 'night-action') return ['rationaleは結果判明前の候補比較として、他候補よりその対象を選ぶ具体的理由を1～2文で簡潔に記録します。'];
  return [];
}

function prohibitionRules(mode, allowedKeys) {
  const rows = [
    `トップレベルキーは ${allowedKeys.join(' / ') || 'なし'} 以外を出力しません。`,
  ];
  if ([...SPEECH_MODES, 'priority-answer', 'testament', 'public-only'].includes(mode)) {
    rows.push('公開本文へ他者の未公開情報・秘密会話・内部メモを漏らしません。自分についての戦術的な役職・陣営主張は許可されたCOとして扱えます。');
  }
  if ([...SPEECH_MODES, 'priority-answer', 'testament'].includes(mode)) {
    rows.push('記録にない質問・回答・CO・能力結果を作りません。');
  }
  if (mode === 'graveyard') rows.push('死亡後の昼議論・投票・夜結果を観戦者視点で補完しません。新規死亡者が墓場で話していない情報は知りません。');
  return rows;
}

function renderRuleBlock(title, rows) {
  if (!rows.length) return '';
  return `### ${title}\n${rows.map((row) => `- ${row}`).join('\n')}`;
}

export function buildActiveResponseContractExample({
  mode,
  roleId,
  partnerDispositionPolicy = null,
  claimRolePolicy = null,
  freezeEstimateLimit = null,
  wolfConversationPurpose = null,
  attackAlternativeAvailable = true,
  exampleReferences = null,
  decisionPatchRequired = false,
  factionStrategyPolicy = null,
  reasoningModeId = null,
  reasoningProfile = null,
  isExecutionDecisionWindow = false,
  isFinalDiscussionDecisionWindow = false,
} = {}) {
  const completeExample = buildResponseContractExample({
    mode,
    roleId,
    partnerDispositionPolicy,
    claimRolePolicy,
    freezeEstimateLimit,
    wolfConversationPurpose,
    attackAlternativeAvailable,
    exampleReferences,
  });
  const options = {
    mode,
    roleId,
    claimRolePolicy,
    decisionPatchRequired,
    factionStrategyPolicy,
    partnerDispositionPolicy,
    wolfConversationPurpose,
  };
  const requiredKeys = promptRequiredKeysForPhase(options);
  const optionalKeys = availableOptionalKeys({ mode, roleId, claimRolePolicy, requiredKeys });
  const { recommendedKeys } = splitOptionalKeys(optionalKeys);
  const exampleKeys = isSpeechMode(mode)
    ? unique([...requiredKeys, 'publicSpeech', ...recommendedKeys])
    : unique([...requiredKeys, ...recommendedKeys]);
  const example = selectExampleKeys(completeExample, exampleKeys);
  if (example.decisionPatch) {
    const decisionPromptKeys = activeDecisionPromptFieldKeys({
      mode,
      reasoningModeId,
      reasoningProfile,
      isExecutionDecisionWindow,
      isFinalDiscussionDecisionWindow,
      exampleReferences,
    });
    example.decisionPatch = buildDecisionPatchExample(mode, exampleReferences, { keys: decisionPromptKeys });
  }
  return example;
}

export function renderActiveResponseContract({
  mode,
  roleId,
  hasPreviousDecision = false,
  hasPreviousFactionStrategy = false,
  partnerDispositionPolicy = null,
  factionStrategyPolicy = null,
  claimRolePolicy = null,
  freezeEstimateLimit = null,
  wolfConversationPurpose = null,
  attackAlternativeAvailable = true,
  exampleReferences = null,
  decisionPatchRequired = false,
  reasoningModeId = null,
  reasoningProfile = null,
  isExecutionDecisionWindow = false,
  isFinalDiscussionDecisionWindow = false,
} = {}) {
  const references = normalizeResponseExampleReferences(exampleReferences);
  const decisionPromptKeys = activeDecisionPromptFieldKeys({
    mode,
    reasoningModeId,
    reasoningProfile,
    isExecutionDecisionWindow,
    isFinalDiscussionDecisionWindow,
    exampleReferences: references,
  });
  const options = {
    mode,
    roleId,
    hasPreviousDecision,
    hasPreviousFactionStrategy,
    factionStrategyPolicy,
    partnerDispositionPolicy,
    claimRolePolicy,
    freezeEstimateLimit,
    wolfConversationPurpose,
    attackAlternativeAvailable,
    exampleReferences: references,
    decisionPatchRequired,
    decisionPromptKeys,
  };
  const requiredKeys = promptRequiredKeysForPhase(options);
  const optionalKeys = availableOptionalKeys({ mode, roleId, claimRolePolicy, requiredKeys });
  const { recommendedKeys, conditionalKeys } = splitOptionalKeys(optionalKeys);
  const recommendedRows = recommendedKeys.length
    ? [
      `対象: ${recommendedKeys.join(' / ')}。生成できる限り出力します。`,
      ...recommendedFieldRules(recommendedKeys, roleId, partnerDispositionPolicy),
      ...recommendedModeRules({ ...options, recommendedKeys }),
    ]
    : [];
  const conditionalRows = conditionalKeys.length
    ? [
      `対象: ${conditionalKeys.join(' / ')}。条件成立時だけ出力します。`,
      ...conditionalModeRules(options),
    ]
    : [];
  const blocks = [
    renderRuleBlock('禁止', prohibitionRules(mode, promptVisibleTopLevelKeys(mode, roleId))),
    renderRuleBlock('記載方針', fieldWritingGuidance(mode)),
    renderRuleBlock('原則出力', recommendedRows),
    renderRuleBlock('条件付き出力', conditionalRows),
  ];
  return blocks.filter(Boolean).join('\n\n');
}

export function renderActiveResponseFinalConfirmation({
  mode,
  roleId,
  hasPreviousDecision = false,
  hasPreviousFactionStrategy = false,
  partnerDispositionPolicy = null,
  factionStrategyPolicy = null,
  claimRolePolicy = null,
  freezeEstimateLimit = null,
  wolfConversationPurpose = null,
  attackAlternativeAvailable = true,
  exampleReferences = null,
  decisionPatchRequired = false,
  reasoningModeId = null,
  reasoningProfile = null,
  isExecutionDecisionWindow = false,
  isFinalDiscussionDecisionWindow = false,
} = {}) {
  const references = normalizeResponseExampleReferences(exampleReferences);
  const decisionPromptKeys = activeDecisionPromptFieldKeys({
    mode,
    reasoningModeId,
    reasoningProfile,
    isExecutionDecisionWindow,
    isFinalDiscussionDecisionWindow,
    exampleReferences: references,
  });
  const options = {
    mode,
    roleId,
    hasPreviousDecision,
    hasPreviousFactionStrategy,
    factionStrategyPolicy,
    partnerDispositionPolicy,
    claimRolePolicy,
    freezeEstimateLimit,
    wolfConversationPurpose,
    attackAlternativeAvailable,
    exampleReferences: references,
    decisionPatchRequired,
    decisionPromptKeys,
  };
  const requiredKeys = promptRequiredKeysForPhase(options);
  const example = buildActiveResponseContractExample({
    mode,
    roleId,
    partnerDispositionPolicy,
    claimRolePolicy,
    freezeEstimateLimit,
    wolfConversationPurpose,
    attackAlternativeAvailable,
    exampleReferences: references,
    decisionPatchRequired,
    factionStrategyPolicy,
    reasoningModeId,
    reasoningProfile,
    isExecutionDecisionWindow,
    isFinalDiscussionDecisionWindow,
  });
  const requiredRows = [
    `今回の必須出力: ${requiredKeys.join(' / ') || 'なし'}。`,
    ...requiredModeRules({ ...options, requiredKeys }),
  ];
  return [
    requiredRows.join('\n'),
    `項目: ${Object.keys(example).join(' / ') || 'なし'}。`,
    '### 今回のJSON例',
    JSON.stringify(example),
  ].filter(Boolean).join('\n\n');
}
