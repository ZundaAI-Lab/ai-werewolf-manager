/**
 * 責務: プロンプト各セクションで共有する表示名解決、履歴整形、役職説明、データブロック圧縮を提供する。
 * 変更ルール: 表示契約だけを扱い、可視情報の選別やゲーム判断を追加しない。役職説明は公開配役・公開ルールから現在の対局に必要な相互作用だけを短く組み立て、秘密役職配置へ依存させない。公開イベントの順序・参照番号・保存済み構造化情報を変更しない。
 */

import {
  ROLE_DEFINITIONS,
  TEAM_LABELS,
} from '../../config/constants.js';

import { publicAbilityResultLabel } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { formatAbilityClaimTiming } from '../../domain/policies/abilityClaimTimingPolicy.js';
import { renderPromptDataBlock } from '../serialization/promptDataSerializer.js';

const COMPACT_ROLE_DESCRIPTIONS = Object.freeze({
  villager: '能力なし。会話・投票で人狼を探す。',
  mason: '他の共有者を知る。',
  medium: '直前の処刑者を人狼判定。',
  fox: '第三陣営。襲撃では死亡せず、占われると死亡。',
});

function configuredRoleNames(context, predicate) {
  return Object.values(ROLE_DEFINITIONS)
    .filter((role) => predicate(role) && Number(context.game.roleComposition?.[role.id] ?? 0) > 0)
    .map((role) => role.name);
}

function wolfSupportKnowledgeText(context) {
  const communication = context.game.rules?.wolfCommunication;
  return communication?.enabled && communication.participantMode === 'wolves-and-madman'
    ? '人狼を知る'
    : '人狼を知らない';
}

function dynamicCompactRoleDescription(context, roleId) {
  if (roleId === 'seer') {
    return Number(context.game.roleComposition?.fox ?? 0) > 0
      ? '夜に1人を占い、人狼かを知る。妖狐を占うと死亡させる。'
      : '夜に1人を占い、人狼かを知る。';
  }
  if (roleId === 'guard') {
    return Number(context.game.roleComposition?.snowWoman ?? 0) > 0
      ? '夜に1人を人狼襲撃・凍結から護衛。'
      : '夜に1人を人狼襲撃から護衛。';
  }
  if (roleId === 'namahage') {
    const badChildNames = configuredRoleNames(context, (role) => role.badChild);
    const badChildText = badChildNames.length ? badChildNames.join('・') : '該当なし';
    return `D1夜以降1人を訪問。悪い子（今回: ${badChildText}）なら夜行動を恐怖で阻害。人狼襲撃は生存人狼全員が恐怖時のみ阻害。恐怖は阻害成立時だけ解除。連続訪問不可。`;
  }
  if (roleId === 'madman') {
    return `人狼陣営だが生存人狼数に数えず、${wolfSupportKnowledgeText(context)}。`;
  }
  if (roleId === 'snowWoman') {
    return `人狼陣営だが生存人狼数に数えず、${wolfSupportKnowledgeText(context)}。D1夜以降1人を凍結し、成功時は翌日昼会話・投票不可、その日に処刑された場合は遺言不可（夜行動・結果受領可）となり翌朝公開。護衛・同夜死亡などで不発、連続指定不可。`;
  }
  if (roleId === 'wolf') {
    return '人狼仲間を知り、夜の襲撃に参加する。';
  }
  if (roleId === 'whiteWolf') {
    return '人狼仲間を知り、襲撃に参加し、生存人狼数にも数える。占いでは非人狼、霊能では人狼判定。';
  }
  if (roleId === 'cat') {
    return '処刑時は生存者1人、襲撃死時は生存人狼1人をランダム道連れ。道連れで死亡した猫又の能力は連鎖しない。';
  }
  if (roleId === 'zashikiWarashi') {
    return '初夜最優先で他者1人を家主に選び、役職を知って同陣営化。家主側には関係非通知。家主死亡で後追い。自身は人狼陣営でも生存人狼数に数えず、第三陣営家主なら同時勝利。';
  }
  return null;
}

export function lines(values, fallback = 'なし') {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : fallback;
}

