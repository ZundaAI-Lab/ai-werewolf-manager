/**
 * 責務: 人間プレイヤーの公開発言・投票・夜行動・秘密会話・役職確認などを値ベースで正式ドメインコマンドへ登録する単一窓口を提供する。
 * 変更ルール: 人間操作は現在の進行卓上で完結させ、別画面DOMへ依存しない。操作値は呼び出し元から受け取り、ゲーム規則は各domain commandへ委譲する。登録成功時だけ人間タスク完了イベントを通知し、自動実行の再開判断はautomation側へ委譲する。
 */

import { acknowledgeRole, markBriefingShown } from '../../domain/briefing/briefingCommands.js';
import { recordDiscussionOpeningPreference, recordHumanPriorityAnswer, recordHumanSpeech, recordSpeechPass, skipPriorityAnswer } from '../../domain/discussion/discussionCommands.js';
import { recordHumanTestament, skipTestament } from '../../domain/execution/testamentCommands.js';
import { recordGraveyardMessage, recordMasonMessage, recordNightAction, recordWolfAttackVote, recordWolfMessage } from '../../domain/night/nightCommands.js';
import { acknowledgePrivateResults, recordResultImpression } from '../../domain/result/resultCommands.js';
import { recordVote } from '../../domain/vote/voteCommands.js';
import { buildAbilityClaimTiming } from '../../domain/policies/abilityClaimTimingPolicy.js';
import { renderHumanRoleNoticeDialog } from '../views/briefing/briefingView.js';

function value(card, name, fallback = '') {
  const control = card?.querySelector(`[data-human-field="${CSS.escape(name)}"]`);
  if (!control) return fallback;
  return control.type === 'checkbox' ? control.checked : control.value;
}

