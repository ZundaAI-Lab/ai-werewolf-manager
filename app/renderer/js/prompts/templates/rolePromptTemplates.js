/**
 * 責務: 本人の真の役職・本人限定確定属性と現在タスクに対応する判断原則を文章化する。
 * 変更ルール: 共通ルールを重複定義せず、本人が知る属性だけで分岐する。公開本文への他者未公開情報の漏洩禁止は共通出力契約を正本とし、役職固有指示ではその役職に固有の公開根拠制約だけを示す。特殊役職は実装された効果・公開タイミング・不成立条件を一般的な人狼知識へ委ねず短く明示する。投票ではCO・公開発言・能力結果提出の手順を載せず、投票判断へ影響する本人限定情報と役職効果だけを示す。特殊陣営と複数死亡役職の勝敗判断は削らない。特定行動を必須化せず、状態更新や可視性判定を行わない。本人限定の動的役職データは[game-data:...]へ隔離し、自由文字列を判断指示へ直接展開しない。
 */

import { getRoleDefinition } from '../../domain/roles/roleAttributes.js';
import { renderPromptDataBlock } from '../serialization/promptDataSerializer.js';

const DAY_ROLE_GUIDANCE = Object.freeze({
  villager: `## あなたの役職固有の判断材料

特殊能力による非公開結果はありません。公開発言、CO、能力結果主張、投票、処刑、襲撃の整合性から判断してください。`,

  mason: `## あなたの役職固有の判断材料

共有者仲間の正体は本人にとって確定情報です。相方を明かすかは盤面から判断し、未公開の相方と共有者会話を漏らさないでください。共有者COを行う場合はcoOperationを明示し、公開発言本文からCOを推定させません。`,

  seer: `## あなたの役職固有の判断材料

正式通知された占い結果は本人の確定情報です。公開時は襲撃危険と対抗比較を考え、COと能力結果主張を明示構造で提出します。公開発言本文からは抽出させません。`,

  medium: `## あなたの役職固有の判断材料

正式通知された霊能結果は本人の確定情報です。処刑者の結果を投票、CO、能力結果主張と組み合わせてください。公開する場合はCOと結果主張をそれぞれ明示構造で提出します。`,

  guard: `## あなたの役職固有の判断材料

護衛対象が襲撃された場合、その襲撃死を防ぎます。護衛履歴を公開する場合は、同じ応答で狩人COと構造化履歴を一致させます。`,

  namahage: `## あなたの役職固有の判断材料

訪問結果は通知されません。「悪い子」だけに恐怖を与え、恐怖によって役職行動全体が阻害された時に恐怖は解除されます。人狼が複数いる場合は一部だけを恐怖にしても襲撃が行われ、その恐怖は維持されます。前夜と同じ相手は選べません。`,

  fox: `## あなたの役職固有の判断材料

妖狐は人狼の襲撃では死亡せず、占われると死亡します。通常陣営の勝利条件成立時に生存していれば勝利するため、占い・処刑危険と両陣営の人数推移を常に比較し、真の役職と耐性を公開発言へ漏らさないでください。`,

  cat: `## あなたの役職固有の判断材料

処刑時は自分以外の生存者一人を、襲撃死時は生存人狼一人をランダムに道連れにし、対象は選べません。道連れで死亡した猫又の能力は連鎖しません。自分の処刑・襲撃価値と陣営への影響を比較してください。`,


  wolf: `## あなたの役職固有の判断材料

人狼仲間は本人の確定情報です。潜伏中の公開推理・質問・疑いは、仲間を知らない村人にも成立する公開根拠で組み立てます。村側の最有力結論へ自動的に合流せず、成立する公開世界の中から人狼数・必要票・翌日の勝ち筋を最も残すものを選べます。仲間救出・距離取り・仲間投票を固定戦術にしません。正体公開や陣営票合わせを選んだ場合は、その戦術に必要な自分のCO・投票指示を行えます。`,

  whiteWolf: `## あなたの役職固有の判断材料

基本は村人に徹し、占いで「人狼ではない」と判定される強みを長期的な信用へつなげてください。無理な騙りや露骨な仲間擁護を避け、公開根拠があれば仲間を疑い・投票する選択肢もあります。霊能では人狼と判定され、占いの非人狼結果も村人陣営確定ではありません。`,

  zashikiWarashi: `## あなたの役職固有の判断材料

家主の名前・正確な役職・所属陣営は本人だけの秘密情報です。家主側はあなたとの関係を知りません。家主が死亡すると自分も後追いしますが、自分や家主の生存自体は独立した勝利条件ではありません。所属陣営の勝利を優先し、未公開の家主情報を公開情報として扱わないでください。`,
});

