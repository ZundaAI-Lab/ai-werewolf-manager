/**
 * 責務: 通常進行卓のDOM入力を値へ変換し、人間プレイヤー操作の正式Controller、GM代理操作、結果確認へ接続するAdapterを所有する。
 * 変更ルール: 人間プレイヤー操作の状態更新はhumanPlayerActionControllerを正本とし、このControllerへ複製しない。ゲーム規則を独自実装せず、store・入力下書き・進行卓DOM・正式な補助関数だけを明示依存として使用する。
 */

// @ts-check

import { forceAcknowledgeRole } from '../../domain/briefing/briefingCommands.js';
import { forceWolfAttackVote, recordNightAction, recordRandomNightAction, recordRandomWolfAttackVote } from '../../domain/night/nightCommands.js';
import { designateDiscussionSpeaker, recordDiscussionOpeningPreference, recordHumanPriorityAnswer, recordHumanSpeech, recordSpeechPass, resolveAllDeferred, skipPriorityAnswer } from '../../domain/discussion/discussionCommands.js';
import { recordRandomVote, recordVote } from '../../domain/vote/voteCommands.js';
import { confirmGameResult, recordResultImpression } from '../../domain/result/resultCommands.js';
import { recordHumanTestament, skipTestament } from '../../domain/execution/testamentCommands.js';
import { consolidatePlayerInternalMemory } from '../../domain/memory/memoryCommands.js';
import { manualFinish } from '../../domain/game/gameCommands.js';
import { confirmAppDialog } from './appDialogController.js';

