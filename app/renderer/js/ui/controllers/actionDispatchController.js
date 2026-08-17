/**
 * 責務: data-action名を対応するUI操作へ一対一で接続し、クリック入口の分岐表を所有する。
 * 変更ルール: DOM探索は受け取ったbuttonのdataset参照だけに限定する。ゲームデータ読込／出力はbootstrapが所有する転送処理へカスタムイベントで委譲する。自動実行中は閲覧操作と現在待機中の人間／手動AI入力だけを許可し、それ以外の状態変更を拒否する。ゲーム規則は実装せず既存Controllerまたは正式ドメインコマンドへ委譲する。
 */

import { startGame } from '../../domain/game/gameCommands.js';
import { acknowledgeRole } from '../../domain/briefing/briefingCommands.js';
import { closeGraveyardConversation, closeMasonConversation, closeWolfConversation, publishDawn, reopenWolfConversation, resolveNight } from '../../domain/night/nightCommands.js';
import { deferSpeech, finishDiscussion, grantTargetedDiscussionReconsideration } from '../../domain/discussion/discussionCommands.js';
import { beginVote, publishExecution, resolveExecution, finalizeVote, publishVoteResult, reopenVoteInput, setVoteInputMode } from '../../domain/vote/voteCommands.js';
import { publishGameResult } from '../../domain/result/resultCommands.js';
import { exitCorrectionMode } from '../../domain/correction/correctionCommands.js';

const AUTOMATION_VIEW_ACTIONS = new Set([
  'go-setup', 'go-workbench', 'go-records', 'go-public', 'go-records-from-correction',
  'open-player-relationship-dialog', 'open-role-help', 'inspect-player', 'open-public-window', 'export-public-html',
  'records-view-mode', 'records-correction-mode', 'records-correction-select',
  'relationship-select-player', 'relationship-clear-selection', 'relationship-select-snapshot', 'relationship-toggle-layer',
  'show-records-shared', 'show-records-audit', 'postgame-analysis-ask', 'postgame-analysis-clear', 'game-data-export',
]);

const AUTOMATION_HUMAN_INPUT_ACTIONS = new Set([
  'commit-human-discussion-opening-preference', 'commit-human-speech', 'commit-human-priority-answer', 'commit-human-testament', 'commit-human-result-impression',
  'skip-testament', 'skip-priority-answer', 'pass-speech', 'save-list-vote',
  'submit-human-task', 'open-human-role-notice', 'confirm-human-role-notice',
]);

const AUTOMATION_MANUAL_AI_ACTIONS = new Set([
  'copy-prompt', 'copy-manual-stage-prompt', 'advance-manual-stage', 'use-manual-stage-fallback',
  'commit-manual-generation', 'preview-ai', 'commit-ai',
]);

function canDispatchDuringAutomation(action, mode) {
  if (!['running', 'waiting-human', 'waiting-manual-ai'].includes(mode)) return true;
  if (AUTOMATION_VIEW_ACTIONS.has(action)) return true;
  if (mode === 'waiting-human' && AUTOMATION_HUMAN_INPUT_ACTIONS.has(action)) return true;
  if (mode === 'waiting-manual-ai' && AUTOMATION_MANUAL_AI_ACTIONS.has(action)) return true;
  return false;
}
function requestGameDataTransfer(kind) {
  window.dispatchEvent(new CustomEvent(`ai-werewolf-game-data-${kind}-request`));
}
function setRecordsView(ui, mode) {
  ui.recordsViewMode = mode;
  ui.relationshipSelectedPlayerId = '';
  ui.relationshipSnapshotId = '';
  return ui.render();
}