const VOTE_ROLE_GUIDANCE = Object.freeze({
  villager: `## あなたの役職固有の投票材料

特殊能力による本人限定結果はありません。公開発言、CO、能力結果主張、過去投票、処刑、襲撃の整合性と、今日の処刑価値から投票先を選んでください。`,

  mason: `## あなたの役職固有の投票材料

共有者仲間の正体は本人にとって確定情報です。未公開の相方と共有者会話を漏らさず、相方を除く候補の公開根拠と今日の処刑価値を比較してください。`,

  seer: `## あなたの役職固有の投票材料

正式通知された占い結果は本人の確定情報です。本人限定結果と公開中のCO・能力結果主張を区別し、処刑で失われる情報と翌日に残る占い機会も含めて比較してください。`,

  medium: `## あなたの役職固有の投票材料

正式通知された霊能結果は本人の確定情報です。処刑者の結果と公開中のCO・能力結果主張・過去投票を結び付けて判断してください。`,

  guard: `## あなたの役職固有の投票材料

正式に記録された自分の護衛対象と、死亡者なしなどの公開結果を区別して判断してください。自分や候補を処刑した場合に失われる今夜以降の護衛可能性と、今日の処刑価値を比較してください。`,

  namahage: `## あなたの役職固有の投票材料

訪問結果は通知されません。過去の訪問先を人狼または恐怖状態と確定せず、公開情報と投票価値から判断してください。現在の有効投票者と候補は正式なゲーム状態を優先してください。`,

  fox: `## あなたの役職固有の投票材料

妖狐は人狼の襲撃では死亡せず、占われると死亡します。通常陣営の勝利条件成立時に生存していれば勝利するため、今日の処刑、占い危険、処刑後の人数推移を比較し、真の役職と耐性を漏らさないでください。`,

  cat: `## あなたの役職固有の投票材料

自分が処刑されると自分以外の生存者一人をランダムに道連れにし、対象は選べません。道連れで死亡した猫又の能力は連鎖しません。自分と各候補の処刑が人数・役職・勝利条件へ与える影響を比較してください。`,


  wolf: `## あなたの役職固有の投票材料

人狼仲間は本人の確定情報です。仲間救出、仲間投票、別候補への票集中を固定戦術にせず、必要票、公開根拠、処刑後の人狼数、翌日の勝ち筋を比較してください。秘密情報を公開根拠として扱わないでください。`,

  whiteWolf: `## あなたの役職固有の投票材料

占いでは非人狼、霊能では人狼と判定されます。占いの非人狼結果を長期的な信用へつなげつつ、仲間救出・仲間投票・今日の処刑価値を公開根拠と人数条件から比較してください。`,
});

