/**
 * 責務: AI設定保存、設定読込時のMain通知表示、参加者割り当て整合、プロファイル別使用量再読込、自動保存の遅延集約と終了前送信を所有する。
 * 変更ルール: ゲーム状態を直接変更せず、desktopAutomation.jsから渡された正式runtime・bridge・設定依存だけを使用する。設定読込通知はMainが返した構造化codeだけを表示へ変換し、永続設定へ混ぜない。自動保存はruntimeの専用スナップショットだけを取得し、通常時は短時間の変更を集約するが、最大待機時間と終了前flushを必ず設ける。処理本体をdesktopAutomation.jsへ戻さない。外部LLM確認は設定保存と分離し、実際に通信を開始する各ControllerとMain側Gateだけが担当する。
 */

const AUTOSAVE_DEBOUNCE_MS = 750;
const AUTOSAVE_MAX_WAIT_MS = 2000;

export function createSettingsPersistenceCoordinator(context) {
  const {
    bridge,
    controller,
    currentGameState,
    emptyUsage,
    firstEnabledProfileId,
    refreshVisibleUi,
    runtime,
    setStatus,
  } = context;

  let autosaveTimer = null;
  let autosaveWindowStartedAt = 0;
  let autosaveDirty = false;
  let autosaveWriteChain = Promise.resolve();

  function applyPromptHistorySetting() {
      runtime().setPublicHistoryTransmissionMode(controller.settings.aiOptions?.publicHistoryMode ?? 'delta');
    }

  function applyAiExecutionSettings() {
      runtime().setAiExecutionSettings(controller.settings);
    }

  async function refreshUsageSummary() {
      controller.persistedUsage = await bridge.getUsageSummary().catch(() => ({ totals: emptyUsage(), totalCostUsd: 0, profiles: {} }));
      runtime().refreshTab('ai-management');
    }

  function reportStartupSettingsNotices(notices) {
      for (const notice of Array.isArray(notices) ? notices : []) {
        const backupPath = String(notice?.backupPath ?? '').trim();
        const backupSuffix = backupPath ? ` バックアップ: ${backupPath}` : '';
        if (notice?.code === 'SETTINGS_PROFILE_ENDPOINT_UNAVAILABLE') {
          const label = String(notice.profileLabel ?? '').trim() || 'AIプロファイル';
          const reason = String(notice.reason ?? '').trim();
          runtime().toast(`${label}の接続先は現在の通信ルールでは使用できません。AI設定で接続先を更新してください。${reason ? ` ${reason}` : ''}`, 'warning', {
            key: `settings-endpoint-unavailable:${String(notice.profileId ?? '')}`,
            durationMs: 0,
            forceDisplay: true,
            source: 'settings-startup',
          });
          continue;
        }
        if (notice?.code === 'SETTINGS_UNSUPPORTED_SCHEMA') {
          const sourceVersion = Number.isInteger(notice.sourceSchemaVersion) ? notice.sourceSchemaVersion : '不明';
          const currentVersion = Number.isInteger(notice.currentSchemaVersion) ? notice.currentSchemaVersion : '不明';
          runtime().toast(`以前または別バージョンのAI設定（schema ${sourceVersion}）は現在のschema ${currentVersion}では読み込めません。既定設定で起動しました。${backupSuffix}`, 'error', {
            key: 'settings-load-failure',
            durationMs: 0,
            forceDisplay: true,
            source: 'settings-startup',
          });
          continue;
        }
        if (notice?.code === 'SETTINGS_INVALID_JSON') {
          runtime().toast(`AI設定ファイルのJSONが壊れているため、既定設定で起動しました。${backupSuffix}`, 'error', {
            key: 'settings-load-failure',
            durationMs: 0,
            forceDisplay: true,
            source: 'settings-startup',
          });
          continue;
        }
        if (notice?.code === 'SETTINGS_LOAD_FAILED_READ_ONLY') {
          runtime().toast('AI設定を読み込めず、元ファイルの退避にも失敗したため、この起動中はAI設定を保存できません。アプリを終了してdesktop-settings.jsonを確認してください。', 'error', {
            key: 'settings-load-failure',
            durationMs: 0,
            forceDisplay: true,
            source: 'settings-startup',
          });
          continue;
        }
        if (notice?.code === 'SETTINGS_UNREADABLE') {
          runtime().toast(`AI設定を解釈できないため、既定設定で起動しました。${backupSuffix}`, 'error', {
            key: 'settings-load-failure',
            durationMs: 0,
            forceDisplay: true,
            source: 'settings-startup',
          });
        }
      }
    }

  async function persistSettings(settings, { refresh = true, statusMessage = '' } = {}) {
      const previousSettings = controller.settings;
      const savedSettings = await bridge.saveSettings(settings);
      const previousById = new Map((previousSettings?.profiles ?? []).map((profile) => [profile.id, profile]));
      const invalidatedKeyProfiles = (savedSettings.profiles ?? []).filter((profile) => {
        const previous = previousById.get(profile.id);
        return previous
          && previous.provider === profile.provider
          && previous.endpoint !== profile.endpoint
          && previous.hasApiKey === true
          && profile.hasApiKey === false;
      });
      controller.settings = savedSettings;
      applyPromptHistorySetting();
      applyAiExecutionSettings();
      if (refresh) refreshVisibleUi();
      if (statusMessage) setStatus(statusMessage, 'success');
      if (invalidatedKeyProfiles.length) {
        const labels = invalidatedKeyProfiles.map((profile) => profile.label).filter(Boolean).join('、');
        runtime().toast(`${labels || 'AIプロファイル'}の接続先を変更したため、APIキーを再入力してください。`, 'warning');
      }
      return controller.settings;
    }

  async function reconcileAssignments() {
      const state = currentGameState();
      if (!state?.players) return;
      const currentIds = new Set(state.players.map((player) => player.id));
      const assignments = Object.fromEntries(Object.entries(controller.settings.assignments ?? {}).filter(([playerId]) => currentIds.has(playerId)));
      const fallback = firstEnabledProfileId();
      let changed = Object.keys(assignments).length !== Object.keys(controller.settings.assignments ?? {}).length;
      state.players.forEach((player) => {
        if (Object.hasOwn(assignments, player.id)) return;
        assignments[player.id] = fallback;
        changed = true;
      });
      if (!changed) return;
      await persistSettings({ ...controller.settings, assignments }, { refresh: true });
    }

  function setManagementDirty(dirty) {
      const saveBar = document.querySelector('[data-ai-management-save]');
      if (saveBar) saveBar.hidden = !dirty;
      const indicator = document.querySelector('[data-ai-save-indicator]');
      if (indicator) {
        indicator.textContent = dirty ? '未保存の変更あり' : '保存済み';
        indicator.classList.toggle('is-dirty', dirty);
      }
    }

  function cancelAutosaveTimer() {
      if (autosaveTimer !== null) clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }

  function updateAutosaveIndicator() {
      const indicator = document.querySelector('#desktop-save-indicator');
      if (indicator) indicator.textContent = `自動保存 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }

  function enqueueAutosaveSnapshot() {
      const snapshot = runtime().getAutosaveState();
      const operation = autosaveWriteChain
        .catch(() => {})
        .then(() => bridge.saveAutosave(snapshot));
      autosaveWriteChain = operation;
      return operation;
    }

  async function flushAutosave({ force = false, reportError = true } = {}) {
      if (!bridge.isDesktop || typeof runtime().getAutosaveState !== 'function') return;
      if (force) autosaveDirty = true;
      try {
        while (autosaveDirty) {
          cancelAutosaveTimer();
          autosaveWindowStartedAt = 0;
          autosaveDirty = false;
          try {
            await enqueueAutosaveSnapshot();
            updateAutosaveIndicator();
          } catch (error) {
            autosaveDirty = true;
            throw error;
          }
        }
        await autosaveWriteChain;
      } catch (error) {
        if (reportError) setStatus(`自動保存失敗: ${error.message}`, 'error');
        throw error;
      }
    }

  function scheduleAutosave() {
      if (!bridge.isDesktop || typeof runtime().getAutosaveState !== 'function') return;
      autosaveDirty = true;
      const now = Date.now();
      if (!autosaveWindowStartedAt) autosaveWindowStartedAt = now;
      cancelAutosaveTimer();
      const remainingUntilMaximum = Math.max(0, AUTOSAVE_MAX_WAIT_MS - (now - autosaveWindowStartedAt));
      const delayMs = Math.min(AUTOSAVE_DEBOUNCE_MS, remainingUntilMaximum);
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        flushAutosave().catch(() => {});
      }, delayMs);
    }

  if (bridge.isDesktop && typeof bridge.registerAutosaveFlushHandler === 'function') {
    bridge.registerAutosaveFlushHandler(() => flushAutosave({ force: true, reportError: false }));
  }

  return Object.freeze({
    applyPromptHistorySetting,
    applyAiExecutionSettings,
    reportStartupSettingsNotices,
    refreshUsageSummary,
    persistSettings,
    reconcileAssignments,
    setManagementDirty,
    scheduleAutosave,
    flushAutosave,
  });
}
