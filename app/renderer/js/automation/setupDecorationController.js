/**
 * 責務: ゲーム準備画面へのAI割り当て表示、一括プロファイル適用UI、可視画面更新を所有する。
 * 変更ルール: ゲーム状態を直接変更せず、desktopAutomation.jsから渡された正式runtime・bridge・設定依存だけを使用する。グローバルメニューと重複する画面遷移ボタンは準備画面へ追加しない。AIプロファイルの保存・一括割り当て処理は既存のassignment／AI管理Controllerへ委譲し、本モジュールは準備画面上の表示だけを担当する。一括適用UIは操作中のselectを再生成せず局所同期し、ネイティブのコンボボックス操作を妨げない。処理本体をdesktopAutomation.jsへ戻さない。
 */

(function initializeAiWerewolfSetupDecorationController(globalScope) {
  'use strict';

  function createSetupDecorationController(context) {
    const {
      activeTab,
      assignmentValidation,
      controller,
      currentGameState,
      escapeHtml,
      isManagementTabActive,
      playerProfileSelectHtml,
      runtime,
    } = context;

    function decorateSetupView() {
        if (activeTab() !== 'setup') return;
        const list = document.querySelector('#app-content .player-editor-list');
        if (!list) return;
        const pageHead = document.querySelector('#app-content .page-head');
        const heading = pageHead?.querySelector('h2');
        if (heading && heading.textContent !== 'ゲーム準備') heading.textContent = 'ゲーム準備';
        const description = pageHead?.querySelector('p');
        if (description && description.textContent !== '参加者、担当、AIプロファイル、配役、ルールを一つの画面で確認します。') description.textContent = '参加者、担当、AIプロファイル、配役、ルールを一つの画面で確認します。';
        const participantPanel = list.closest('.panel');
        const participantTitle = participantPanel?.querySelector('.panel-title-row h3');
        if (participantTitle && participantTitle.textContent !== '参加者・キャラクター・担当・AI・配役') participantTitle.textContent = '参加者・キャラクター・担当・AI・配役';
        const state = currentGameState();
        if (participantPanel) {
          let note = participantPanel.querySelector('.setup-ai-mode-note');
          if (!note) {
            note = document.createElement('p');
            note.className = 'setup-ai-mode-note';
            list.insertAdjacentElement('beforebegin', note);
          }
          const nextText = controller.settings.executionMode === 'manual'
            ? '現在は手動プロンプト方式です。AI担当者は進行卓でプロンプトをコピーし、回答JSONを貼り付けて進めます。'
            : '現在は自動API実行です。AIプロファイル未設定の参加者は、その番だけ手動生成画面へ切り替わり、回答登録後に全自動進行へ戻ります。';
          if (note.textContent !== nextText) note.textContent = nextText;

          const automatic = controller.settings.executionMode !== 'manual';
          const locked = state?.game?.phase !== 'setup';
          const aiPlayers = (state?.players ?? []).filter((player) => player.controller === 'ai');
          const selectedBulkProfileId = controller.bulkAssignmentProfileId ?? '';
          const profileOptionSignature = JSON.stringify(controller.settings.profiles.map((profile) => [profile.id, profile.label, profile.enabled]));
          const profileOptions = controller.settings.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selectedBulkProfileId ? ' selected' : ''}>${escapeHtml(profile.label)}${profile.enabled ? '' : '（無効）'}</option>`).join('');
          const bulkHtml = `<div class="ai-bulk-assignment setup-ai-bulk-assignment" data-setup-ai-bulk-assignment>
            <span class="ai-bulk-assignment-label">AIプロファイル一括適用</span>
            <div class="ai-bulk-assignment-controls"><select id="ai-bulk-profile" data-ai-bulk-scope="setup" data-profile-option-signature="${escapeHtml(profileOptionSignature)}" aria-label="AI参加者へ一括設定するプロファイル" ${automatic && !locked ? '' : 'disabled'}><option value="">プロファイルを選択</option>${profileOptions}</select><button class="button ghost" data-ai-action="bulk-assign" type="button" ${automatic && !locked && aiPlayers.length ? '' : 'disabled'}>全AI参加者へ適用</button></div>
            <p class="ai-bulk-assignment-note" data-setup-ai-bulk-note>AI参加者${aiPlayers.length}名の個別割り当てを、選択したプロファイルで上書きします。</p>
            <div class="ai-bulk-assignment-feedback" data-ai-bulk-feedback hidden aria-live="polite"></div>
          </div>`;
          const currentBulk = participantPanel.querySelector('[data-setup-ai-bulk-assignment]');
          if (!currentBulk) note.insertAdjacentHTML('afterend', bulkHtml);
          else {
            const bulkSelect = currentBulk.querySelector('#ai-bulk-profile');
            const bulkButton = currentBulk.querySelector('[data-ai-action="bulk-assign"]');
            const bulkNote = currentBulk.querySelector('[data-setup-ai-bulk-note]');
            const selectEnabled = automatic && !locked;
            const buttonEnabled = selectEnabled && aiPlayers.length > 0;
            if (bulkSelect) {
              if (bulkSelect.disabled === selectEnabled) bulkSelect.disabled = !selectEnabled;
              if (bulkSelect.dataset.profileOptionSignature !== profileOptionSignature) {
                const selectedValue = document.activeElement === bulkSelect ? bulkSelect.value : selectedBulkProfileId;
                bulkSelect.innerHTML = `<option value="">プロファイルを選択</option>${controller.settings.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}${profile.enabled ? '' : '（無効）'}</option>`).join('')}`;
                bulkSelect.dataset.profileOptionSignature = profileOptionSignature;
                bulkSelect.value = controller.settings.profiles.some((profile) => profile.id === selectedValue) ? selectedValue : '';
              } else if (document.activeElement !== bulkSelect && bulkSelect.value !== selectedBulkProfileId) {
                bulkSelect.value = selectedBulkProfileId;
              }
            }
            if (bulkButton && bulkButton.disabled === buttonEnabled) bulkButton.disabled = !buttonEnabled;
            const nextBulkNote = `AI参加者${aiPlayers.length}名の個別割り当てを、選択したプロファイルで上書きします。`;
            if (bulkNote && bulkNote.textContent !== nextBulkNote) bulkNote.textContent = nextBulkNote;
          }
        }
        const head = list.querySelector('.player-editor-head');
        if (head && !head.querySelector('.ai-profile-column-head')) {
          const roleHeading = [...head.children].find((item) => item.textContent.trim() === '役職');
          const label = document.createElement('span');
          label.className = 'ai-profile-column-head';
          label.textContent = 'AIプロファイル';
          head.insertBefore(label, roleHeading ?? null);
        }
        for (const player of state?.players ?? []) {
          const playerId = CSS.escape(player.id);
          const controllerSelect = list.querySelector(`[data-player-field="controller"][data-player-id="${playerId}"]`);
          const row = controllerSelect?.closest('.player-editor');
          if (!row) continue;
          const wrapper = document.createElement('div');
          wrapper.innerHTML = playerProfileSelectHtml(player, state.game?.phase !== 'setup');
          const nextSelect = wrapper.firstElementChild;
          const currentSelect = row.querySelector(`[data-ai-profile-player-id="${playerId}"]`);
          if (!currentSelect) controllerSelect.insertAdjacentElement('afterend', nextSelect);
          else if (currentSelect.outerHTML !== nextSelect.outerHTML) currentSelect.replaceWith(nextSelect);
        }
        const validation = assignmentValidation(state);
        const panels = [...document.querySelectorAll('#app-content .panel')];
        const validationPanel = panels.find((panel) => panel.querySelector(':scope > h3')?.textContent.trim() === '開始前確認');
        if (validationPanel) {
          const button = validationPanel.querySelector('[data-action="start-game"]');
          const messages = validation.ok
            ? [controller.settings.executionMode === 'manual' ? '✓ 手動プロンプト方式で開始できます。' : '✓ AI参加者はAPI実行または参加者別の手動生成で開始できます。']
            : validation.errors.map((message) => `× ${message}`);
          const signature = JSON.stringify({ ok: validation.ok, messages });
          let validationList = validationPanel.querySelector('.desktop-ai-validation-list');
          if (!validationList) {
            validationList = document.createElement('div');
            validationList.className = 'desktop-ai-validation-list';
            validationPanel.insertBefore(validationList, button ?? null);
          }
          if (validationList.dataset.signature !== signature) {
            validationList.dataset.signature = signature;
            validationList.innerHTML = messages.map((message) => `<div class="validation desktop-ai-validation ${validation.ok ? 'success' : 'error'}">${escapeHtml(message)}</div>`).join('');
          }
          if (button) {
            if (!Object.hasOwn(button.dataset, 'gameValidationDisabled')) button.dataset.gameValidationDisabled = button.disabled ? 'true' : 'false';
            const shouldDisable = button.dataset.gameValidationDisabled === 'true' || !validation.ok;
            if (button.disabled !== shouldDisable) button.disabled = shouldDisable;
          }
        }
      }

    function scheduleSetupDecoration() {
        window.clearTimeout(controller.setupDecorationTimer);
        controller.setupDecorationTimer = window.setTimeout(() => {
          controller.setupDecorationTimer = null;
          decorateSetupView();
        }, 0);
      }

    function refreshVisibleUi() {
        if (isManagementTabActive()) runtime().refreshTab('ai-management');
        else if (activeTab() === 'setup') scheduleSetupDecoration();
      }

    return Object.freeze({
      decorateSetupView,
      scheduleSetupDecoration,
      refreshVisibleUi,
    });
  }

  globalScope.AiWerewolfSetupDecorationController = Object.freeze({ createSetupDecorationController });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
