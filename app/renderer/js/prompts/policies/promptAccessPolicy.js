/**
 * 責務: AIプロンプトへ含められる個人情報・共有者／人狼／墓場の機密会話・本人限定陣営戦略・人狼仲間の公開位置の可視性規則を一元管理し、生成前後の情報隔離を監査する。
 * 変更ルール: プロンプト文章を生成せず、状態を書き換えない。夜間機密会話、陣営戦略状態、人狼仲間の公開位置の可視性判定と、描画可能なメインゲーム用データ区画名は必ずこのモジュールだけを正本とする。自由入力可能な表示名・公開発言・公開主張・共有作戦を安全なgame-dataへ移した場合は区画名を同時に許可リストへ登録する。保存済みheartVoiceを入力区画として許可しない。
 */

import { getFactionStrategyFields } from '../../domain/game/factionStrategyState.js';
import { isWolfPartnerDispositionApplicable, resolveWolfPartnerDispositionPolicy } from '../../domain/game/wolfPartnerDispositionPolicy.js';
import { getPlayer } from '../../domain/game/standardRules.js';
import { countsAsWolf, isMadmanClass } from '../../domain/roles/roleAttributes.js';
import { inspectPromptDataBlocks } from '../serialization/promptDataSerializer.js';

function masonCommunicationRules(state) {
  return state?.game?.rules?.masonCommunication ?? {};
}

export function canParticipateInMasonConversation(state, playerId, session) {
  const rules = masonCommunicationRules(state);
  if (!rules.enabled || !session || !Array.isArray(session.participantIds)) return false;
  return session.participantIds.includes(playerId) && getPlayer(state, playerId)?.roleId === 'mason';
}

export function canIncludeCurrentMasonConversation(state, playerId, session, taskType = 'speech') {
  const rules = masonCommunicationRules(state);
  if (!canParticipateInMasonConversation(state, playerId, session) || taskType === 'briefing') return false;
  if (taskType === 'mason-conversation') return true;
  return Boolean(rules.includeConversationInAiPrompt);
}

export function canIncludePastMasonConversation(state, playerId, session) {
  const rules = masonCommunicationRules(state);
  return Boolean(rules.retainPastConversation && rules.includeConversationInAiPrompt
    && canParticipateInMasonConversation(state, playerId, session));
}

function graveyardCommunicationRules(state) {
  return state?.game?.rules?.graveyardCommunication ?? {};
}

export function canParticipateInGraveyardConversation(state, playerId, session) {
  const rules = graveyardCommunicationRules(state);
  if (!rules.enabled || !session || !Array.isArray(session.participantIds)) return false;
  const player = getPlayer(state, playerId);
  return Boolean(player && !player.alive && session.participantIds.includes(playerId));
}

export function canIncludeCurrentGraveyardConversation(state, playerId, session, taskType = 'speech') {
  if (taskType !== 'graveyard-conversation') return false;
  return canParticipateInGraveyardConversation(state, playerId, session);
}

export function canIncludePastGraveyardConversation(state, playerId, session, taskType = 'speech') {
  const rules = graveyardCommunicationRules(state);
  const player = getPlayer(state, playerId);
  return Boolean(taskType === 'graveyard-conversation' && rules.enabled && rules.retainPastConversation && rules.includeConversationInAiPrompt
    && player && !player.alive && session?.status === 'closed');
}

function wolfCommunicationRules(state) {
  return state?.game?.rules?.wolfCommunication ?? {};
}

export function canParticipateInWolfConversation(state, playerId, session) {
  const rules = wolfCommunicationRules(state);
  if (!rules.enabled || !session || !Array.isArray(session.participantIds)) return false;
  if (!session.participantIds.includes(playerId)) return false;
  const player = getPlayer(state, playerId);
  return Boolean(player && (countsAsWolf(state, player)
    || (rules.participantMode === 'wolves-and-madman' && isMadmanClass(state, player))));
}

export function canIncludeCurrentWolfConversation(state, playerId, session, taskType = 'speech') {
  const rules = wolfCommunicationRules(state);
  if (!canParticipateInWolfConversation(state, playerId, session)) return false;
  if (taskType === 'briefing') return false;
  if (taskType === 'wolf-conversation') return true;
  return Boolean(rules.includeConversationInAiPrompt);
}

export function canIncludePastWolfConversation(state, playerId, session) {
  const rules = wolfCommunicationRules(state);
  return Boolean(
    rules.retainPastConversation
      && rules.includeConversationInAiPrompt
      && canParticipateInWolfConversation(state, playerId, session),
  );
}

export function canIncludePrivateEvent(state, playerId, event) {
  if (!event || event.audience?.type === 'public') return false;
  const targets = event.audience?.targetIds ?? [];
  if (!targets.includes(playerId)) return false;
  if (event.type === 'graveyard-conversation') {
    const session = state.graveyardConversations?.find((item) => item.id === event.payload?.conversationId) ?? null;
    return canParticipateInGraveyardConversation(state, playerId, session);
  }
  if (event.type === 'mason-conversation') {
    const session = state.masonConversations?.find((item) => item.id === event.payload?.conversationId) ?? null;
    return canParticipateInMasonConversation(state, playerId, session);
  }
  if (event.type !== 'wolf-conversation') return true;
  const session = state.wolfConversations?.find((item) => item.id === event.payload?.conversationId) ?? null;
  return canParticipateInWolfConversation(state, playerId, session);
}