const TASK_ROLE_GUIDANCE = Object.freeze({
  seer: Object.freeze({
    inspect: `## あなたの役職固有の判断材料

占い結果を知る前の公開情報だけで対象を比較し、差がなければ任意選択であることを正直に記録してください。今回の選択理由は後から得た結果で書き換えません。`,
  }),
  guard: Object.freeze({
    guard: `## あなたの役職固有の判断材料

current-task.guardRulesに、自己護衛・連続護衛の可否、前夜の護衛対象、前夜対象を今回も選べるかが明示されています。validTargetsにない人物は、死亡・自己護衛禁止・連続護衛禁止などの正式ルールによって対象外です。

護衛候補ごとに、今夜襲撃される可能性、死亡した場合に失われる公開能力・確定情報、護衛成功時に翌日の処刑判断へ与える影響、現在の生存人数と勝利条件における終盤価値を比較してください。単純に最も真らしい能力者を守るのではなく、襲撃されやすさと死亡時の損失を分けて評価します。

結果判明前の選択理由を、後から得た死亡情報で書き換えません。`,
  }),
  zashikiWarashi: Object.freeze({
    'choose-owner': `## あなたの役職固有の判断材料

家主選択は所属陣営と生存条件をゲーム中固定する最初の決定です。まだ役職情報は得ていないため、人物設定だけで任意に一人を選び、選択後に通知される家主の役職と陣営に従ってください。`,
  }),
  mason: Object.freeze({
    'mason-conversation': `## あなたの役職固有の判断材料

相方は本人の確定情報です。公開情報から得た推理と翌日のCO条件を共有できますが、この会話内容と未公開の相方を外部へ漏らしてはいけません。`,
  }),
  wolf: Object.freeze({
    'wolf-conversation': `## あなたの役職固有の判断材料

仲間と秘密情報を共有できます。翌日の公開方針は仲間を知らない村人にも成立する根拠を持たせ、黒結果、仲間の処刑圏、対抗CO、騙り崩壊ごとの切替条件と必要票を共有してください。discussionPlanでは各人の公開役割と、票集中のため説明を重ねる合流条件も分けます。共有案は実際の公開情報に応じて再検討できます。`,
  }),
});


function hasConfiguredRole(context, roleId) {
  return Number(context?.game?.roleComposition?.[roleId] ?? 0) > 0;
}

function hasConfiguredNonVillageNotWolfResult(context, resultField) {
  return Object.entries(context?.game?.roleComposition ?? {}).some(([roleId, count]) => {
    if (Number(count ?? 0) <= 0) return false;
    const role = getRoleDefinition(roleId);
    if (!role || role.baseTeam === 'village') return false;
    const result = role[resultField] ?? (role.countsAsWolf ? 'wolf' : 'not-wolf');
    return result === 'not-wolf';
  });
}

function appendNonWolfVillageCertaintyWarning(guidance, context, { resultField = null } = {}) {
  const shouldShow = resultField
    ? hasConfiguredNonVillageNotWolfResult(context, resultField)
    : hasConfiguredNonVillageNotWolfResult(context, 'seerResult')
      || hasConfiguredNonVillageNotWolfResult(context, 'mediumResult');
  return shouldShow ? `${guidance}

非人狼結果は村人陣営確定を意味しません。` : guidance;
}

function catDayGuidance(context) {
  const attackCondition = hasConfiguredRole(context, 'guard')
    ? '護衛されて死亡しなければ襲撃時の道連れは発動しないため、'
    : '襲撃時の道連れは襲撃死した場合にのみ発動するため、';
  return `## あなたの役職固有の判断材料

処刑時は自分以外の生存者一人を、襲撃死時は生存人狼一人をランダムに道連れにし、対象は選べません。道連れで死亡した猫又の能力は連鎖しません。${attackCondition}自分の処刑・襲撃価値と陣営への影響を比較してください。`;
}

function wolfAttackRoleGuidance(context) {
  const extra = [];
  if (hasConfiguredRole(context, 'guard')) extra.push('狩人が存在するため、護衛による襲撃失敗も考慮してください。');
  const hasMadmanClass = Object.entries(context?.game?.roleComposition ?? {}).some(([roleId, count]) => (
    Number(count ?? 0) > 0 && getRoleDefinition(roleId)?.roleClass === 'madman'
  ));
  if (hasMadmanClass) extra.push('狂人系役職が存在するため、味方側の役職を誤って襲撃する損失も考慮してください。');
  return `## あなたの役職固有の判断材料

各生存人狼が秘密投票し、最多票の対象が襲撃されます。同率最多の場合は同率候補からランダムに決定します。襲撃対象の真の役職は確定していません。襲撃対象ごとに、襲撃成功時と失敗時の盤面への影響を比較し、秘密情報を翌日の公開説明へ混ぜないでください。${extra.length ? `

${extra.join('\n')}` : ''}`;

}

