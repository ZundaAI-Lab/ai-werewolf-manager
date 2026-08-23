/**
 * 責務: 公開された初期役職構成だけから、夜明けの死亡数・無死亡・凍結不発を解釈する際に考慮できる事象を短く提示する。
 * 変更ルール:
 * - 現在の生存者、死亡済み役職、CO、能力結果、内部役職情報から可能性を削除・追加しない。
 * - 実際にどの事象が発生したかを推定・断定しない。
 * - Day 2以降の通常昼議論第1巡だけに表示し、他タスク・他巡では表示しない。
 * - 見出しごとに、その初期役職構成で追加の解釈候補が生じない場合は見出し自体を表示しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

function hasRole(composition, roleId) {
  return Number(composition?.[roleId] ?? 0) > 0;
}

function hasSeerFoxPair(composition) {
  return hasRole(composition, 'seer') && hasRole(composition, 'fox');
}

export function buildRoleCompositionSituationGuide(context, taskType) {
  if (!isNormalSpeechTask(taskType)) return null;
  if (Number(context?.game?.day ?? 0) < 2) return null;
  if (Number(context?.game?.discussion?.round ?? 0) !== 1) return null;
  if ((context?.game?.discussion?.roundKind ?? 'normal') !== 'normal') return null;

  const composition = context?.game?.roleComposition ?? {};
  const hasGuard = hasRole(composition, 'guard');
  const hasNamahage = hasRole(composition, 'namahage');
  const hasSnowWoman = hasRole(composition, 'snowWoman');
  const hasFox = hasRole(composition, 'fox');
  const hasZashikiWarashi = hasRole(composition, 'zashikiWarashi');
  const hasCat = hasRole(composition, 'cat');
  const canFoxBeInspected = hasSeerFoxPair(composition);

  const multipleDeaths = [];
  if (canFoxBeInspected || hasZashikiWarashi || hasCat) {
    multipleDeaths.push('人狼による襲撃');
    if (canFoxBeInspected) multipleDeaths.push('妖狐の呪殺');
    if (hasZashikiWarashi) multipleDeaths.push('座敷わらしの後追い');
    if (hasCat) multipleDeaths.push('猫又の道連れ');
  }

  const noDeaths = [];
  if (hasGuard) noDeaths.push('護衛による襲撃阻止');
  if (hasNamahage) noDeaths.push('なまはげの訪問による襲撃阻害');
  if (hasFox) noDeaths.push('妖狐への襲撃');

  const noFreeze = [];
  if (hasSnowWoman) {
    if (hasGuard) noFreeze.push('護衛による凍結阻止');
    if (hasNamahage) noFreeze.push('なまはげの訪問による凍結阻害');
    noFreeze.push('凍結対象の同夜死亡');
    noFreeze.push('雪女が夜開始時点ですでに死亡、または同夜死亡');
  }

  if (!multipleDeaths.length && !noDeaths.length && !noFreeze.length) return null;
  return {
    multipleDeaths,
    noDeaths,
    noFreeze,
    singleDeathMayCombine: multipleDeaths.length > 0,
  };
}

export function roleCompositionSituationSection(context, taskType) {
  const guide = buildRoleCompositionSituationGuide(context, taskType);
  if (!guide) return '';
  const rows = [
    '## 初期役職構成から起こりうる夜明けの状況',
    '以下は、このゲームの初期役職構成で夜明けの結果に関与しうる事象です。現在の生存役職を使って可能性を除外しておらず、実際に発生した事象を示すものでもありません。複数の事象が同じ夜に重なる場合があります。',
  ];
  if (guide.multipleDeaths.length) {
    rows.push('', '死亡者が2人以上のときに考慮できる事象:');
    guide.multipleDeaths.forEach((item) => rows.push(`- ${item}`));
  }
  if (guide.noDeaths.length) {
    rows.push('', '死亡者なしのときに考慮できる事象:');
    guide.noDeaths.forEach((item) => rows.push(`- ${item}`));
  }
  if (guide.noFreeze.length) {
    rows.push('', '凍結なしのときに考慮できる事象:');
    guide.noFreeze.forEach((item) => rows.push(`- ${item}`));
  }
  if (guide.singleDeathMayCombine) {
    rows.push('', '死亡者が1人の場合でも、上記の事象が複合している可能性があります。');
  }
  return rows.join('\n');
}