export function normalizeSharedConversationText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[「」『』"'`]/g, '')
    .replace(/[。．.!！?？、，,：:；;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function uniqueSharedMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    const normalized = normalizeSharedConversationText(message.content);
    const key = `${message.speakerId}\u0000${normalized}`;
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildPastWolfConversationSummary(summaries, activeMessages) {
  const activeContentKeys = new Set(
    activeMessages.map((message) => normalizeSharedConversationText(message.content)).filter(Boolean),
  );
  const activeCombinedKey = normalizeSharedConversationText(activeMessages.map((message) => message.content).join(' / '));
  const latestStrategy = {};
  for (const item of summaries ?? []) {
    for (const [key, value] of Object.entries(item.sharedStrategy ?? {})) {
      const text = String(value ?? '').trim();
      if (text) latestStrategy[key] = text;
    }
  }
  const latestPastConversation = [...(summaries ?? [])].reverse()
    .map((item) => ({ day: item.day, summary: String(item.summary ?? '').trim() }))
    .find((item) => {
      const key = normalizeSharedConversationText(item.summary);
      return key && key !== activeCombinedKey && !activeContentKeys.has(key);
    }) ?? null;
  return {
    strategySummary: sharedStrategyLines(latestStrategy),
    latestPastConversation,
  };
}


export function sharedStrategyLines(strategy = {}) {
  const labels = {
    claimPlan: '通常時の潜伏・騙り方針',
    blackReceivedPlan: '黒結果時の対応分岐',
    partnerExecutionPlan: '仲間処刑圏での必要票判断',
    collapsePlan: '主張崩壊後の縮小世界',
    discussionPlan: '各人の公開役割・説得対象・票移動・説明を重ねる合流条件',
    attackPlan: '襲撃方針',
  };
  return Object.entries(labels)
    .map(([key, label]) => {
      const value = String(strategy[key] ?? '').trim();
      return value ? `${label}: ${value}` : null;
    })
    .filter(Boolean);
}

export function playerName(context, playerId, fallback = '不明') {
  return context.board.alive.find((item) => item.id === playerId)?.name
    ?? context.board.dead.find((item) => item.id === playerId)?.name
    ?? fallback;
}

export function formatPromptEventText(context, event) {
  const actor = event.actorId ? playerName(context, event.actorId) : '';
  const payload = event.payload ?? {};
  if (payload.text) return `${actor ? `${actor}: ` : ''}${payload.text}`;
  if (event.type === 'vote-finalized') {
    const tally = (payload.tally ?? []).map((item) => `${playerName(context, item.targetId)} ${item.count}票`).join('、');
    return `投票結果: ${tally}`;
  }
  if (event.type === 'vote-cast') {
    const target = payload.targetId === 'abstain' ? '棄権' : playerName(context, payload.targetId);
    return `投票: ${target}`;
  }
  if (event.type === 'night-action') {
    const label = { inspect: '占い', guard: '護衛', visit: '訪問', freeze: '凍結', 'choose-owner': '家主選択' }[payload.actionType] ?? payload.actionType;
    return `${label}: ${playerName(context, payload.targetId)}`;
  }
  if (event.type === 'private-result') {
    if (payload.actionType === 'choose-owner') {
      const ownerRoleName = ROLE_DEFINITIONS[payload.ownerRoleId]?.name ?? payload.ownerRoleId ?? '不明';
      const teamName = payload.resolvedTeam === 'wolf'
        ? '人狼陣営'
        : payload.resolvedTeam === 'fox'
          ? '妖狐陣営'
          : payload.resolvedTeam === 'village'
            ? '村人陣営'
            : '未決定';
      return `家主確定: ${playerName(context, payload.targetId)}（${ownerRoleName}）／所属陣営: ${teamName}`;
    }
    const result = payload.result === 'wolf' ? '人狼' : '人狼ではない';
    return `${payload.actionType === 'medium' ? '霊能' : '占い'}結果: ${playerName(context, payload.targetId)}は${result}`;
  }
  return event.type;
}

export function callNameSection(context) {
  if (!context.callNames?.enabled) return '';
  const rows = (context.callNames.rows ?? [])
    .filter((row) => row.preferred !== row.targetName)
    .map((row) => ({
      target: row.targetName,
      preferred: row.preferred,
    }));
  if (!rows.length) return '';
  return `## このゲームでの相手別の呼び方
${renderPromptDataBlock('call-names', rows)}

文章中では必要に応じてpreferredを使用できます。機械解析用欄ではtargetの正式表示名を使用してください。`;
}

export function formatAbilityClaim(context, claim) {
  const roleName = ROLE_DEFINITIONS[claim.claimedRoleId]?.name ?? claim.claimedRoleId ?? '能力';
  const actionLabel = { guard: '護衛', namahage: '訪問', snowWoman: '凍結' }[claim.claimedRoleId] ?? null;
  const timing = formatAbilityClaimTiming(claim) || `D${claim.actionDay ?? '?'}能力`;
  if (actionLabel) return `${playerName(context, claim.actorId)}: ${timing} ${roleName}履歴 → ${playerName(context, claim.targetId)}へ${actionLabel}`;
  return `${playerName(context, claim.actorId)}: ${timing} ${roleName}結果 → ${playerName(context, claim.targetId)}は${publicAbilityResultLabel(claim.result, claim.claimedRoleId)}`;
}

export function roleTeamLabel(role) {
  if (role?.id === 'zashikiWarashi') return '家主と同じ陣営（初夜に決定）';
  return TEAM_LABELS[role?.baseTeam] ?? '陣営未定';
}

export function roleDescriptionForPrompt(context, roleId) {
  const role = ROLE_DEFINITIONS[roleId];
  if (roleId === 'guard' && Number(context.game.roleComposition?.snowWoman ?? 0) <= 0) {
    return '夜に一人を護衛し、人狼の襲撃から守る。';
  }
  return role?.description ?? '能力説明なし';
}

function compactRoleDescriptionForPrompt(context, roleId) {
  return dynamicCompactRoleDescription(context, roleId)
    ?? COMPACT_ROLE_DESCRIPTIONS[roleId]
    ?? roleDescriptionForPrompt(context, roleId);
}

export function initialRoleRulesSection(context) {
  const rows = Object.entries(context.game.roleComposition ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([roleId, count]) => {
      const role = ROLE_DEFINITIONS[roleId];
      const name = role?.name ?? roleId;
      const team = roleTeamLabel(role);
      const description = compactRoleDescriptionForPrompt(context, roleId);
      return `- ${name}×${count}（${team}）: ${description}`;
    });
  if (!rows.length) return '';
  const roleMissingLine = context.game.rules?.roleAssignment?.roleMissingEnabled === true
    ? '\n- 役職欠けあり（公開される配役構成は開始前の構成。実際に欠けた役職は非公開）'
    : '';
  return `## 配役・役職
${rows.join('\n')}${roleMissingLine}`;
}

export function initialGameRulesSection(context) {
  const vote = context.game.rules?.vote ?? {};
  const firstNight = context.game.rules?.firstNight ?? {};
  const tieResolution = vote.tieResolution === 'random-execution'
    ? '上限後も同票なら同票候補からランダム処刑'
    : '上限後も同票なら処刑なし';
  const firstNightSeerRule = firstNight.seerMode === 'choose'
    ? '占い対象選択'
    : firstNight.seerMode === 'random-non-wolf'
      ? '占いランダム白（非人狼を自動選択）'
      : '占いなし';
  const firstNightRows = [
    `人狼会話${firstNight.wolfCommunicationEnabled ? 'あり' : 'なし'}`,
    `襲撃${firstNight.wolfAttackEnabled ? 'あり' : 'なし'}`,
    firstNightSeerRule,
    `護衛${firstNight.guardEnabled ? 'あり' : 'なし'}`,
  ];
  const rows = [
    `処刑=単独最多票（過半数不要）/ 自投票${vote.selfVoteAllowed ? '可' : '不可'} / 棄権${vote.abstentionAllowed ? '可' : '不可'} / 役職${vote.revealExecutedRole ? '公開' : '非公開'}`,
    `同票=決選最大${Number(vote.runoffLimit ?? 0)}回 → ${tieResolution}`,
    '勝利=村:生存人狼0 / 人狼:生存人狼数≧その他生存者数',
  ];
  if (Number(context.game.roleComposition?.fox ?? 0) > 0) {
    rows.push('妖狐生存時に村または人狼の勝利条件成立 → 妖狐勝利');
  }
  rows.push(`初夜=${firstNightRows.join(' / ')}`);
  return `## 固定ルール
${rows.map((row) => `- ${row}`).join('\n')}`;
}

export function compactPromptValue(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = value.map(compactPromptValue).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, compactPromptValue(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function renderOptionalDataBlock(name, value) {
  const compacted = compactPromptValue(value);
  return compacted === undefined ? '' : renderPromptDataBlock(name, compacted);
}
