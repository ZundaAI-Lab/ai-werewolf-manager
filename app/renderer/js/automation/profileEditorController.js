/**
 * 責務: AIプロファイル選択、接続・応答・料金・生成工程タブの切替、接続設定編集、接続テスト、モデル一覧取得を所有する。
 * 変更ルール: 設定保存と画面遷移を独自実装せず、desktopAutomation.jsから渡された正式依存へ委譲する。AI管理全体のイベント振り分けを持たない。接続テストは自動実行running中にAI生成リソースと競合させず、外部プロバイダーへ実通信する直前だけprivacy/dataTransmissionNotice.jsの確認を要求する。外部/ローカル表示はshared/dataTransmissionPolicy.js由来のproviderDataRouteMetaを使用し、プロバイダー変更時に即時同期する。
 */

(function initializeAiWerewolfProfileEditorController(globalScope) {
  'use strict';

  function createProfileEditorController(context) {
    const {
      PROVIDER_DEFAULTS,
      PROVIDER_LABELS,
      apiErrorAsException,
      bridge,
      collectManagementForm,
      controller,
      discoveredModels,
      isAutomationAiRequestLocked,
      isCustomEndpointProvider,
      isLocalProvider,
      persistSettings,
      profileById,
      profileConfigurationStatus,
      providerDataRouteMeta,
      refreshVisibleUi,
      runtime,
    } = context;

    function switchProfileEditor(profileId) {
            if (!controller.settings.profiles.some((profile) => profile.id === profileId)) return;
            controller.selectedProfileId = profileId;
            document.querySelectorAll('[data-ai-profile-select]').forEach((button) => {
              const selected = button.dataset.aiProfileSelect === profileId;
              button.classList.toggle('is-selected', selected);
              button.setAttribute('aria-pressed', selected ? 'true' : 'false');
            });
            document.querySelectorAll('.ai-profile-card[data-ai-profile-id]').forEach((card) => {
              card.hidden = card.dataset.aiProfileId !== profileId;
            });
          }

    function switchProfileEditorTab(tabId) {
            if (!['connection', 'response', 'billing', 'generation'].includes(tabId)) return;
            controller.profileEditorTab = tabId;
            document.querySelectorAll('[data-ai-profile-tab]').forEach((button) => {
              const selected = button.dataset.aiProfileTab === tabId;
              button.classList.toggle('is-selected', selected);
              button.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
            document.querySelectorAll('[data-ai-profile-tab-panel]').forEach((panel) => {
              panel.hidden = panel.dataset.aiProfileTabPanel !== tabId;
            });
          }

    function updateProfileEditorPreview(card) {
            if (!card) return;
            const profileId = card.dataset.aiProfileId;
            const previous = profileById(profileId);
            const label = card.querySelector('[data-profile-setting="label"]')?.value.trim() || '名称未設定';
            const provider = card.querySelector('[data-profile-setting="provider"]')?.value ?? previous?.provider ?? 'demo';
            const model = card.querySelector('[data-profile-setting="model"]')?.value.trim() || 'モデル未設定';
            const enabled = card.querySelector('[data-profile-setting="enabled"]')?.checked ?? previous?.enabled ?? false;
            const endpoint = card.querySelector('[data-profile-setting="endpoint"]')?.value.trim() ?? previous?.endpoint ?? '';
            const enteredApiKey = Boolean(card.querySelector('[data-profile-setting="apiKey"]')?.value.trim());
            const clearApiKey = Boolean(card.querySelector('[data-profile-setting="clearApiKey"]')?.checked);
            const hasApiKey = enteredApiKey || (Boolean(previous?.hasApiKey) && !clearApiKey);
            const draft = { ...previous, label, provider, model: model === 'モデル未設定' ? '' : model, endpoint, enabled, hasApiKey };
            const status = profileConfigurationStatus(draft);
            const route = providerDataRouteMeta(provider);
            const listItem = document.querySelector(`[data-ai-profile-select="${CSS.escape(profileId)}"]`);
            const listLabel = listItem?.querySelector('[data-profile-list-label]');
            const listDescription = listItem?.querySelector('[data-profile-list-description]');
            const listStatus = listItem?.querySelector('[data-profile-list-status]');
            if (listLabel) listLabel.textContent = label;
            if (listDescription) listDescription.textContent = `${PROVIDER_LABELS[provider] ?? provider} / ${model} / ${route.label}`;
            if (listStatus) {
              listStatus.textContent = status.label;
              listStatus.className = `ai-profile-status is-${status.tone}`;
            }
            const editorLabel = card.querySelector('[data-profile-editor-label]');
            const editorProvider = card.querySelector('[data-profile-editor-provider]');
            const editorModel = card.querySelector('[data-profile-editor-model]');
            if (editorLabel) editorLabel.textContent = label;
            if (editorProvider) editorProvider.textContent = PROVIDER_LABELS[provider] ?? provider;
            if (editorModel) editorModel.textContent = model;
            const routeBadge = card.querySelector('[data-profile-editor-data-route]');
            if (routeBadge) {
              routeBadge.textContent = route.label;
              routeBadge.className = `ai-data-route-badge ${route.className}`;
              routeBadge.dataset.profileEditorDataRoute = '';
            }
            const routeBox = card.querySelector('[data-profile-data-route]');
            const routeBoxBadge = routeBox?.querySelector('.ai-data-route-badge');
            const routeHelp = routeBox?.querySelector('[data-profile-data-route-help]');
            if (routeBoxBadge) {
              routeBoxBadge.textContent = route.label;
              routeBoxBadge.className = `ai-data-route-badge ${route.className}`;
            }
            if (routeHelp) routeHelp.textContent = route.help;
          }

    async function testProfile(profileId, button) {
            if (isAutomationAiRequestLocked()) {
              runtime().toast('自動実行中は接続テストを実行できません。一時停止してから実行してください。', 'warning');
              return;
            }
            button.disabled = true;
            const original = button.textContent;
            button.textContent = '確認中…';
            try {
              const saved = collectManagementForm();
              await persistSettings(saved, { refresh: false });
              const profile = profileById(profileId);
              const dataNoticeAccepted = await globalScope.AiWerewolfDataTransmissionNotice?.ensureExternalDataNoticeForProfile?.(profile);
              if (dataNoticeAccepted === false) throw new Error('外部LLMへのデータ送信を開始しませんでした。');
              const result = await bridge.testProfile(profileId);
              if (result?.ok === false) throw apiErrorAsException(result.error ?? {});
              const diagnostics = result.diagnostics ?? {};
              const details = [];
              if (diagnostics.structuredJson) details.push(diagnostics.jsonObjectExtracted ? 'JSON補正成功' : 'JSON応答確認');
              if (diagnostics.authMode === 'none') details.push('認証なし');
              if (diagnostics.modelListed === true) details.push('モデル一覧一致');
              if (diagnostics.modelDiscoveryWarning) details.push('モデル一覧取得は未確認');
              runtime().toast(`接続成功: ${result.profile?.label ?? 'AIプロファイル'}${details.length ? `（${details.join('・')}）` : ''}`, diagnostics.modelDiscoveryWarning ? 'warning' : 'success');
            } catch (error) {
              runtime().toast(`接続失敗: ${error.message}`, 'error');
            } finally {
              window.dispatchEvent(new CustomEvent('ai-werewolf-usage-updated'));
              button.disabled = false;
              button.textContent = original;
              refreshVisibleUi();
            }
          }

    async function listProfileModels(profileId, button) {
            button.disabled = true;
            const original = button.textContent;
            button.textContent = '取得中…';
            try {
              await persistSettings(collectManagementForm(), { refresh: false });
              const result = await bridge.listProfileModels(profileId);
              if (result?.ok === false) throw apiErrorAsException(result.error ?? {});
              controller.discoveredModels.set(profileId, [...(result.models ?? [])]);
              const profile = profileById(profileId);
              if (profile && !profile.model && result.models?.[0]) {
                profile.model = result.models[0];
                await persistSettings({ ...controller.settings, profiles: controller.settings.profiles }, { refresh: false });
              }
              runtime().toast(`モデル取得成功: ${result.models.length}件${profile?.model ? ` / 選択中 ${profile.model}` : ''}`, 'success');
            } catch (error) {
              runtime().toast(`モデル取得失敗: ${error.message}`, 'error');
            } finally {
              button.disabled = false;
              button.textContent = original;
              refreshVisibleUi();
            }
          }

    function syncProfileProviderFields(card, provider) {
            const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS['openai-compatible'];
            const endpoint = card.querySelector('[data-profile-setting="endpoint"]');
            const model = card.querySelector('[data-profile-setting="model"]');
            const tokenField = card.querySelector('[data-compatible-token-field]');
            const endpointHelp = card.querySelector('[data-endpoint-help]');
            const presetField = card.querySelector('[data-local-server-preset]');
            const presetSelect = card.querySelector('[data-profile-setting="localServerPreset"]');
            const localSettings = card.querySelectorAll('[data-local-setting]');
            const ollamaSettings = card.querySelectorAll('[data-ollama-setting]');
            const localModelAction = card.querySelector('[data-local-model-action]');
            const apiKeyField = card.querySelector('.ai-api-key-field');
            const apiKeyLabel = apiKeyField?.querySelector(':scope > span');
            const apiKeyHelp = apiKeyField?.querySelector(':scope > small');
            const compatible = isCustomEndpointProvider(provider);
            const local = isLocalProvider(provider);
            endpoint.value = defaults.endpoint;
            endpoint.placeholder = defaults.endpoint;
            model.value = defaults.model;
            if (tokenField) tokenField.hidden = !compatible;
            if (presetField) presetField.hidden = !local;
            if (presetSelect && local) presetSelect.value = 'lm-studio';
            endpoint.readOnly = local ? true : !compatible;
            localSettings.forEach((field) => { field.hidden = !local; });
            ollamaSettings.forEach((field) => { field.hidden = !local || presetSelect?.value !== 'ollama'; });
            if (localModelAction) localModelAction.hidden = !local;
            if (apiKeyLabel) apiKeyLabel.textContent = local ? 'APIキー（任意）' : 'APIキー';
            if (apiKeyHelp) apiKeyHelp.textContent = local ? '未入力時はAuthorizationヘッダーを送信しません。' : '';
            const tokenSelect = card.querySelector('[data-profile-setting="chatTokenLimitField"]');
            if (tokenSelect) tokenSelect.value = local ? 'max_tokens' : provider === 'openai-compatible' ? 'max_completion_tokens' : tokenSelect.value;
            const contextWindow = card.querySelector('[data-profile-setting="contextWindowTokens"]');
            if (contextWindow && local) contextWindow.value = '32768';
            const jsonRequestMode = card.querySelector('[data-profile-setting="jsonRequestMode"]');
            if (jsonRequestMode && local) jsonRequestMode.value = 'json-object';
            const jsonResponseMode = card.querySelector('[data-profile-setting="jsonResponseMode"]');
            if (jsonResponseMode && local) jsonResponseMode.value = 'extract-object';
            if (endpointHelp) {
              endpointHelp.textContent = local
                ? '同じPCで動作するローカルLLMサーバーへ接続します。LM Studio・Ollama・llama.cpp・vLLM・LocalAIのOpenAI互換APIに対応します。'
                : compatible
                  ? '通信先にはHTTPSを使用してください。HTTPを許可するのはlocalhost・127.0.0.1・::1だけです。'
                  : '公式プロバイダーでは送信先を固定し、入力したAPIキーを別のホストへ送信しません。';
            }
          }

    return Object.freeze({
      switchProfileEditor,
      switchProfileEditorTab,
      updateProfileEditorPreview,
      testProfile,
      listProfileModels,
      syncProfileProviderFields,
    });
  }

  globalScope.AiWerewolfProfileEditorController = Object.freeze({ createProfileEditorController });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
