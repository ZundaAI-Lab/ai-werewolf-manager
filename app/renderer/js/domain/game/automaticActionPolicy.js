/**
 * 責務: 現在のゲーム状態だけから、全自動進行が次に実行する一つの操作を純粋導出する。
 * 変更ルール: DOM、画面ラベル、data-action、AI設定画面の状態を参照しない。ゲーム規則はworkflowと各専用ポリシーを正本とし、機密会話の通常次話者も各会話ポリシーのround-robin導出を使用する。AI生成タスクの所属はgenerationTaskCategories.jsを正本として個別caseへ複製しない。人間操作待ちは画面DOMを再探索せず再開できるよう、現在タスクの識別情報をdescriptorとしてそのまま返す。
 */

import { TASK_GENERATION_CATEGORY } from '../../config/generationTaskCategories.js';
import { getCurrentGmTask } from './workflow.js';
import { getAlivePlayers, getPlayer } from './standardRules.js';
import { canSpeakDuringDay } from './playerStatus.js';
import { getActiveGraveyardConversation, getActiveMasonConversation, getActiveWolfConversation } from '../../state/selectors.js';
import { getGraveyardConversationNextSpeakerId } from '../night/graveyardConversationPolicy.js';
import { getMasonConversationNextSpeakerId } from '../night/masonConversationPolicy.js';
import { getWolfConversationNextSpeakerId } from '../night/wolfConversationPolicy.js';

const PUBLIC_AI_TASK_TYPES = new Set(['speech', 'speech-designated', 'speech-free', 'priority-answer', 'testament', 'result-impression']);
const PRIVATE_AI_TASK_TYPES = new Set(Object.keys(TASK_GENERATION_CATEGORY).filter((taskType) => !PUBLIC_AI_TASK_TYPES.has(taskType)));
const GENERATED_AI_TASK_TYPES = new Set(Object.keys(TASK_GENERATION_CATEGORY));
const PUBLICATION_COMMANDS = new Set(['publish-vote', 'publish-execution', 'publish-dawn', 'publish-result']);

function result(kind, extra = {}) {
  return Object.freeze({ kind, ...extra });
}

function firstDiscussionCandidate(state) {
  return getAlivePlayers(state).find((player) => (
    canSpeakDuringDay(state, player.id)
    && Number(state.discussion?.remainingByPlayer?.[player.id] ?? 0) > 0
  ))?.id ?? null;
}

function taskPlayerId(state, task) {
  if (task.type === 'graveyard-conversation') {
    const session = getActiveGraveyardConversation(state);
    return getGraveyardConversationNextSpeakerId(session);
  }
  if (task.type === 'wolf-conversation') {
    const session = getActiveWolfConversation(state);
    return getWolfConversationNextSpeakerId(session);
  }
  if (task.type === 'mason-conversation') {
    const session = getActiveMasonConversation(state);
    return getMasonConversationNextSpeakerId(session);
  }
  return task.playerId ?? null;
}

function aiTaskAction(state, task) {
  const playerId = taskPlayerId(state, task);
  if (!playerId) {
    if (task.type === 'graveyard-conversation') return result('command', { command: 'close-graveyard-chat', label: '墓場会話終了' });
    if (task.type === 'wolf-conversation') return result('command', { command: 'close-wolf-chat', label: '人狼共有会話終了' });
    if (task.type === 'mason-conversation') return result('command', { command: 'close-mason-chat', label: '共有者共有会話終了' });
    return result('stopped', { reason: `${task.label}の対象プレイヤーを決定できません。` });
  }
  const player = getPlayer(state, playerId);
  if (!player) return result('stopped', { reason: `${task.label}の対象プレイヤーが存在しません。` });
  if (player.controller === 'ai') {
    return result('ai-task', {
      taskRequest: Object.freeze({
        playerId,
        taskType: task.type,
        slotId: String(task.slotId ?? task.questionEventId ?? ''),
      }),
      label: task.label,
    });
  }
  const kind = PUBLIC_AI_TASK_TYPES.has(task.type) ? 'human-public' : 'human-private';
  return result(kind, {
    playerId,
    taskType: task.type,
    slotId: String(task.slotId ?? ''),
    questionEventId: String(task.questionEventId ?? ''),
    conversationId: String(task.conversationId ?? ''),
    reason: `${player.name}の${PUBLIC_AI_TASK_TYPES.has(task.type) ? '公開入力' : '非公開操作'}待ちです。`,
  });
}

