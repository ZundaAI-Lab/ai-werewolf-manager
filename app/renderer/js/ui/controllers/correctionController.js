/**
 * 責務: 公開・私有イベント訂正、復元点選択と復元操作を所有する。
 * 変更ルール: 自動実行セッション中は訂正・復元による競合を拒否する。ゲーム規則を独自実装せず、store・dialog・描画・自動実行ロック等の正式依存だけを使用する。AppUI全体へ依存せず、処理本体をFacadeへ戻さない。
 */

// @ts-check

import { PHASE_LABELS } from '../../config/constants.js';
import { correctPublicEventWithMode, correctRoleAssignmentWithMode, editConfirmedEvent } from '../../domain/correction/correctionCommands.js';
import { recommendRestorePointForProgressionEvent, restoreGameFromPoint, summarizeRestoreImpact } from '../../domain/correction/restoreCorrectionService.js';
import { buildAbilityClaimTiming } from '../../domain/policies/abilityClaimTimingPolicy.js';
import { getNightActionCandidates, getVoteCandidates } from '../../domain/game/standardRules.js';
import { escapeHtml } from '../../shared/utils.js';
import { option, playerOptions } from '../components/components.js';
import { nightActionTargetLabel } from './uiStateFormatters.js';
import { promptAppDialog } from './appDialogController.js';
export function createCorrectionController({
  store,
  toast,
  modal,
  controlValue,
  runEngine,
  resetTransientState,
  setActiveTab,
  render,
  isAutomationMutationLocked,
}) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('状態Storeがありません。');
  if (typeof toast !== 'function') throw new TypeError('通知関数がありません。');
  if (!modal || typeof modal.querySelector !== 'function') throw new TypeError('訂正ダイアログがありません。');
  if (typeof controlValue !== 'function') throw new TypeError('入力値取得関数がありません。');
  if (typeof runEngine !== 'function') throw new TypeError('ゲームエンジン実行関数がありません。');
  if (typeof resetTransientState !== 'function') throw new TypeError('一時UI状態初期化関数がありません。');
  if (typeof setActiveTab !== 'function') throw new TypeError('表示タブ更新関数がありません。');
  if (typeof render !== 'function') throw new TypeError('描画関数がありません。');
  if (typeof isAutomationMutationLocked !== 'function') throw new TypeError('自動実行ロック取得関数がありません。');

  function rejectAutomationCorrection() {
    if (!isAutomationMutationLocked()) return false;
    toast('自動実行中は訂正・復元できません。一時停止してから操作してください。', 'warning');
    return true;
  }

  function _correctPublicEvent() {
      if (rejectAutomationCorrection()) return;
      const targetEventId = controlValue('correction-event', '');
      const reason = controlValue('correction-reason', '');
      const replacementText = controlValue('correction-text', '');
      const replacementQuestionTargetId = controlValue('correction-question-target', 'preserve');
      const structuredMode = controlValue('correction-structured-mode', 'preserve');
      let replacementStructured = null;
      if (structuredMode === 'replace') {
        const coAction = controlValue('correction-co-action', 'none');
        const coRoleId = coAction === 'none' ? 'none' : controlValue('correction-co-role', 'none');
        const abilityAction = controlValue('correction-ability-action', 'none');
        const abilityRoleId = controlValue('correction-ability-role', 'none');
        const abilityTargetId = controlValue('correction-ability-target', 'none');
        const abilityResult = controlValue('correction-ability-result', 'none');
        const targetEvent = store.getState().events.find((event) => event.id === targetEventId);
        replacementStructured = {
          coOperation: { action: coAction, roleId: coRoleId },
          abilityClaims: abilityAction === 'publish'
            ? [{
              action: 'publish',
              actorId: targetEvent?.actorId ?? null,
              claimedRoleId: abilityRoleId,
              actionType: abilityRoleId === 'medium' ? 'medium' : abilityRoleId === 'guard' ? 'guard' : 'inspect',
              targetId: abilityTargetId === 'none' ? null : abilityTargetId,
              result: abilityResult === 'none' ? '' : abilityResult,
              ...(buildAbilityClaimTiming(abilityRoleId, Number(controlValue('correction-ability-day', '0'))) ?? {}),
              selectionBasis: controlValue('correction-ability-basis', 'no-public-information'),
              evidenceEventIds: String(controlValue('correction-ability-evidence', ''))
                .split(/\s*,\s*/u)
                .map((item) => Number(item.trim().replace(/^#/u, '')))
                .filter(Number.isInteger)
                .map((sequence) => store.getState().events.find((event) => Number(event.sequence) === sequence)?.id)
                .filter(Boolean),
              selectionReasonAtTime: String(controlValue('correction-ability-reason', '')).trim(),
            }]
            : [],
        };
      }
      runEngine('公開情報訂正', (state) => correctPublicEventWithMode(state, {
        targetEventId,
        reason,
        replacementText,
        replacementQuestionTargetId,
        replacementStructured,
      }), { publicBarrier: true });
    }

  function _editPrivateEvent(eventId) {
      if (rejectAutomationCorrection()) return;
      const state = store.getState();
      const event = state.events.find((item) => item.id === eventId);
      if (!event || !['draft', 'confirmed'].includes(event.status) || event.audience?.type === 'public') {
        return toast('公開済み情報は訂正モードで修正してください。', 'error');
      }
  
      let control = '';
      if (event.type === 'vote-cast') {
        const session = state.voteSession;
        if (!session || session.id !== event.payload?.voteSessionId || !['vote', 'runoff'].includes(state.game.phase)) {
          return toast('この投票は現在の進行状態では修正できません。', 'error');
        }
        const voterId = event.actorId;
        const candidates = getVoteCandidates(state, voterId, session.candidateIds);
        const abstain = state.game.rules.vote.abstentionAllowed
          ? `<option value="abstain" ${event.payload?.targetId === 'abstain' ? 'selected' : ''}>棄権</option>`
          : '';
        control = `<label class="field"><span>投票先</span><select name="targetId">${playerOptions(candidates, event.payload?.targetId ?? '')}${abstain}</select></label>`;
      } else if (event.type === 'night-action') {
        if (state.game.phase !== 'night' || state.night?.status === 'resolved') {
          return toast('夜行動解決後は通常の部分修正を行えません。', 'error');
        }
        const actionType = event.payload?.actionType;
        const candidates = getNightActionCandidates(state, actionType, event.actorId);
        control = `<label class="field"><span>${escapeHtml(nightActionTargetLabel(actionType))}</span><select name="targetId">${playerOptions(candidates, event.payload?.targetId ?? '')}</select></label>`;
      } else if (['wolf-conversation', 'mason-conversation', 'graveyard-conversation'].includes(event.type)) {
        if (state.game.phase !== 'night' || (event.type === 'wolf-conversation' && state.night?.wolfAttack?.status === 'confirmed')) {
          return toast(event.type === 'wolf-conversation' ? '襲撃先投票確定後は共有発言を通常修正できません。' : '夜フェーズ終了後は機密会話を通常修正できません。', 'error');
        }
        control = `<label class="field"><span>共有発言</span><textarea name="content" rows="8">${escapeHtml(event.payload?.content ?? '')}</textarea></label>`;
      } else {
        return toast('この種類のイベントは通常の部分修正対象ではありません。', 'error');
      }
  
      modal.innerHTML = `<form><div class="modal-header"><h3>公開前の登録内容を修正</h3><button class="button icon ghost" data-modal-close type="button">×</button></div><div class="modal-body">${control}<label class="field"><span>修正理由</span><input name="reason" required placeholder="入力ミスなど"></label></div><div class="modal-footer"><button class="button ghost" data-modal-close type="button">キャンセル</button><button class="button primary" type="submit">内容だけ修正</button></div></form>`;
      modal.querySelector('form').addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        if (rejectAutomationCorrection()) return;
        const formData = new FormData(submitEvent.currentTarget);
        const reason = String(formData.get('reason') ?? '').trim();
        const payload = ['wolf-conversation', 'mason-conversation', 'graveyard-conversation'].includes(event.type)
          ? { content: String(formData.get('content') ?? '').trim() }
          : { targetId: String(formData.get('targetId') ?? '') };
        const response = runEngine('公開前確定情報修正', (draft) => editConfirmedEvent(draft, { eventId, payload, reason }));
        if (response?.ok) modal.close();
      });
      modal.showModal();
    }

  function _showRecordsSupport(id) {
      const section = document.getElementById(id);
      if (!section) return;
      if (section instanceof HTMLDetailsElement) section.open = true;
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

  function _restoreProgressionFromWorkspace(eventId) {
      if (rejectAutomationCorrection()) return;
      const recommendation = recommendRestorePointForProgressionEvent(store.getState(), eventId);
      if (!recommendation) {
        return toast('この進行結果に対応する復元ポイントが残っていません。', 'error');
      }
      const reason = String(controlValue('records-progression-reason', '')).trim();
      if (!reason) return toast('訂正理由を入力してください。', 'error');
      return _restorePoint(recommendation.point.id, reason);
    }

  function _openProgressionCorrection(eventId) {
      if (rejectAutomationCorrection()) return;
      const recommendation = recommendRestorePointForProgressionEvent(store.getState(), eventId);
      if (!recommendation) {
        return toast('この進行結果に対応する復元ポイントが残っていません。別の復元ポイントを選ぶか、保存済みデータを確認してください。', 'error');
      }
      return _openCorrectionRestoreDialog({
        selectedPointId: recommendation.point.id,
        targetEventId: recommendation.event.id,
      });
    }

  function _openCorrectionRestoreDialog({ selectedPointId = '', targetEventId = '' } = {}) {
      if (rejectAutomationCorrection()) return;
      const state = store.getState();
      const points = [...state.restorePoints].reverse();
      const selectedId = points.some((point) => point.id === selectedPointId) ? selectedPointId : (points[0]?.id ?? '');
      const pointOptions = points.map((point) => {
        const pointDay = Number(point.state?.game?.day ?? 0);
        const pointPhase = PHASE_LABELS[point.state?.game?.phase] ?? point.state?.game?.phase ?? '不明';
        const pointStatus = `Day ${pointDay}・${pointPhase}`;
        const impact = summarizeRestoreImpact(state, point.id);
        const impactText = impact ? ` / 後続${impact.supersededEventCount}件` : '';
        return `<option value="${escapeHtml(point.id)}" ${point.id === selectedId ? 'selected' : ''}>${escapeHtml(point.label)} / ${escapeHtml(pointStatus)}${escapeHtml(impactText)} / ${escapeHtml(new Date(point.createdAt).toLocaleString('ja-JP'))}</option>`;
      }).join('');
      const currentStatus = `Day ${state.game.day}・${PHASE_LABELS[state.game.phase] ?? state.game.phase}`;
      const targetEvent = targetEventId ? state.events.find((event) => event.id === targetEventId) : null;
      const targetNotice = targetEvent
        ? `<div class="alert warning"><strong>訂正対象: #${targetEvent.sequence} ${escapeHtml(targetEvent.payload?.text ?? targetEvent.type)}</strong><span>この結果の直前に対応する復元ポイントを選択済みです。復元後に内容を修正し、同じ進行を再実行してください。</span></div>`
        : '';
      modal.innerHTML = `<form><div class="modal-header"><h3>訂正・復元</h3><button class="button icon ghost" data-modal-close type="button">×</button></div><div class="modal-body"><p>現在の状態: <strong>${escapeHtml(currentStatus)}</strong></p><p class="help">公開前の入力は記録画面で内容だけ修正できます。公開済みの発言・CO・能力結果は訂正履歴を残して修正し、投票・処刑・夜明け・勝敗など進行結果は復元ポイントへ戻して再進行します。</p>${targetNotice}${points.length ? `<label class="field"><span>復元先</span><select name="pointId" required>${pointOptions}</select></label><div class="alert" data-role="restore-impact"></div><label class="field"><span>訂正・復元理由</span><textarea name="reason" required placeholder="何を誤り、どの状態からやり直すかを入力してください。"></textarea></label>` : '<div class="alert warning"><strong>利用可能な復元ポイントがありません</strong><span>重要操作を行うと自動作成されます。</span></div>'}</div><div class="modal-footer"><button class="button ghost" data-modal-close type="button">キャンセル</button><button class="button ghost" data-action="go-records-from-correction" type="button">記録・管理を開く</button>${points.length ? '<button class="button danger" type="submit">この地点へ復元</button>' : ''}</div></form>`;
      const form = modal.querySelector('form');
      const pointSelect = form.elements.pointId;
      const impactElement = form.querySelector('[data-role="restore-impact"]');
      const updateImpact = () => {
        if (!pointSelect || !impactElement) return;
        const impact = summarizeRestoreImpact(state, pointSelect.value);
        if (!impact) {
          impactElement.textContent = '復元の影響範囲を確認できません。';
          return;
        }
        const phaseLabel = PHASE_LABELS[impact.phase] ?? impact.phase;
        impactElement.innerHTML = `<strong>復元後: Day ${impact.day}・${escapeHtml(phaseLabel)}</strong><span>現在状態から外れるイベント ${impact.supersededEventCount}件（公開 ${impact.publicEventCount}件）、AIターン ${impact.aiTurnCount}件。訂正前のイベントはGM監査履歴へ保存されます。</span>`;
      };
      pointSelect?.addEventListener('change', updateImpact);
      updateImpact();
      form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        if (rejectAutomationCorrection()) return;
        const formData = new FormData(form);
        const pointId = String(formData.get('pointId') ?? '');
        const reason = String(formData.get('reason') ?? '').trim();
        if (!reason) return toast('復元理由を入力してください。', 'error');
        _restorePoint(pointId, reason);
      });
      modal.showModal();
    }

  async function _restorePoint(pointId, suppliedReason = '') {
      if (rejectAutomationCorrection()) return;
      const promptedReason = suppliedReason ? suppliedReason : await promptAppDialog({
        title: '訂正・復元',
        message: '復元理由を入力してください。',
        label: '復元理由',
        initialValue: '進行内容の訂正',
        confirmLabel: '復元',
      });
      const reason = String(promptedReason ?? '').trim();
      if (!reason) return;
      resetTransientState();
      const response = restoreGameFromPoint(store, { pointId, reason });
      if (!response.ok) toast(response.message, 'error');
      else {
        if (modal.open) modal.close();
        setActiveTab('workbench');
        render();
        toast(response.message, 'success');
      }
    }

  function _correctRoleAssignment(playerId, correctedRoleId, reason) {
    if (rejectAutomationCorrection()) return { ok: false, message: '自動実行中は訂正できません。' };
    return runEngine('役職訂正', (draft) => correctRoleAssignmentWithMode(draft, { playerId, correctedRoleId, reason }));
  }

  return Object.freeze({
    _correctPublicEvent,
    _editPrivateEvent,
    _showRecordsSupport,
    _restoreProgressionFromWorkspace,
    _openProgressionCorrection,
    _openCorrectionRestoreDialog,
    _restorePoint,
    _correctRoleAssignment,
  });
}
