/**
 * 責務: 投票、決選、襲撃、公開主張整合性、議論再考の判断材料を文章化する。
 * 変更ルール: decisionContext.jsと公開主張だけを文章化し、候補固定、禁止、真役職断定を追加しない。投票では生存者・有効候補・同票処理と、votePopulationAnalysis.js由来の処刑直後／次夜襲撃成功後の基本勝敗分岐を分離して表示する。生存人狼数や候補正体が本人に未確定なら仮定分岐のまま示し、本人の確定秘密情報と矛盾する候補分岐は表示しない。追加死亡役職がある局面で単純人数分岐を確定表示しない。襲撃候補の非CO共通説明は候補ごとに複製せず一度だけ表示し、候補固有の公開警告だけを個別表示する。公開配役に存在しない役職名・相互作用は襲撃判断へ出さず、配役依存項目は文章単位で条件表示する。本人公開主張の整合性区画はCO・公開結果そのものを再掲せず、それらから導いた候補集合・配役制約・矛盾警告だけを表示する。表示名・公開発言・公開主張由来の自由文を含む判断材料は[game-data:...]へ隔離し、指示文へ直接連結しない。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';

import { renderPromptDataBlock } from '../serialization/promptDataSerializer.js';

import {
  lines,
  playerName,
  formatPromptEventText,
} from './promptFormatters.js';
export function outcomeText(value) {
  if (value === 'wolf-win') return '人狼勝利条件へ到達';
  if (value === 'village-win') return '村人勝利条件へ到達';
  return 'ゲーム継続';
}

export function runoffDecisionSection(context, runoff) {
  if (!runoff) return '';
  const rows = [];
  rows.push(`前回投票: ${runoff.previousTally.map((item) => `${playerName(context, item.targetId)} ${item.count}票`).join('、') || '集計非公開'}`);
  rows.push(`前回投票後に追加された公開証拠: ${runoff.hasNewPublicEvidence ? runoff.newPublicEvidenceEvents.map((event) => `#${event.sequence} Day ${event.day} ${formatPromptEventText(context, event)}`).join(' / ') : 'なし'}`);
  rows.push('同票そのものは候補の陣営を確定しませんが、公開された投票分布は人物関係や成立する配役へ新しい情報を与える場合があります。');
  if (runoff.previousBallotsVisible) {
    runoff.candidateBranches.forEach((branch) => {
      rows.push(`${playerName(context, branch.candidateId)}への前回投票者: ${branch.previousSupporterIds.map((id) => playerName(context, id)).join('、') || 'なし'}`);
    });
  } else {
    rows.push('他者の前回投票先は公開設定上表示されません。');
  }
  if (runoff.ownPreviousVoteId) rows.push(`あなた自身の前回投票: ${playerName(context, runoff.ownPreviousVoteId)}`);
  runoff.candidateBranches.forEach((branch) => {
    rows.push(`${playerName(context, branch.candidateId)}を処刑した場合:`);
    if (branch.activeClaimRoleId) {
      const roleName = ROLE_DEFINITIONS[branch.activeClaimRoleId]?.name ?? branch.activeClaimRoleId;
      rows.push(`  ${roleName}CO。処刑後に同役職COは${branch.sameRoleClaimCountAfterExecution}人残る。公開能力結果主張${branch.publicAbilityClaimCount}件。`);
    } else {
      rows.push('  非CO者。現在の役職CO人数は維持される。');
    }
  });
  return `### 決選投票で増えた情報\n${renderPromptDataBlock('runoff-decision-context', rows)}`;
}

function voteTieResolutionText(context) {
  const limit = Math.max(0, Number(context.game.rules.vote.runoffLimit ?? 0));
  const resolution = context.game.rules.vote.tieResolution === 'random-execution'
    ? '同票候補からランダム処刑'
    : '処刑なし';
  if (limit <= 0) return `同票時: ${resolution}`;
  return `同票時: 最大${limit}回の決選後、${resolution}`;
}

function votePopulationSection(context, decision) {
  const composition = context.game.roleComposition ?? {};
  const hasAdditionalExecutionDeath = Number(composition.cat ?? 0) > 0
    || Number(composition.zashikiWarashi ?? 0) > 0;
  if (hasAdditionalExecutionDeath) {
    return `## 処刑後の盤面
${lines([
      '対象が人狼なら、生存人狼は1人減ります。対象が非人狼なら、人狼本体は減りません。',
      '処刑時に追加死亡が発生する可能性があるため、単純な「1人処刑→1人襲撃」だけの人数分岐は確定表示しません。今回の投票条件にある特殊役職の効果を優先してください。',
    ])}`;
  }

  const branches = decision.vote.populationBranches ?? [];
  if (!branches.length) return '';
  const byWolfCount = new Map();
  branches.forEach((branch) => {
    const count = Number(branch.assumedAliveWolfCount ?? 0);
    if (!byWolfCount.has(count)) byWolfCount.set(count, []);
    byWolfCount.get(count).push(branch);
  });
  const exactKnown = decision.population.knownAliveWolfCount !== null;
  const rows = [];
  [...byWolfCount.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([wolfCount, populationBranches]) => {
      rows.push(exactKnown
        ? `把握している生存人狼: ${wolfCount}人`
        : `生存人狼が${wolfCount}人の場合:`);
      populationBranches.forEach((branch) => {
        const targetName = branch.targetId ? playerName(context, branch.targetId) : '対象';
        const alignment = branch.candidateAlignment === 'wolf' ? `${targetName}が人狼` : `${targetName}が非人狼`;
        const execution = `${alignment}なら、処刑直後は${branch.afterExecutionAliveCount}人生存・人狼${branch.afterExecutionWolfCount}人・単独過半数${branch.afterExecutionMajorityThreshold}票で${outcomeText(branch.executionOutcome)}`;
        if (!branch.nightOccurs) {
          rows.push(`${execution}。この時点で勝利条件へ到達するため、夜フェーズへ進みません。`);
          return;
        }
        rows.push(`${execution}。今夜の襲撃が成功すると${branch.afterSuccessfulAttackAliveCount}人生存・人狼${branch.afterExecutionWolfCount}人・単独過半数${branch.afterSuccessfulAttackMajorityThreshold}票で${outcomeText(branch.successfulAttackOutcome)}。`);
      });
    });
  return `## 処刑後の盤面
${renderPromptDataBlock('vote-population-context', rows)}

各候補の処刑が、次の夜まで含めて自陣営の勝敗へどう影響するかを比較してください。`;
}

function voteSpecialRoleRows(context) {
  const composition = context.game.roleComposition ?? {};
  return [
    Number(composition.fox ?? 0) > 0
      ? '妖狐が生存中に村人陣営または人狼陣営の勝利条件が成立すると、妖狐陣営勝利になります。'
      : '',
    Number(composition.cat ?? 0) > 0
      ? '猫又を処刑すると、自分以外の生存者一人がランダムに道連れになります。'
      : '',
    Number(composition.zashikiWarashi ?? 0) > 0
      ? '座敷わらしの家主に選ばれている人物を処刑すると、座敷わらしが後追いする可能性があります。'
      : '',
  ].filter(Boolean);
}

export function voteDecisionSection(context, decision) {
  const candidateNames = context.task.validTargetIds
    .map((id) => playerName(context, id))
    .filter(Boolean);
  const rows = [
    `生存者: ${decision.population.aliveCount}人`,
    `有効候補: ${candidateNames.join('、') || 'なし'}`,
    voteTieResolutionText(context),
    ...voteSpecialRoleRows(context),
  ];
  const general = `## 今回の投票条件
${renderPromptDataBlock('vote-decision-context', rows)}`;
  const population = votePopulationSection(context, decision);
  const runoff = runoffDecisionSection(context, decision.runoff);
  return [general, population, runoff].filter(Boolean).join('\n\n');
}

export function attackCandidatePublicWarningText(context, branch) {
  const warnings = [];
  const alliedClaimActors = branch.alliedWolfResultClaimActorIds ?? [];
  if (alliedClaimActors.length) {
    warnings.push(`${alliedClaimActors.map((id) => playerName(context, id)).join('、')}がこの候補へ人狼判定を公開済みです。候補が襲撃死するとその判定とは両立せず、自分たちの公開主張を弱め、対立する主張を相対的に強める可能性があります。`);
  }
  const accusedKnownWolves = branch.targetWolfResultClaimedKnownWolfIds ?? [];
  if (accusedKnownWolves.length) {
    warnings.push(`この候補は${accusedKnownWolves.map((id) => playerName(context, id)).join('、')}へ人狼判定を公開済みです。生存させる場合は、その主張と今後の能力結果・票形成への影響を比較してください。`);
  }
  return warnings.length ? `公開上の警告: ${warnings.join(' ')}` : '';
}

export function attackDecisionSection(context, decision) {
  if (!decision.attack) return '';
  const composition = context.game.roleComposition ?? {};
  const hasGuard = Number(composition.guard ?? 0) > 0;
  const successOutcome = decision.attack.successWolfOutcome === 'wolf-win'
    ? '襲撃成功時に人狼勝利条件へ到達します。'
    : decision.attack.successWolfOutcome === 'continue'
      ? '襲撃成功後もゲームは継続します。'
      : '';
  const failureOutcome = decision.attack.failureWolfOutcome === 'wolf-win'
    ? '襲撃失敗でも人狼勝利条件へ到達しています。'
    : decision.attack.failureWolfOutcome === 'continue'
      ? '襲撃失敗後もゲームは継続します。'
      : '';
  const activeClaims = context.board.claims ?? [];
  const abilityClaims = context.board.publicAbilityClaims ?? [];
  const nonClaimBranches = decision.attack.candidateBranches.filter((branch) => (
    !activeClaims.some((item) => item.actorId === branch.targetId)
  ));
  const claimedCandidateRows = decision.attack.candidateBranches.flatMap((branch) => {
    const claim = activeClaims.find((item) => item.actorId === branch.targetId);
    if (!claim) return [];
    const targetAbilityClaims = abilityClaims.filter((item) => item.actorId === branch.targetId);
    const warningText = attackCandidatePublicWarningText(context, branch);
    const sameRoleCount = activeClaims.filter((item) => item.roleId === claim.roleId).length;
    const remainingCount = Math.max(0, sameRoleCount - 1);
    const resultNote = targetAbilityClaims.length ? `公開能力結果主張${targetAbilityClaims.length}件あり。` : '公開能力結果主張なし。';
    const futureImpact = claim.roleId === 'seer'
      ? '主張が真なら、生存時は次の夜にも新しい占い結果を生成できます。襲撃成功時は以後の占い能力を失わせますが、死亡によって現在の占い結果や残る対抗COの評価が強まる場合があります。'
      : claim.roleId === 'medium'
        ? '主張が真なら、生存して次の朝を迎えれば直前の処刑者の結果を公開できます。その後に新しい処刑がなければ追加結果は増えません。死亡によって既存の能力結果や残る対抗COの評価が変化する場合があります。'
        : claim.roleId === 'guard'
          ? '主張が真なら、生存中は今後の襲撃を阻止する可能性が残ります。本人を襲撃候補にした場合も、別の狩人候補、護衛規則、襲撃失敗時に残る能力を比較します。'
          : '主張の真偽と役職によって、失われる能力・陣営票・残る内訳が異なります。';
    return [`${playerName(context, branch.targetId)}: ${ROLE_DEFINITIONS[claim.roleId]?.name ?? claim.roleId}CO。襲撃後に同役職COは${remainingCount}人残ります。${resultNote}${futureImpact}${warningText ? ` ${warningText}` : ''}`];
  });
  const nonClaimRows = nonClaimBranches.length
    ? [
      `非CO候補: ${nonClaimBranches.map((branch) => playerName(context, branch.targetId)).join('、')}`,
      '非CO候補の共通点: 襲撃後も現在の役職CO人数は維持されます。公開配役上の潜伏役職である可能性が残り、襲撃によって役職内訳が確定するとは限りません。',
      ...nonClaimBranches.flatMap((branch) => {
        const warningText = attackCandidatePublicWarningText(context, branch);
        return warningText ? [`${playerName(context, branch.targetId)}: ${warningText}`] : [];
      }),
    ]
    : [];
  const candidateRows = [...nonClaimRows, ...claimedCandidateRows];
  const specialRoleFactors = [
    Number(composition.fox ?? 0) > 0
      ? '妖狐を襲撃して死者が出ない可能性と、妖狐候補を確認する価値'
      : '',
    Number(composition.cat ?? 0) > 0
      ? '猫又を襲撃して人狼が道連れになる危険'
      : '',
  ].filter(Boolean).map((text) => `- ${text}`);
  const attackContextRows = [
    `有効な襲撃候補: ${decision.attack.candidateBranches.map((branch) => playerName(context, branch.targetId)).join('、') || 'なし'}`,
    `襲撃成功後: ${decision.attack.successAliveCount}人生存、単独過半数は${decision.attack.successMajorityThreshold}票。${successOutcome}`,
    `襲撃失敗後: ${decision.attack.failureAliveCount}人生存、単独過半数は${decision.attack.failureMajorityThreshold}票。${failureOutcome}`,
    ...candidateRows,
    '役職CO者の死亡は残るCO数と公開結果の評価を変え、主張の真偽と役職によって失われる能力・陣営票が異なります。非CO者の死亡ではCO構造を維持したまま、潜伏役職・推理役を失う可能性があります。',
  ];
  const guardAssessment = hasGuard
    ? `まず、死亡者・処刑者・狩人CO・過去の死者なしなどの公開情報から、狩人の生存可能性をlow / medium / highで評価します。狩人死亡が確定していない限り護衛リスクをゼロにせず、狩人生存可能性と特定対象の護衛可能性は分けてください。

`
    : '';
  const comparisonItems = [
    '- 襲撃成功の見込みと、確実に生存者を一人減らす価値',
    '- 翌日の票数、処刑縄、勝利条件への影響',
    '- 能力者・進行役を失わせる価値と、灰や役職内訳への影響',
    hasGuard ? '- 狩人が生存している場合の護衛可能性' : '',
    '- 対象を生存させた場合に翌日以降増える確定情報・能力結果・役職確定材料と、次夜以降の襲撃計画',
  ].filter(Boolean).join('\n');
  const guardRoute = hasGuard
    ? '護衛されにくい人物を確実に減らすことや、狩人候補を先に襲う経路も比較できますが固定戦術ではありません。'
    : '生存者を確実に減らすことも比較できます。';
  return `## 襲撃後に変化する情報
${renderPromptDataBlock('attack-decision-context', attackContextRows)}

各候補を危険度だけで評価せず、襲撃後の盤面が狼陣営にどれだけ有利になるかを比較してください。

${guardAssessment}選択対象と最有力の別候補について次を比較します。
${comparisonItems}
${specialRoleFactors.join('\n')}${specialRoleFactors.length ? '\n' : ''}
能力者や強い発言者を優先する必要はありません。狼に有利な票数・縄数へ近づけることが最善なら、その対象を選べます。${guardRoute ? ` ${guardRoute}` : ''}

前夜と同じ対象を再襲撃する場合は、前夜の結果によって成功見込みがどう変化したかを評価してください。死者なしの原因が公開情報から確定していない場合、原因を断定してはいけません。`;


}

export function ownPublicClaimConsistency(context, decision) {
  const consistency = decision.ownPublicClaimConsistency;
  if (!consistency.claimedRoleId && !consistency.claimedNotWolfIds.length && !consistency.claimedWolfIds.length) return 'あなた自身が公開した能力結果主張はありません。';
  const whiteWolfRows = consistency.seerWhiteWolfRuleActive
    ? [
      `占いで人狼判定になり得る通常人狼数: ${consistency.seerVisibleWolfCount}人`,
      `占いで非人狼判定となる白狼数: ${consistency.seerHiddenWolfCount}人`,
      consistency.remainingPossibleNormalWolfCandidateIds.length
        && `通常人狼候補: ${consistency.remainingPossibleNormalWolfCandidateIds.map((id) => playerName(context, id)).join('、')}`,
      consistency.remainingPossibleWhiteWolfCandidateIds.length
        && `白狼候補: ${consistency.remainingPossibleWhiteWolfCandidateIds.map((id) => playerName(context, id)).join('、')}`,
      '白狼入り配役の占い結果では、非人狼結果先も白狼候補からは除外されません。',
    ]
    : [];
  const rows = [
    ...whiteWolfRows,
    consistency.remainingPossibleWolfCandidateIds.length && `公開主張だけでは人狼である可能性を除外できない人物: ${consistency.remainingPossibleWolfCandidateIds.map((id) => playerName(context, id)).join('、')}`,
    consistency.remainingAliveWolfCandidateIds.length && `そのうち現在の生存者: ${consistency.remainingAliveWolfCandidateIds.map((id) => playerName(context, id)).join('、')}`,
    consistency.requiredWolfCount && `配役上の人狼数: ${consistency.requiredWolfCount}人`,
    consistency.remainingPossibleWolfCandidateIds.length && 'この一覧は論理上の除外状態であり、人物ごとの可能性の高さや投票優先度を示しません。',
    ...consistency.contradictionWarnings.map((warning) => `警告: ${warning}`),
  ].filter(Boolean);
  return renderPromptDataBlock('own-public-claim-consistency', rows);
}

export function otherPublicClaimContradictions(context, decision) {
  const contradictions = decision.otherPublicClaimContradictions ?? [];
  const rows = contradictions.flatMap((consistency) => {
    const actorName = playerName(context, consistency.actorId);
    const roleName = ROLE_DEFINITIONS[consistency.claimedRoleId]?.name ?? consistency.claimedRoleId ?? '能力者';
    return consistency.contradictionWarnings.map((warning) => `${actorName}（${roleName}CO）: ${warning}`);
  });
  return rows.length ? renderPromptDataBlock('other-public-claim-contradictions', rows) : '';
}

export function discussionReconsideration(context, decision) {
  const reconsideration = decision.discussionReconsideration;
  const roundKind = context.game.discussion?.roundKind ?? 'normal';
  if (!reconsideration?.pending && !reconsideration?.active && roundKind !== 'targeted-response') {
    return '';
  }
  const affected = (reconsideration?.affectedPlayerIds ?? []).map((id) => playerName(context, id));
  const roundInstruction = roundKind === 'targeted-response'
    ? [
      '今回の発言では、3巡目に行われた新規CO、CO変更、CO撤回へ直接反応してください。',
      '以前の発言全体を言い直さず、新情報によって変わった点だけを公開発言にしてください。',
      '判断が変わった場合は、何が変わり投票予定がどう変化したかを示してください。',
      '判断が変わらない場合は、新情報が以前の判断へ影響しなかった理由、判断を変えるために不足している情報、最有力候補と次点候補の差、次のDayで確認すべき一点のうち、重要なもの一つを優先してください。',
      '同じ結論と同じ根拠しかない場合は、短く維持を表明して終了して構いません。',
    ]
    : [];
  const status = reconsideration?.pending
    ? '3巡目にCO状態が更新され、その時点ですでに発言回数が0だった参加者がいます。'
    : reconsideration?.active
      ? 'この発言巡は、3巡目のCO状態更新を再検討するために追加されました。'
      : 'この発言巡は追加の再検討巡です。';
  return `${renderPromptDataBlock('reconsideration', {
    status,
    reasons: [...(reconsideration?.reasons ?? [])],
    affectedPlayers: affected,
  })}

新情報によって強まった根拠、弱まった根拠、成立・不成立になった配役を確認してください。
${roundInstruction.join('\n')}`;
}