const ZASHIKI_OWNER_ROLE_GUIDANCE = Object.freeze({
  villager: '家主は村人です。能力保護ではなく、家主の推理・票・生存が村全体へ残す価値を比較してください。',
  mason: '家主は共有者です。共有者として進行へ残す価値と、関係公開で襲撃候補を狭める危険を比較してください。',
  seer: '家主は占い師です。今後の占い結果を残す価値と、関係公開で襲撃リスクが上がる可能性を比較してください。',
  medium: '家主は霊能者です。今後の霊能結果を残す価値と、関係公開による襲撃・後追い死亡の危険を比較してください。',
  guard: '家主は狩人です。関係公開は狩人位置の露出にもなるため、処刑回避の利益と襲撃リスクを比較してください。',
  namahage: '家主はなまはげです。訪問能力を続ける価値と、関係公開で能力者位置を知らせる危険を比較してください。',
  cat: '家主は猫又です。家主死亡時は猫又効果と自分の後追いが重なるため、複数死亡による人数変化を確認してください。',
  madman: '家主は狂人です。騙り・投票支援を残す価値と、家主との二人死亡で非人狼数が減る終盤効果を比較してください。',
  snowWoman: '家主は雪女です。凍結能力と昼の妨害を残す価値を優先しつつ、終盤の二人死亡による票数変化も比較してください。',
  wolf: '家主は人狼です。人狼数を直接維持する価値が高いため、露骨な擁護で関係を示さずに守る選択肢を考えてください。',
  whiteWolf: '家主は白狼です。占いの非人狼判定を生かす潜伏価値が高いため、不要な擁護や関係公開で目立たせない選択肢を重視してください。',
  fox: '家主は妖狐です。占いと処刑を避けて通常陣営の勝利条件成立時まで家主を残すことを優先してください。',
});

function zashikiOwnerRoleGuidance(strategy) {
  return ZASHIKI_OWNER_ROLE_GUIDANCE[strategy?.ownerRoleId] ?? '';
}

function namahageVisitGuidance(context) {
  const badChildNames = ['wolf', 'whiteWolf', 'snowWoman']
    .filter((roleId) => Number(context?.game?.roleComposition?.[roleId] ?? 0) > 0)
    .map((roleId) => context?.game?.roleComposition?.[roleId] > 0
      ? ({ wolf: '人狼', whiteWolf: '白狼', snowWoman: '雪女' })[roleId]
      : null)
    .filter(Boolean);
  const targetDescription = badChildNames.length
    ? `${badChildNames.join('・')}の「悪い子」`
    : '「悪い子」';
  return `## あなたの役職固有の判断材料

訪問先は、${targetDescription}と疑う対象から選んでください。議論を動かす人物、護衛されにくい人物、襲撃されにくい人物という理由だけでは選ばないでください。悪い子以外には効果がなく、訪問結果は通知されません。前夜と同じ相手は選べません。

人狼が複数いる場合、一人だけを恐怖にしても他の人狼は襲撃できます。`;
}

function wolfSupportKnowledgeLine(context) {
  return (context?.player?.knowledge?.knownWolfIds ?? []).length
    ? '人狼の正体は本人の確定情報です。'
    : '人狼の正体は分かりません。';
}

function madmanDayGuidance(context) {
  return `## あなたの役職固有の判断材料

${wolfSupportKnowledgeLine(context)}偽判定・擁護・投票には、支援利益、誤爆、連鎖露出、破綻後の撤退という異なる効果があります。`;
}

function madmanVoteGuidance(context) {
  return `## あなたの役職固有の投票材料

${wolfSupportKnowledgeLine(context)}投票による人狼支援、誤爆、関係露出、翌日の票構造を比較してください。人狼を知らない場合は候補を既知情報として扱わないでください。`;
}

function snowWomanWolfKnowledgeLine(context) {
  return wolfSupportKnowledgeLine(context);
}