const ALLOWED_PROMPT_DATA_BLOCKS = new Set([
  'player',
  'stable-player-context',
  'call-names',
  'game-state',
  'public-history',
  'latest-own-public-speech',
  'delta-self-public-continuity',
  'day-conversation-status',
  'claim-timing',
  'ability-claim-evidence-windows',
  'pending-medium-claim-requirements',
  'opening-intent',
  'character-conversation-seed',
  'private-information',
  'own-history',
  'previous-decision-state',
  'decision-invalidation',
  'faction-strategy-state',
  'decision-delta',
  'reconsideration',
  'role-decision',
  'system-memory',
  'internal-memory',
  'wolf-communication',
  'wolf-partner-public-positions',
  'mason-communication',
  'graveyard-communication',
  'decision-population',
  'decision-task',
  'own-public-claim-consistency',
  'other-public-claim-contradictions',
  'runoff-decision-context',
  'vote-population-context',
  'vote-decision-context',
  'attack-decision-context',
  'two-seer-claimants',
  'wolf-black-result-context',
  'wolf-day-strategy-context',
  'madman-day-claim-context',
  'counter-claim-opportunity',
  'owner-claim-opportunity',
  'wolf-initial-claim-context',
  'madman-initial-claim-context',
  'madman-claim-context',
  'reasoning-focus',
  'current-task',
  'zashiki-strategy',
]);

function validatePrivateEventAudience(context, event, label, errors) {
  const playerId = context?.player?.id;
  const targetIds = event?.audience?.targetIds ?? [];
  if (!playerId || event?.audience?.type === 'public' || !targetIds.includes(playerId)) {
    errors.push(`${label}に本人が閲覧できないイベントがあります。`);
  }
}