const domainCommands = /** @type {any} */ ({
  forceAcknowledgeRole,
  forceWolfAttackVote,
  recordNightAction,
  recordRandomNightAction,
  recordRandomWolfAttackVote,
  designateDiscussionSpeaker,
  recordDiscussionOpeningPreference,
  recordHumanPriorityAnswer,
  recordHumanSpeech,
  recordSpeechPass,
  resolveAllDeferred,
  skipPriorityAnswer,
  recordRandomVote,
  recordVote,
  confirmGameResult,
  recordResultImpression,
  recordHumanTestament,
  skipTestament,
  consolidatePlayerInternalMemory,
  manualFinish,
});
export function createWorkbenchActionController({
  store,
  toast,
  drafts,
  root,
  controlValue,
  runEngine,
  humanPlayerActions,
  getHumanCoOperation,
  getHumanPriorityAbilityClaims,
  getHumanTestamentAbilityClaims,
}) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('状態Storeがありません。');
  if (typeof toast !== 'function') throw new TypeError('通知関数がありません。');
  if (!(drafts instanceof Map)) throw new TypeError('入力下書きMapがありません。');
  if (!root || typeof root.querySelector !== 'function') throw new TypeError('進行卓DOMルートがありません。');
  if (typeof controlValue !== 'function') throw new TypeError('入力値取得関数がありません。');
  if (typeof runEngine !== 'function') throw new TypeError('ゲームエンジン実行関数がありません。');
  if (!humanPlayerActions || typeof humanPlayerActions.submitTask !== 'function') throw new TypeError('人間プレイヤー操作Controllerがありません。');
  if (typeof getHumanCoOperation !== 'function') throw new TypeError('人間CO取得関数がありません。');
  if (typeof getHumanPriorityAbilityClaims !== 'function') throw new TypeError('人間質問回答能力結果取得関数がありません。');
  if (typeof getHumanTestamentAbilityClaims !== 'function') throw new TypeError('人間遺言能力結果取得関数がありません。');

  function _consolidateMemoManually(playerId) {
      const summary = controlValue(`manual-memo-summary:${playerId}`, '').trim();
      if (!summary) return toast('整理後の自由内部メモを入力してください。', 'error');
      const response = runEngine('GM自由内部メモ整理', (state) => domainCommands.consolidatePlayerInternalMemory(state, {
        playerId,
        summary,
        rawResponse: '',
        promptText: '',
        promptFingerprint: '',
        promptMode: 'manual',
        warnings: [],
      }));
      if (response?.ok) drafts.delete(`manual-memo-summary:${playerId}`);
    }

  function _commitHumanDiscussionOpeningPreference(playerId) {
      const preference = controlValue(`human-discussion-opening-preference:${playerId}`, 'NORMAL');
      const response = humanPlayerActions.submitTask({ taskType: 'discussion-opening-preference', playerId, values: { preference } });
      if (response?.ok) drafts.delete(`human-discussion-opening-preference:${playerId}`);
    }

  function _commitHumanSpeech(playerId) {
      const content = controlValue(`human-speech:${playerId}`, '');
      const questionTargetId = controlValue(`human-question-target:${playerId}`, '') || null;
      const current = store.getState();
      const mode = current.discussion?.mode ?? 'ordered';
      const nextSpeakerPreference = mode === 'designated'
        ? (controlValue(`human-next-speaker:${playerId}`, '') || null)
        : null;
      const discussionPreference = mode === 'free'
        ? controlValue(`human-discussion-preference:${playerId}`, 'NORMAL')
        : null;
      const taskType = mode === 'designated' ? 'speech-designated' : mode === 'free' ? 'speech-free' : 'speech';
      const response = humanPlayerActions.submitTask({ taskType, playerId, values: { content, coOperation: getHumanCoOperation(playerId), questionTargetId, nextSpeakerPreference, discussionPreference } });
      if (response?.ok) { drafts.delete(`human-speech:${playerId}`); _clearSpeechMetadata(playerId); }
    }

  function _commitHumanPriorityAnswer(playerId, questionEventId) {
      const key = `human-priority-answer:${questionEventId}`;
      const content = controlValue(key, '');
      const current = store.getState();
      const response = humanPlayerActions.submitTask({ taskType: 'priority-answer', playerId, questionEventId, values: { content, coOperation: getHumanCoOperation(playerId, questionEventId) }, abilityClaims: getHumanPriorityAbilityClaims(current, questionEventId) });
      if (response?.ok) _clearPriorityAnswerMetadata(questionEventId);
    }

  function _skipPriorityAnswer(questionEventId) {
      const key = `priority-answer-skip-reason:${questionEventId}`;
      const reason = controlValue(key, '');
      const response = runEngine('質問への優先回答をスキップ', (state) => domainCommands.skipPriorityAnswer(state, { questionEventId, reason }), {});
      if (response?.ok) {
        drafts.delete(key);
        _clearPriorityAnswerMetadata(questionEventId);
      }
    }


  function _commitHumanTestament(playerId) {
      const key = `human-testament:${playerId}`;
      const content = controlValue(key, '');
      const current = store.getState();
      const response = humanPlayerActions.submitTask({ taskType: 'testament', playerId, values: { content, coOperation: getHumanCoOperation(playerId, `testament:${playerId}`) }, abilityClaims: getHumanTestamentAbilityClaims(current, playerId) });
      if (response?.ok) {
        drafts.delete(key);
        drafts.delete(`human-co-action:testament:${playerId}`);
        drafts.delete(`human-co-role:testament:${playerId}`);
        drafts.delete(`human-testament-ability-action:${playerId}`);
        [...drafts.keys()].filter((draftKey) => draftKey.startsWith(`human-testament-ability:${playerId}:`)).forEach((draftKey) => drafts.delete(draftKey));
      }
    }

  function _skipTestament(playerId) {
      const response = humanPlayerActions.submitTask({ taskType: 'testament', playerId, submitKind: 'skip' });
      if (response?.ok) {
        drafts.delete(`human-testament:${playerId}`);
        drafts.delete(`human-co-action:testament:${playerId}`);
        drafts.delete(`human-co-role:testament:${playerId}`);
        drafts.delete(`human-testament-ability-action:${playerId}`);
        [...drafts.keys()].filter((draftKey) => draftKey.startsWith(`human-testament-ability:${playerId}:`)).forEach((draftKey) => drafts.delete(draftKey));
      }
    }

  function _commitHumanResultImpression(playerId) {
      const key = `human-result-impression:${playerId}`;
      const content = controlValue(key, '');
      const response = humanPlayerActions.submitTask({ taskType: 'result-impression', playerId, values: { content } });
      if (response?.ok) drafts.delete(key);
    }

  function _commitPass(playerId) {
      const current = store.getState();
      const taskType = current.discussion?.mode === 'designated' ? 'speech-designated' : current.discussion?.mode === 'free' ? 'speech-free' : 'speech';
      const response = humanPlayerActions.submitTask({ taskType, playerId, submitKind: 'pass' });
      if (response?.ok) {
        drafts.delete(`human-speech:${playerId}`);
        _clearSpeechMetadata(playerId);
      }
    }

  function _clearSpeechMetadata(playerId) {
      ['human-co-action', 'human-co-role', 'human-question-target', 'human-next-speaker', 'human-discussion-preference'].forEach((prefix) => drafts.delete(`${prefix}:${playerId}`));
    }

  function _clearPriorityAnswerMetadata(questionEventId) {
      const exactKeys = [
        `human-priority-answer:${questionEventId}`,
        `human-co-action:${questionEventId}`,
        `human-co-role:${questionEventId}`,
        `human-priority-ability-action:${questionEventId}`,
      ];
      exactKeys.forEach((key) => drafts.delete(key));
      [...drafts.keys()]
        .filter((key) => key.startsWith(`human-priority-ability:${questionEventId}:`))
        .forEach((key) => drafts.delete(key));
    }

  function _designateSpeaker(key) {
      const playerId = controlValue(key, '');
      runEngine('発言者指定', (state) => domainCommands.designateDiscussionSpeaker(state, playerId));
    }

  function _resolveDeferred(action) {
      const playerId = action === 'designate' ? controlValue('deferred-speaker', '') : null;
      runEngine('後回し状態解決', (state) => domainCommands.resolveAllDeferred(state, action, playerId));
    }

  function _saveListVote(playerId) {
      const select = root.querySelector(`[data-vote-list="${CSS.escape(playerId)}"]`);
      runEngine('一覧投票保存', (state) => domainCommands.recordVote(state, { voterId: playerId, targetId: select.value }), { publicBarrier: store.getState().game.rules.vote.visibilityDuringInput === 'public' });
    }

  function _commitProxy(button) {
      const { playerId, taskType } = button.dataset;
      const slotId = button.dataset.slotId ?? '';
      const targetId = controlValue(`proxy:${taskType}:${playerId}:${slotId}`, '');
      const reason = controlValue(`proxy-reason:${taskType}:${playerId}:${slotId}`, 'GM代理入力');
      if (!targetId) return toast('代理入力の対象を選択してください。', 'error');
      const override = { applied: true, reason, selectedBy: 'gm' };
      if (taskType === 'vote') return runEngine('GM代理投票', (state) => domainCommands.recordVote(state, { voterId: playerId, targetId, override }), store.getState().game.rules.vote.visibilityDuringInput === 'public' ? { publicBarrier: true } : {});
      if (taskType === 'wolf-attack') return runEngine('GM代理襲撃投票', (state) => domainCommands.forceWolfAttackVote(state, playerId, targetId, reason));
      return runEngine('GM代理夜行動', (state) => domainCommands.recordNightAction(state, { slotId, actorId: playerId, targetId, override }));
    }

  async function _randomAction(button) {
      const { playerId, taskType } = button.dataset;
      const slotId = button.dataset.slotId ?? '';
      if (!await confirmAppDialog({ title: 'ランダム決定', message: '有効候補からランダム決定しますか？', confirmLabel: 'ランダム決定' })) return;
      if (taskType === 'vote') return runEngine('ランダム投票', (state) => domainCommands.recordRandomVote(state, playerId), store.getState().game.rules.vote.visibilityDuringInput === 'public' ? { publicBarrier: true } : {});
      if (taskType === 'wolf-attack') return runEngine('ランダム襲撃投票', (state) => domainCommands.recordRandomWolfAttackVote(state, playerId));
      return runEngine('ランダム夜行動', (state) => domainCommands.recordRandomNightAction(state, slotId));
    }

  function _confirmResult() {
      const options = {
        revealAllRoles: Boolean(controlValue('result-reveal-roles', true)),
        revealWolfConversation: Boolean(controlValue('result-reveal-chat', false)),
        revealMasonConversation: Boolean(controlValue('result-reveal-mason-chat', false)),
        revealGraveyardConversation: Boolean(controlValue('result-reveal-graveyard-chat', false)),
        revealInternalMemos: Boolean(controlValue('result-reveal-memos', false)),
      };
      runEngine('ゲーム結果確認', (state) => domainCommands.confirmGameResult(state, options));
    }

  function _forceBriefing(playerId) {
      const reason = controlValue(`force-briefing:${playerId}`, '');
      runEngine('役職通知強制完了', (state) => domainCommands.forceAcknowledgeRole(state, playerId, reason), { notification: { roleBriefingSummary: true, key: 'role-briefing' } });
    }

  function _manualFinish(team, reason) {
    return runEngine('手動勝敗判定', (state) => domainCommands.manualFinish(state, team, reason));
  }

  return Object.freeze({
    _manualFinish,
    _consolidateMemoManually,
    _commitHumanDiscussionOpeningPreference,
    _commitHumanSpeech,
    _commitHumanPriorityAnswer,
    _commitHumanTestament,
    _skipTestament,
    _skipPriorityAnswer,
    _commitHumanResultImpression,
    _commitPass,
    _clearSpeechMetadata,
    _clearPriorityAnswerMetadata,
    _designateSpeaker,
    _resolveDeferred,
    _saveListVote,
    _commitProxy,
    _randomAction,
    _confirmResult,
    _forceBriefing,
  });
}
