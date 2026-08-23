/**
 * 責務: 進行卓ダイアログ・独立ウィンドウ・記録画面で共有するプレイヤー相関図の閲覧状態と外部表示面を所有する。
 * 変更ルール: 相関モデルや公開／機密判定を独自実装せずplayerRelationshipViewへ委譲する。選択・スナップショット・表示レイヤーは全表示面で同じUI状態を共有する。独立ウィンドウは相関図専用の閲覧面でありゲーム状態を保持せず、親画面のStore更新・機密表示切替・外観変更に追従して再描画する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { applyManagementAppearance } from '../../appearance/appearanceTheme.js';
import { escapeHtml } from '../../shared/utils.js';
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

  let relationshipWindow = null;

  function relationshipViewHtml() {
    return renderPlayerRelationshipView({
      state: ui.store.getState(),
      showConfidential: ui.showConfidential,
      selectedPlayerId: ui.relationshipSelectedPlayerId,
      selectedSnapshotId: ui.relationshipSnapshotId,
      visibleRelationTypes: [...ui.relationshipVisibleRelationTypes],
      getRoleName,
    });
  }

  function renderDialog() {
    const dialog = ui.relationshipDialog;
    if (!dialog) return;
    dialog.innerHTML = `<div class="modal-header"><div><span class="eyebrow">進行確認</span><h3>プレイヤー相関図</h3></div><div class="relationship-modal-actions"><button class="button ghost small" data-action="open-player-relationship-window" type="button">別ウィンドウで開く</button><button class="button icon ghost" data-modal-close type="button" aria-label="閉じる">×</button></div></div><div class="modal-body relationship-dialog-body">${relationshipViewHtml()}</div>`;
  }

  function renderWindow() {
    if (!relationshipWindow || relationshipWindow.closed) return;
    const root = relationshipWindow.document.querySelector('#relationship-window-root');
    if (!root) return;
    applyManagementAppearance(ui.getAppearance(), relationshipWindow.document);
    root.innerHTML = relationshipViewHtml();
  }

  function refreshExternalSurfaces() {
    if (ui.relationshipDialog?.open) renderDialog();
    renderWindow();
  }

  function refreshSurface() {
    if (ui.activeTab === 'records' && ui.recordsViewMode === 'relationship') {
      ui.render();
      return;
    }
    refreshExternalSurfaces();
  }

  function open() {
    if (!ui.relationshipDialog) throw new Error('プレイヤー相関図ダイアログを利用できません。');
    ui.relationshipSelectedPlayerId = '';
    ui.relationshipSnapshotId = '';
    renderDialog();
    if (!ui.relationshipDialog.open) ui.relationshipDialog.showModal();
  }

  function handleWindowClick(event) {
    // 独立ウィンドウでも本体と同じdata-action契約を使う。
    // SVGのプレイヤーカードはbuttonではなく<g data-action>なので、button限定に戻すとカード選択強調が失われる。
    const actionTarget = event.target?.closest?.('[data-action]');
    if (!actionTarget || actionTarget.matches?.('button:disabled')) return;
    const action = actionTarget.dataset.action;
    if (action === 'relationship-select-player') selectPlayer(actionTarget.dataset.playerId);
    else if (action === 'relationship-clear-selection') clearSelection();
    else if (action === 'relationship-select-snapshot') selectSnapshot(actionTarget.dataset.snapshotId);
    else if (action === 'relationship-toggle-layer') toggleLayer(actionTarget.dataset.relationType);
  }

  function openWindow() {
    if (!relationshipWindow || relationshipWindow.closed) {
      relationshipWindow = window.open('', 'ai-werewolf-relationship', 'width=1440,height=900');
      if (!relationshipWindow) {
        ui.toast('ポップアップがブロックされました。', 'error');
        return;
      }
      const cssUrl = escapeHtml(new URL('./css/styles.css', window.location.href).href);
      relationshipWindow.document.write(`<!doctype html>
<html lang="ja" class="standalone-relationship-document">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <title>AI人狼 プレイヤー相関図</title>
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body class="standalone-relationship">
  <main id="relationship-window-root"></main>
</body>
</html>`);
      relationshipWindow.document.close();
      relationshipWindow.document.addEventListener('click', handleWindowClick);
      try { relationshipWindow.opener = null; } catch {}
    }
    renderWindow();
    relationshipWindow.focus();
    // ダイアログから独立ウィンドウへ移した場合は、同じ相関図を二重表示しない。
    // ポップアップ生成失敗時はここへ到達しないため、元ダイアログをそのまま残す。
    if (ui.relationshipDialog?.open) ui.relationshipDialog.close();
  }

  function refresh() {
    refreshExternalSurfaces();
  }

  function refreshAppearance() {
    if (!relationshipWindow || relationshipWindow.closed) return;
    applyManagementAppearance(ui.getAppearance(), relationshipWindow.document);
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
    openWindow,
    refresh,
    refreshAppearance,
    selectPlayer,
    clearSelection,
    selectSnapshot,
    toggleLayer,
  });
}