export function validatePromptVisibility(context, promptText = '') {
  const errors = [];
  const wolf = context?.wolfCommunication ?? {};
  const mason = context?.masonCommunication ?? {};
  const graveyard = context?.graveyardCommunication ?? {};
  const playerId = context?.player?.id;
  const abilityResults = context?.private?.abilityResults ?? [];
  const personalNotifications = context?.private?.personalNotifications ?? [];
  const ownVotes = context?.ownHistory?.votes ?? [];
  const ownNightActions = context?.ownHistory?.nightActions ?? [];

  const partnerPositions = context?.wolfPartnerPublicPositions ?? [];
  if (context?.player?.strategyProfile !== 'wolf' && partnerPositions.length > 0) {
    errors.push('人狼以外のコンテキストへ人狼仲間の公開位置が混入しています。');
  }

  const privateEvents = [
    ...abilityResults,
    ...personalNotifications,
    ...ownVotes,
    ...ownNightActions,
  ];

  if (privateEvents.some((event) => ['wolf-conversation', 'mason-conversation', 'graveyard-conversation'].includes(event?.type))) {
    errors.push('夜間機密会話が専用区画以外の個人履歴へ混入しています。');
  }
  abilityResults.forEach((event) => validatePrivateEventAudience(context, event, '能力結果', errors));
  personalNotifications.forEach((event) => validatePrivateEventAudience(context, event, '個人通知', errors));
  ownVotes.forEach((event) => {
    if (event?.actorId !== playerId) errors.push('他人の非公開投票が本人履歴へ混入しています。');
    validatePrivateEventAudience(context, event, '本人投票履歴', errors);
  });
  ownNightActions.forEach((event) => {
    if (event?.actorId !== playerId) errors.push('他人の夜行動が本人履歴へ混入しています。');
    validatePrivateEventAudience(context, event, '本人夜行動履歴', errors);
  });

  if (!mason.currentVisible && mason.current) errors.push('閲覧権限のない現在の共有者共有会話がコンテキストへ含まれています。');
  if (!mason.pastVisible && (mason.past?.length ?? 0) > 0) errors.push('閲覧権限のない過去の共有者共有会話がコンテキストへ含まれています。');
  if (!wolf.currentVisible && wolf.current) {
    errors.push('閲覧権限のない現在の人狼共有会話がコンテキストへ含まれています。');
  }
  if (!wolf.pastVisible && (wolf.past?.length ?? 0) > 0) {
    errors.push('閲覧権限のない過去の人狼共有会話がコンテキストへ含まれています。');
  }
  if (!graveyard.currentVisible && graveyard.current) errors.push('閲覧権限のない現在の墓場会話がコンテキストへ含まれています。');
  if (!graveyard.pastVisible && (graveyard.past?.length ?? 0) > 0) errors.push('閲覧権限のない過去の墓場会話がコンテキストへ含まれています。');

  if (String(promptText).includes('[game-data:')) {
    const inspected = inspectPromptDataBlocks(promptText, ALLOWED_PROMPT_DATA_BLOCKS);
    errors.push(...inspected.errors);

    const masonBlocks = inspected.blocks.filter((block) => block.name === 'mason-communication');
    masonBlocks.forEach((block) => {
      const value = block.value ?? {};
      if (!mason.currentVisible && (value.currentConversation?.length ?? 0) > 0) errors.push('閲覧権限のない共有者共有情報が生成済みプロンプトへ含まれています。');
      if (!mason.pastVisible && (value.pastConversations?.length ?? 0) > 0) errors.push('閲覧権限のない過去の共有者共有会話が生成済みプロンプトへ含まれています。');
    });

    const wolfBlocks = inspected.blocks.filter((block) => block.name === 'wolf-communication');
    wolfBlocks.forEach((block) => {
      const value = block.value ?? {};
      if (!wolf.currentVisible && (
        (value.currentConversation?.length ?? 0) > 0
        || (value.currentStrategy?.length ?? 0) > 0
      )) {
        errors.push('閲覧権限のない現在の人狼共有情報が生成済みプロンプトへ含まれています。');
      }
      if (!wolf.pastVisible && (value.pastConversations?.length ?? 0) > 0) {
        errors.push('閲覧権限のない過去の人狼共有会話が生成済みプロンプトへ含まれています。');
      }
    });

    const graveyardBlocks = inspected.blocks.filter((block) => block.name === 'graveyard-communication');
    graveyardBlocks.forEach((block) => {
      const value = block.value ?? {};
      if (!graveyard.currentVisible && (value.currentConversation?.length ?? 0) > 0) errors.push('閲覧権限のない現在の墓場会話が生成済みプロンプトへ含まれています。');
      if (!graveyard.pastVisible && (value.pastConversations?.length ?? 0) > 0) errors.push('閲覧権限のない過去の墓場会話が生成済みプロンプトへ含まれています。');
    });

    const partnerPositionBlocks = inspected.blocks.filter((block) => block.name === 'wolf-partner-public-positions');
    if (partnerPositionBlocks.length > 1) errors.push('人狼仲間の公開位置が生成済みプロンプトへ重複しています。');
    if (context?.player?.strategyProfile !== 'wolf' && partnerPositionBlocks.length > 0) {
      errors.push('人狼以外のプロンプトへ人狼仲間の公開位置が混入しています。');
    }
    partnerPositionBlocks.forEach((block) => {
      if (JSON.stringify(block.value ?? []) !== JSON.stringify(partnerPositions)) {
        errors.push('生成済みプロンプトの人狼仲間公開位置が対象本人の可視コンテキストと一致していません。');
      }
    });

    const zashikiBlocks = inspected.blocks.filter((block) => block.name === 'zashiki-strategy');
    const ownZashikiStrategy = context?.player?.zashikiStrategy ?? null;
    if (zashikiBlocks.length > 1) errors.push('座敷わらし戦術計算が生成済みプロンプトへ重複しています。');
    if (context?.player?.roleId !== 'zashikiWarashi' && zashikiBlocks.length > 0) {
      errors.push('座敷わらし以外のプロンプトへ家主戦術計算が混入しています。');
    }
    zashikiBlocks.forEach((block) => {
      if (!ownZashikiStrategy || JSON.stringify(block.value ?? null) !== JSON.stringify(ownZashikiStrategy)) {
        errors.push('生成済みプロンプトの座敷わらし戦術計算が対象本人の可視コンテキストと一致していません。');
      }
    });

    const factionBlocks = inspected.blocks.filter((block) => block.name === 'faction-strategy-state');
    const strategyProfile = String(context?.player?.strategyProfile ?? '');
    const ownStrategy = context?.player?.factionStrategyState ?? null;
    if (factionBlocks.length > 1) errors.push('本人限定の陣営戦略状態が生成済みプロンプトへ重複しています。');
    if (!strategyProfile && factionBlocks.length > 0) {
      errors.push('村人陣営のプロンプトへ本人限定の陣営戦略状態が混入しています。');
    }
    factionBlocks.forEach((block) => {
      if (String(block.value?.profile ?? '') !== strategyProfile) {
        errors.push('生成済みプロンプトの陣営戦略状態が対象プレイヤーの属性と一致していません。');
      }
      const partnerDispositionPolicy = strategyProfile === 'wolf'
        ? resolveWolfPartnerDispositionPolicy({
          actorId: context?.player?.id,
          knownWolfIds: context?.player?.knowledge?.knownWolfIds ?? [],
          alivePlayerIds: (context?.board?.alive ?? []).map((item) => item.id),
        })
        : null;
      getFactionStrategyFields(strategyProfile)
        .filter((key) => key !== 'partnerDisposition' || isWolfPartnerDispositionApplicable(partnerDispositionPolicy))
        .forEach((key) => {
          if (String(block.value?.[key] ?? '') !== String(ownStrategy?.[key] ?? '')) {
            errors.push('生成済みプロンプトの陣営戦略状態が対象プレイヤー本人の保存状態と一致していません。');
          }
        });
    });
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