export function createActionDispatchController({ ui }) {
  if (!ui) throw new TypeError('AppUIがありません。');

  const handlers = new Map([
    ['go-setup', () => ui.setTab('setup')],
    ['go-workbench', () => ui.setTab('workbench')],
    ['go-records', () => ui.setTab('records')],
    ['open-player-relationship-dialog', () => ui.relationshipDialogController.open()],
    ['go-records-from-correction', () => { ui.recordsViewMode = 'correction'; ui.modal.close(); return ui.setTab('records'); }],
    ['go-public', () => ui.setTab('public')],
    ['new-game', () => ui._openNewGameDialog()],
    ['game-data-import', () => requestGameDataTransfer('import')],
    ['game-data-export', () => requestGameDataTransfer('export')],
    ['open-role-help', () => ui._openRoleHelp()],
    ['apply-preset', () => ui.setupActionController._applyPreset()],
    ['randomize-characters', () => ui.setupActionController._randomizeCharacters()],
    ['shuffle-roles', () => ui.setupActionController._shuffleRoles()],
    ['shuffle-player-order', () => ui.setupActionController._shufflePlayerOrder()],
    ['move-player-up', (button) => ui.setupActionController._movePlayerOrder(button.dataset.playerId, -1)],
    ['move-player-down', (button) => ui.setupActionController._movePlayerOrder(button.dataset.playerId, 1)],
    ['edit-player', (button) => ui._openPlayerModal(button.dataset.playerId)],
    ['start-game', () => ui.setupActionController._runEngine('ゲーム開始', (state) => startGame(state))],
    ['copy-prompt', (button) => ui._copyPrompt(button)],
    ['copy-manual-stage-prompt', (button) => ui._copyManualStagePrompt(button)],
    ['advance-manual-stage', (button) => ui._advanceManualStage(button)],
    ['use-manual-stage-fallback', (button) => ui._useManualStageFallback(button)],
    ['commit-manual-generation', (button) => ui._commitManualGeneration(button)],
    ['ack-ai-briefing', (button) => ui.setupActionController._runEngine('AI役職通知確認', (state) => acknowledgeRole(state, button.dataset.playerId), { notification: { roleBriefingSummary: true, key: 'role-briefing' } })],
    ['force-briefing', (button) => ui.workbenchActionController._forceBriefing(button.dataset.playerId)],
    ['preview-ai', () => ui.render()],
    ['commit-ai', (button) => ui.aiTaskCommitController._commitAiSafely(button)],
    ['consolidate-memo-manual', (button) => ui.workbenchActionController._consolidateMemoManually(button.dataset.playerId)],
    ['commit-human-discussion-opening-preference', (button) => ui.workbenchActionController._commitHumanDiscussionOpeningPreference(button.dataset.playerId)],
    ['commit-human-speech', (button) => ui.workbenchActionController._commitHumanSpeech(button.dataset.playerId)],
    ['commit-human-priority-answer', (button) => ui.workbenchActionController._commitHumanPriorityAnswer(button.dataset.playerId, button.dataset.questionEventId)],
    ['commit-human-testament', (button) => ui.workbenchActionController._commitHumanTestament(button.dataset.playerId)],
    ['skip-testament', (button) => ui.workbenchActionController._skipTestament(button.dataset.playerId)],
    ['skip-priority-answer', (button) => ui.workbenchActionController._skipPriorityAnswer(button.dataset.questionEventId)],
    ['commit-human-result-impression', (button) => ui.workbenchActionController._commitHumanResultImpression(button.dataset.playerId)],
    ['pass-speech', (button) => ui.workbenchActionController._commitPass(button.dataset.playerId)],
    ['submit-human-task', (button) => ui.humanPlayerActionController._submitFromButton(button)],
    ['open-human-role-notice', (button) => ui.humanPlayerActionController._openRoleNotice(button.dataset.playerId)],
    ['confirm-human-role-notice', (button) => ui.humanPlayerActionController._confirmRoleNotice(button.dataset.playerId)],
    ['defer-speech', (button) => ui.setupActionController._runEngine('発言者を後回し', (state) => deferSpeech(state, button.dataset.playerId))],
    ['designate-speaker', () => ui.workbenchActionController._designateSpeaker('discussion-speaker')],
    ['finish-discussion', () => ui.setupActionController._runEngine('昼議論終了', (state) => finishDiscussion(state))],
    ['resolve-deferred', (button) => ui.workbenchActionController._resolveDeferred(button.dataset.deferredAction)],
    ['targeted-reconsideration', () => ui.setupActionController._runEngine('対象者へ再検討機会を追加', (state) => grantTargetedDiscussionReconsideration(state))],
    ['targeted-response', () => ui.setupActionController._runEngine('対象者へ再検討機会を追加', (state) => grantTargetedDiscussionReconsideration(state))],
    ['begin-vote', () => ui.setupActionController._runEngine('投票開始', (state) => beginVote(state))],
    ['vote-mode', (button) => ui.setupActionController._runEngine('投票入力方式変更', (state) => setVoteInputMode(state, button.dataset.mode))],
    ['save-list-vote', (button) => ui.workbenchActionController._saveListVote(button.dataset.playerId)],
    ['reopen-vote', () => ui.setupActionController._runEngine('投票入力へ戻る', (state) => reopenVoteInput(state))],
    ['finalize-vote', () => ui.setupActionController._runEngine('投票集計', (state) => finalizeVote(state))],
    ['publish-vote', () => ui.setupActionController._runEngine('投票結果公開', (state) => publishVoteResult(state), { publicBarrier: true })],
    ['resolve-execution', () => ui.setupActionController._runEngine('処刑内容解決', (state) => resolveExecution(state))],
    ['publish-execution', () => ui.setupActionController._runEngine('処刑公開', (state) => publishExecution(state), { publicBarrier: true })],
    ['close-graveyard-chat', () => ui.setupActionController._runEngine('墓場会話終了', (state) => closeGraveyardConversation(state))],
    ['close-mason-chat', () => ui.setupActionController._runEngine('共有者共有会話終了', (state) => closeMasonConversation(state))],
    ['close-wolf-chat', () => ui.setupActionController._runEngine('人狼共有会話終了', (state) => closeWolfConversation(state))],
    ['reopen-wolf-chat', () => ui.setupActionController._runEngine('人狼共有会話再開', (state) => reopenWolfConversation(state))],
    ['commit-proxy', (button) => ui.workbenchActionController._commitProxy(button)],
    ['random-action', (button) => ui.workbenchActionController._randomAction(button)],
    ['resolve-night', () => ui.setupActionController._runEngine('夜行動解決', (state) => resolveNight(state))],
    ['publish-dawn', () => ui.setupActionController._runEngine('夜明け確定', (state) => publishDawn(state), { informationBarrier: true })],
    ['confirm-result', () => ui.workbenchActionController._confirmResult()],
    ['publish-result', () => ui.setupActionController._runEngine('ゲーム結果公開', (state) => publishGameResult(state), { publicBarrier: true })],
    ['inspect-player', (button) => ui._openPlayerStatus(button.dataset.playerId)],
    ['open-public-window', () => ui.publicWindowController._openPublicWindow()],
    ['export-public-html', () => ui.publicWindowController._exportPublicHtml()],
    ['records-view-mode', (button) => setRecordsView(ui, button.dataset.viewMode === 'relationship' ? 'relationship' : 'correction')],
    ['relationship-select-player', (button) => ui.relationshipDialogController.selectPlayer(button.dataset.playerId)],
    ['relationship-clear-selection', () => ui.relationshipDialogController.clearSelection()],
    ['relationship-select-snapshot', (button) => ui.relationshipDialogController.selectSnapshot(button.dataset.snapshotId)],
    ['relationship-toggle-layer', (button) => ui.relationshipDialogController.toggleLayer(button.dataset.relationType)],
    ['records-correction-mode', (button) => {
      ui.recordsCorrectionMode = ['restore', 'progression', 'public'].includes(button.dataset.mode) ? button.dataset.mode : 'restore';
      ui.recordsCorrectionSelectionId = '';
      return ui.render();
    }],
    ['records-correction-select', (button) => {
      ui.recordsCorrectionMode = ['restore', 'progression', 'public'].includes(button.dataset.mode) ? button.dataset.mode : ui.recordsCorrectionMode;
      ui.recordsCorrectionSelectionId = String(button.dataset.itemId ?? '');
      return ui.render();
    }],
    ['show-records-shared', () => ui.correctionController._showRecordsSupport('records-shared-support')],
    ['show-records-audit', () => ui.correctionController._showRecordsSupport('records-audit-support')],
    ['postgame-analysis-ask', (button) => ui.postgameAnalysisController.ask(button.dataset.turnId)],
    ['postgame-analysis-clear', (button) => ui.postgameAnalysisController.clear(button.dataset.turnId)],
    ['restore-selected-point', (button) => {
      const reason = String(ui._controlValue('records-restore-reason', '')).trim();
      if (!reason) return ui.toast('復元理由を入力してください。', 'error');
      return ui.correctionController._restorePoint(button.dataset.pointId, reason);
    }],
    ['restore-selected-progression', (button) => ui.correctionController._restoreProgressionFromWorkspace(button.dataset.eventId)],
    ['manual-finish', () => ui._openManualFinish()],
    ['exit-correction', () => ui.setupActionController._runEngine('訂正モード終了', (state) => exitCorrectionMode(state))],
    ['correct-public-event', () => ui.correctionController._correctPublicEvent()],
    ['edit-private-event', (button) => ui.correctionController._editPrivateEvent(button.dataset.eventId)],
    ['restore-point', (button) => ui.correctionController._restorePoint(button.dataset.pointId)],
    ['restore-progression-event', (button) => ui.correctionController._openProgressionCorrection(button.dataset.eventId)],
  ]);

  return Object.freeze({
    actionNames: Object.freeze([...handlers.keys()]),
    canDispatchDuringAutomation(action, mode = ui.automationUiState?.mode ?? 'idle') {
      return canDispatchDuringAutomation(String(action ?? ''), mode);
    },
    dispatch(button) {
      const action = String(button?.dataset?.action ?? '');
      if (ui.isAutomationMutationLocked() && !canDispatchDuringAutomation(action, ui.automationUiState?.mode ?? 'idle')) {
        ui.toast('自動実行中はこの変更操作を実行できません。一時停止してから操作してください。', 'warning');
        return undefined;
      }
      const handler = handlers.get(action);
      return handler ? handler(button) : undefined;
    },
  });
}