function deterministicCommand(command, label, extra = {}) {
  return result('command', { command, label, ...extra });
}

export function resolveAutomaticAction(state, { autoPublish = true } = {}) {
  if (!state?.game) return result('stopped', { reason: 'ゲーム状態を取得できません。' });
  if (state.game.correctionMode?.enabled) return result('stopped', { reason: '訂正モード中です。' });

  const task = getCurrentGmTask(state);
  let action = null;

  if (GENERATED_AI_TASK_TYPES.has(task.type)) {
    action = aiTaskAction(state, task);
  } else switch (task.type) {
    case 'setup':
      action = deterministicCommand('start-game', 'ゲーム開始');
      break;
    case 'briefing': {
      const player = getPlayer(state, task.playerId);
      action = player?.controller === 'ai'
        ? deterministicCommand('complete-ai-briefing', 'AI役職通知', { playerId: task.playerId })
        : result('human-private', { playerId: task.playerId, taskType: 'briefing', slotId: '', questionEventId: '', conversationId: '', reason: `${player?.name ?? '人間プレイヤー'}の役職確認待ちです。` });
      break;
    }
    case 'private-notification':
      action = result('human-private', { playerId: task.playerId, taskType: task.type, slotId: '', questionEventId: '', conversationId: '', reason: `${getPlayer(state, task.playerId)?.name ?? '人間プレイヤー'}の本人限定結果確認待ちです。` });
      break;
    case 'discussion-designate': {
      const playerId = firstDiscussionCandidate(state);
      action = playerId
        ? deterministicCommand('designate-speaker', '発言者の指定', { playerId })
        : result('stopped', { reason: '次の発言者を指定できません。' });
      break;
    }
    case 'discussion-all-deferred':
      action = deterministicCommand('resolve-all-deferred', '昼議論の終了', { deferredAction: 'complete' });
      break;
    case 'discussion-complete':
      action = state.discussion?.reconsideration?.pending
        ? deterministicCommand('targeted-reconsideration', '追加発言の開始')
        : deterministicCommand('begin-vote', '投票開始');
      break;
    case 'finalize-vote':
      action = deterministicCommand('finalize-vote', '投票集計');
      break;
    case 'publish-vote':
      action = deterministicCommand('publish-vote', '投票結果公開');
      break;
    case 'resolve-execution':
      action = deterministicCommand('resolve-execution', '処刑内容解決');
      break;
    case 'publish-execution':
      action = deterministicCommand('publish-execution', '処刑公開');
      break;
    case 'resolve-night':
      action = deterministicCommand('resolve-night', '夜行動解決');
      break;
    case 'publish-dawn':
      action = deterministicCommand('publish-dawn', '夜明け確定');
      break;
    case 'confirm-result':
      action = deterministicCommand('confirm-result', 'ゲーム結果確認');
      break;
    case 'publish-result':
      action = deterministicCommand('publish-result', 'ゲーム結果公開');
      break;
    case 'ended':
      action = result('ended', { reason: 'ゲームが終了しました。' });
      break;
    case 'briefing-complete':
      action = result('stopped', { reason: '役職通知完了後の次フェーズを確定できません。状態を確認してください。' });
      break;
    default:
      action = result('stopped', { reason: `自動化対象外のGM確認です: ${task.label}` });
      break;
  }

  if (!autoPublish && action.kind === 'command' && PUBLICATION_COMMANDS.has(action.command)) {
    return result('stopped', { reason: '公開前で停止しました。AI設定の「公開操作も自動化」を有効にすると続行できます。' });
  }
  return action;
}

export const AUTOMATIC_ACTION_POLICY = Object.freeze({
  publicAiTaskTypes: Object.freeze([...PUBLIC_AI_TASK_TYPES]),
  privateAiTaskTypes: Object.freeze([...PRIVATE_AI_TASK_TYPES]),
  publicationCommands: Object.freeze([...PUBLICATION_COMMANDS]),
});