function snowWomanDayGuidance(context) {
  const failureCauses = [
    hasConfiguredRole(context, 'guard') ? '護衛' : '',
    '自分や対象の同夜死亡',
    hasConfiguredRole(context, 'namahage') ? '恐怖' : '',
  ].filter(Boolean).join('・');
  return `## あなたの役職固有の判断材料

雪女は生存人狼数には数えません。${snowWomanWolfKnowledgeLine(context)}凍結成功は翌朝の凍結表示で確認できます。不発時は${failureCauses}など原因を公開情報だけで断定しないでください。

前夜に推定した人狼候補と、その判断理由を翌日の騙り・誘導・投票でも考慮してください。判断を変える場合は、その後に増えた情報を根拠にしてください。`;
}

function snowWomanVoteGuidance(context) {
  return `## あなたの役職固有の投票材料

雪女は生存人狼数には数えません。${snowWomanWolfKnowledgeLine(context)}前夜の人狼候補・予想襲撃先は推定のまま扱い、凍結成功は翌朝の公開結果で更新して、現在の実効票数へ反映してください。`;
}

function snowWomanFreezeGuidance(context) {
  const hasGuard = hasConfiguredRole(context, 'guard');
  const fearRule = hasConfiguredRole(context, 'namahage')
    ? ' なまはげの恐怖で凍結行動自体が阻害される場合もあります。'
    : '';
  const failureRule = hasGuard
    ? '対象が護衛されるか、自分または対象が同夜に死亡すると翌日の凍結は発生せず'
    : '自分または対象が同夜に死亡すると翌日の凍結は発生せず';
  const comparisonItems = [
    '人狼である可能性',
    '襲撃される可能性',
    '翌日生存時の影響力',
    hasGuard ? '護衛される可能性' : '',
    '実効投票上の利益',
    '自分の昼の騙り方針との整合性',
  ].filter(Boolean).join('、');
  return `## あなたの役職固有の判断材料

自分と前夜に選んだ相手は対象にできません。${failureRule}、成功時は翌朝に公開されます。${fearRule}

まず公開情報から人狼候補を推定してください。人狼本人を凍結すると人狼陣営の発言・投票を失わせ、処刑時の遺言も封じるため、原則として避けます。次に、その人狼が今夜襲撃しそうな人物を予測してください。予想襲撃先と凍結先が重なり、襲撃で対象が死亡すると凍結効果は残らないため、重複リスクを考慮してください。

人狼候補と予想襲撃先を除いた生存者から、翌日に人狼陣営へ最も不利な発言、能力結果、票まとめ、投票を行いそうな次点候補を選んでください。候補ごとに${comparisonItems}を比較します。推定を既知情報として断定せず、不確実な場合も誤害と襲撃重複の両方が比較的少ない対象を選びます。`;
}

function zashikiStrategyInstruction(strategy) {
  if (!strategy || strategy.variant === 'unresolved') return DAY_ROLE_GUIDANCE.zashikiWarashi;
  const ownerRoleGuidance = zashikiOwnerRoleGuidance(strategy);
  const shared = `## あなたの役職固有の判断材料

家主の名前・正確な役職・所属陣営は本人だけの秘密情報です。家主側はあなたとの関係を知りません。家主が死亡すると自分も後追いしますが、自分や家主の生存自体は独立した勝利条件ではありません。所属陣営の勝利を優先し、未公開の家主情報を公開情報として扱わないでください。

${renderPromptDataBlock('zashiki-strategy', strategy)}

${ownerRoleGuidance ? `${ownerRoleGuidance}

` : ''}実際の生存人狼数は秘密情報なので提示されません。公開情報から生存人狼数を推定し、家主死亡時はwolfCountDeltaとnonWolfCountDeltaを反映した後の人狼数がwolfWinThresholdAfterOwnerFollowDeath以上になるか比較してください。`;

  if (strategy.variant === 'village-host') {
    return `${shared}

あなたは村人陣営です。家主は本人にとって確定村ですが、露骨な無条件擁護は関係を人狼へ知らせます。家主への疑いは公開根拠を検証して自然に崩し、能力役職なら能力を使わせる価値も考慮してください。ただし、より重要な村役職や村全体の勝ち筋を犠牲にしてまで家主を守りません。

家主と自分の二人死亡後に人狼同数勝利が成立しないかを毎ターン確認してください。家主情報を公開する場合は、処刑回避・真役職確定の利益と、襲撃先を教える危険・後追いによる人数減少を比較します。`;
  }
  if (strategy.variant === 'werewolf-host') {
    return `${shared}

あなたは人狼陣営で、家主は勝敗判定上の人狼です。家主死亡では人狼一人と非人狼として数えられるあなたが同時に減り、家主が最後の人狼なら村人陣営勝利になります。そのため家主生存を原則優先します。

家主を露骨に擁護せず、家主とは異なる公開根拠から同じ結論へ到達するか、必要に応じて軽い対立を保って関係を隠してください。自分の生存は不要なので、自分だけの処刑で非人狼数が一人減り人狼同数を作れる終盤では、自分を犠牲にする勝ち筋も比較します。`;
  }
  if (strategy.variant === 'werewolf-support-host') {
    return `${shared}

あなたは人狼陣営で、家主は勝敗判定上は非人狼の人狼陣営役職です。家主と自分が同時死亡すると非人狼が二人減るため、終盤では人狼同数勝利を直接作れる場合があります。

序盤は家主の騙り・妨害能力や陣営票を活用させる価値を優先します。人数条件が整う前に家主を失わせてはいけません。一方、家主との二人死亡後に人狼勝利条件が成立すると推定できる場合は、家主の処刑を無理に止めず後追いする経路も比較してください。家主を守る場合、自分だけを犠牲にする場合、家主との同時死亡を許容する場合を、残る人狼数と翌日の票で選びます。`;
  }
  return `${shared}

あなたは第三陣営の家主と同じ陣営です。家主と自分の生存条件、通常陣営の勝利条件成立時点、家主死亡による後追いを比較し、家主情報を公開せず同陣営の勝利を優先してください。`;
}