function abilityClaims(state, card) {
  if (value(card, 'abilityAction', 'none') !== 'publish') return [];
  const bySequence = new Map((state.events ?? []).filter((event) => event.status === 'published' && Number.isInteger(Number(event.sequence))).map((event) => [Number(event.sequence), event.id]));
  return [...card.querySelectorAll('[data-human-ability-row]')].map((row) => {
    const field = (name, fallback = '') => row.querySelector(`[data-human-ability-field="${CSS.escape(name)}"]`)?.value ?? fallback;
    const targetId = field('targetId');
    if (!targetId) return null;
    const evidenceEventIds = String(field('evidence')).split(/[\s,、]+/u).map((item) => Number(item.replace(/^#/u, ''))).filter(Number.isInteger).map((sequence) => bySequence.get(sequence)).filter(Boolean);
    const claimedRoleId = field('claimedRoleId');
    const timing = buildAbilityClaimTiming(claimedRoleId, Number(field('actionDay', '0')));
    return {
      action: 'publish',
      claimedRoleId,
      ...(timing ?? {}),
      targetId,
      result: field('result'),
      selectionBasis: field('selectionBasis', 'no-public-information'),
      evidenceEventIds,
      selectionReasonAtTime: String(field('selectionReasonAtTime')).trim(),
    };
  }).filter(Boolean);
}

function coOperation(card) {
  const action = value(card, 'coAction', 'none');
  return { action, roleId: ['declare', 'change'].includes(action) ? value(card, 'coRoleId', 'none') : 'none' };
}

export function createHumanPlayerActionController({ store, modal, runEngine, toast }) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('状態Storeがありません。');
  if (!modal) throw new TypeError('共通モーダルがありません。');
  if (typeof runEngine !== 'function') throw new TypeError('ゲームエンジン実行関数がありません。');
  if (typeof toast !== 'function') throw new TypeError('通知関数がありません。');

  function notifyCompleted(detail) {
    window.dispatchEvent(new CustomEvent('ai-werewolf-human-task-completed', { detail }));
  }

  function submitTask({ taskType, playerId, slotId = '', questionEventId = '', submitKind = '', values = {}, abilityClaims: claims = [] } = {}) {
    const state = store.getState();
    let response = null;
    if (taskType === 'discussion-opening-preference') response = runEngine('発言希望制の開始時発言希望', (draft) => recordDiscussionOpeningPreference(draft, { playerId, preference: values.preference ?? 'NORMAL' }));
    else if (['speech', 'speech-designated', 'speech-free'].includes(taskType)) {
      if (submitKind === 'pass') response = runEngine('発言パス公開', (draft) => recordSpeechPass(draft, { playerId }), { publicBarrier: true });
      else {
        const mode = state.discussion?.mode;
        response = runEngine('人間発言公開', (draft) => recordHumanSpeech(draft, {
          playerId,
          content: values.content ?? '',
          coOperation: values.coOperation ?? { action: 'none', roleId: 'none' },
          questionTargetId: values.questionTargetId || null,
          nextSpeakerPreference: mode === 'designated' ? (values.nextSpeakerPreference || null) : null,
          discussionPreference: mode === 'free' ? (values.discussionPreference || 'NORMAL') : null,
        }), { publicBarrier: true });
      }
    } else if (taskType === 'priority-answer') {
      if (submitKind === 'skip') response = runEngine('質問への優先回答をスキップ', (draft) => skipPriorityAnswer(draft, { questionEventId, reason: '人間プレイヤーが回答をスキップ' }));
      else response = runEngine('人間の質問回答公開', (draft) => recordHumanPriorityAnswer(draft, { playerId, questionEventId, content: values.content ?? '', coOperation: values.coOperation ?? { action: 'none', roleId: 'none' }, abilityClaims: claims }), { publicBarrier: true });
    } else if (taskType === 'vote') response = runEngine('人間投票', (draft) => recordVote(draft, { voterId: playerId, targetId: values.targetId ?? '' }), state.game.rules.vote.visibilityDuringInput === 'public' ? { publicBarrier: true } : {});
    else if (taskType === 'wolf-attack') response = runEngine('人間襲撃投票', (draft) => recordWolfAttackVote(draft, { actorId: playerId, targetId: values.targetId ?? '' }));
    else if (taskType === 'wolf-conversation') response = runEngine('人間共有会話', (draft) => recordWolfMessage(draft, { speakerId: playerId, content: values.content ?? '' }));
    else if (taskType === 'mason-conversation') response = runEngine('人間共有者会話', (draft) => recordMasonMessage(draft, { speakerId: playerId, content: values.content ?? '' }));
    else if (taskType === 'graveyard-conversation') response = runEngine('人間墓場会話', (draft) => recordGraveyardMessage(draft, { speakerId: playerId, content: values.content ?? '' }));
    else if (taskType === 'private-notification') response = runEngine('人間個人結果通知確認', (draft) => acknowledgePrivateResults(draft, playerId), { informationBarrier: true });
    else if (taskType === 'testament') {
      if (submitKind === 'skip') response = runEngine('遺言なし', (draft) => skipTestament(draft, { playerId, reason: '遺言なし' }));
      else response = runEngine('人間の遺言公開', (draft) => recordHumanTestament(draft, { playerId, content: values.content ?? '', coOperation: values.coOperation ?? { action: 'none', roleId: 'none' }, abilityClaims: claims }), { publicBarrier: true });
    } else if (taskType === 'result-impression') response = runEngine('人間の勝敗後感想公開', (draft) => recordResultImpression(draft, { playerId, content: values.content ?? '' }), { publicBarrier: true });
    else if (slotId) response = runEngine('人間秘密夜行動', (draft) => recordNightAction(draft, { slotId, actorId: playerId, targetId: values.targetId ?? '' }));
    else throw new Error(`未対応の人間操作です: ${taskType}`);

    if (response?.ok) notifyCompleted({ taskType, playerId, slotId, questionEventId });
    return response;
  }

  function _submitFromButton(button) {
    const card = button.closest('[data-human-task-card]');
    if (!card) return toast('人間操作カードを取得できません。', 'error');
    const taskType = card.dataset.taskType ?? '';
    const playerId = card.dataset.playerId ?? '';
    const slotId = card.dataset.slotId ?? '';
    const questionEventId = card.dataset.questionEventId ?? '';
    const values = {
      content: String(value(card, 'content', '')),
      preference: String(value(card, 'preference', 'NORMAL')),
      targetId: String(value(card, 'targetId', '')),
      questionTargetId: String(value(card, 'questionTargetId', '')),
      nextSpeakerPreference: String(value(card, 'nextSpeakerPreference', '')),
      discussionPreference: String(value(card, 'discussionPreference', 'NORMAL')),
      coOperation: coOperation(card),
    };
    return submitTask({ taskType, playerId, slotId, questionEventId, submitKind: button.dataset.humanSubmitKind ?? '', values, abilityClaims: abilityClaims(store.getState(), card) });
  }

  function _openRoleNotice(playerId) {
    const response = runEngine('人間役職情報を表示', (draft) => markBriefingShown(draft, playerId), { informationBarrier: true, notification: { silentSuccess: true } });
    if (!response?.ok) return;
    modal.innerHTML = renderHumanRoleNoticeDialog(store.getState(), playerId);
    modal.showModal();
  }

  function _confirmRoleNotice(playerId) {
    const response = runEngine('人間役職通知確認', (draft) => acknowledgeRole(draft, playerId), { informationBarrier: true, notification: { roleBriefingSummary: true, key: 'role-briefing' } });
    if (!response?.ok) return;
    modal.close();
    notifyCompleted({ taskType: 'briefing', playerId });
  }

  return Object.freeze({ submitTask, _submitFromButton, _openRoleNotice, _confirmRoleNotice });
}
