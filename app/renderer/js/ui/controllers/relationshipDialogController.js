/**
 * 責務: 進行卓・自動実行画面から開くプレイヤー相関図ダイアログと、相関図内の選択・表示レイヤー操作を所有する。
 * 変更ルール: 相関モデルや公開／機密判定を独自実装せずplayerRelationshipViewへ委譲する。記録・管理画面の相関図と同じ選択状態を共有し、ダイアログ表示中だけ専用dialogを再描画する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { getRoleName } from '../../state/selectors.js';
import { renderPlayerRelationshipView } from '../views/records/playerRelationshipView.js';

function isRelationshipLayerKey(value) {
  if (['suspicion', 'vote'].includes(value)) return true;
  if (!value.startsWith('ability:')) return false;
  const roleId = value.slice('ability:'.length);
  return Boolean(ROLE_DEFINITIONS[roleId]?.publicAbilityClaim);
}

export function createRelationshipDialogController({ ui }) {
  if (!ui) throw new TypeError('AppUIがありません。');

  function renderDialog() {
    const dialog = ui.relationshipDialog;
    if (!dialog) return;
    const state = ui.store.getState();
    dialog.innerHTML = `<div class="modal-header"><div><span class="eyebrow">進行確認</span><h3>プレイヤー相関図</h3></div><button class="button icon ghost" data-modal-close type="button" aria-label="閉じる">×</button></div><div class="modal-body relationship-dialog-body">${renderPlayerRelationshipView({
      state,
      showConfidential: ui.showConfidential,
      selectedPlayerId: ui.relationshipSelectedPlayerId,
      selectedSnapshotId: ui.relationshipSnapshotId,
      visibleRelationTypes: [...ui.relationshipVisibleRelationTypes],
      getRoleName,
    })}</div>`;
  }

  function refreshSurface() {
    if (ui.relationshipDialog?.open) {
      renderDialog();
      return;
    }
    ui.render();
  }

  function open() {
    if (!ui.relationshipDialog) throw new Error('プレイヤー相関図ダイアログを利用できません。');
    ui.relationshipSelectedPlayerId = '';
    ui.relationshipSnapshotId = '';
    renderDialog();
    if (!ui.relationshipDialog.open) ui.relationshipDialog.showModal();
  }

  function refresh() {
    if (ui.relationshipDialog?.open) renderDialog();
  }

  function selectPlayer(playerId) {
    const normalizedPlayerId = String(playerId ?? '');
    ui.relationshipSelectedPlayerId = ui.store.getState().players.some((player) => player.id === normalizedPlayerId)
      ? normalizedPlayerId
      : '';
    refreshSurface();
  }

  function clearSelection() {
    ui.relationshipSelectedPlayerId = '';
    refreshSurface();
  }

  function selectSnapshot(snapshotId) {
    const normalizedSnapshotId = String(snapshotId ?? '');
    ui.relationshipSnapshotId = ui.store.getState().relationshipSnapshots.some((snapshot) => snapshot.id === normalizedSnapshotId)
      ? normalizedSnapshotId
      : '';
    ui.relationshipSelectedPlayerId = '';
    refreshSurface();
  }

  function toggleLayer(relationType) {
    const normalizedType = String(relationType ?? '');
    if (!isRelationshipLayerKey(normalizedType)) return;
    if (ui.relationshipVisibleRelationTypes.has(normalizedType)) ui.relationshipVisibleRelationTypes.delete(normalizedType);
    else ui.relationshipVisibleRelationTypes.add(normalizedType);
    refreshSurface();
  }

  return Object.freeze({
    open,
    refresh,
    selectPlayer,
    clearSelection,
    selectSnapshot,
    toggleLayer,
  });
}