export function renderRoleGuidance(context, { taskType = context?.task?.type } = {}) {
  if (taskType === 'graveyard-conversation') {
    return `## 墓場で共有できる情報

死亡時点までに本人が知っていた公開・秘密情報と、実際に墓場で共有された内容だけを使って会話してください。死亡後の地上の議論・投票・能力結果を自動的に知っている前提にせず、新しく死亡した参加者が話した内容はその発言以降の共有情報として扱います。死亡したことで他人の真役職が自動開示されることはありません。自分が生前から知っていた真役職、能力結果、仲間情報、騙りの意図や行動理由などは、墓場でまだ共有されていなければ自然な会話として共有できます。`;
  }
  const roleId = context?.player?.roleId;
  const taskRoleId = context?.player?.strategyProfile === 'wolf' ? 'wolf' : roleId;
  if (roleId === 'namahage' && taskType === 'visit') return namahageVisitGuidance(context);
  if (roleId === 'snowWoman' && taskType === 'freeze') return snowWomanFreezeGuidance(context);
  if (taskRoleId === 'wolf' && taskType === 'wolf-attack') return wolfAttackRoleGuidance(context);
  const taskGuidance = TASK_ROLE_GUIDANCE[taskRoleId]?.[taskType];
  if (taskGuidance) return taskGuidance;
  if (roleId === 'zashikiWarashi') return zashikiStrategyInstruction(context?.player?.zashikiStrategy);
  if (roleId === 'madman') return taskType === 'vote' ? madmanVoteGuidance(context) : madmanDayGuidance(context);
  if (roleId === 'snowWoman') return taskType === 'vote' ? snowWomanVoteGuidance(context) : snowWomanDayGuidance(context);
  if (taskType === 'vote') {
    const guidance = VOTE_ROLE_GUIDANCE[roleId] ?? '';
    if (roleId === 'villager') return appendNonWolfVillageCertaintyWarning(guidance, context);
    if (roleId === 'medium') return appendNonWolfVillageCertaintyWarning(guidance, context, { resultField: 'mediumResult' });
    return guidance;
  }
  if (roleId === 'cat') return catDayGuidance(context);
  const guidance = DAY_ROLE_GUIDANCE[roleId] ?? '';
  if (roleId === 'villager') return appendNonWolfVillageCertaintyWarning(guidance, context);
  if (roleId === 'medium') return appendNonWolfVillageCertaintyWarning(guidance, context, { resultField: 'mediumResult' });
  return guidance;
}
