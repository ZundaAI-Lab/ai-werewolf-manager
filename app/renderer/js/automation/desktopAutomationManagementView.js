/**
 * 責務: AI管理画面のプロファイル一覧・編集、JSON転送操作、料金・プロファイル利用上限、参加者割り当て、実行オプション、プロファイル別使用量、外部/ローカル送信経路、AI通信プライバシー案内、準備状態のHTML生成と表示中フォーム収集を担当する。
 * 変更ルール: ゲーム状態や設定を保存せず、controllerの現在値を表示・収集するだけにする。外部/ローカル判定はshared/dataTransmissionPolicy.jsを正本とし、確認状態の保存や通信可否判定は行わない。プロファイル順序はsettings.profiles、正式タブ描画はAppUIを正本とする。
 */

export function createManagementView({
  controller,
  bridge,
  config,
  localLlmConfig,
  currentGameState,
  profileById,
  assignedProfileId,
  runtime,
  responseRetryPolicy,
  responseRecoveryModeOptions,
  getPhaseLabels,
  escapeHtml,
  endpointPolicy,
  dataTransmissionPolicy,
}) {
  const {
    SETTINGS_SCHEMA_VERSION,
    PROVIDER_LABELS,
    OLLAMA_THINKING_LEVEL_LABELS,
    PROVIDER_DEFAULTS,
    GENERATION_TASK_OVERRIDE_DEFS,
    GENERATION_DEPTH_DEFS,
    generationSummary,
    generationSectionHtml,
    normalizeGenerationSettings,
    emptyUsage,
  } = config;
  const { DEFAULT_OLLAMA_THINKING_LEVEL, LOCAL_OPENAI_PROVIDER, LOCAL_SERVER_PRESETS, OLLAMA_THINKING_LEVELS } = localLlmConfig;
  if (!responseRetryPolicy?.normalizeRecoveryMode) {
    throw new Error('AI応答修復ポリシーをAI管理画面へ接続できませんでした。');
  }
  if (!endpointPolicy?.validateEndpoint) throw new Error('共通エンドポイント検証PolicyをAI管理画面へ接続できませんでした。');
  if (!dataTransmissionPolicy?.providerDataRoute) throw new Error('AIデータ送信PolicyをAI管理画面へ接続できませんでした。');

  function createProfileId() {
    if (globalThis.crypto?.randomUUID) return `profile-${globalThis.crypto.randomUUID()}`;
    return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function providerOptions(selectedProvider) {
    return Object.entries(PROVIDER_LABELS)
      .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selectedProvider ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('');
  }

  function isLocalProvider(provider) {
    return provider === LOCAL_OPENAI_PROVIDER;
  }

  function isCustomEndpointProvider(provider) {
    return provider === 'openai-compatible' || isLocalProvider(provider);
  }

  function providerDataRouteMeta(provider) {
    const route = dataTransmissionPolicy.providerDataRoute(provider);
    if (route === 'local') return { route, label: 'ローカル処理', help: '同一PCのループバック接続先だけを使用します。', className: 'is-local' };
    if (route === 'demo') return { route, label: 'アプリ内デモ', help: '外部LLM APIへゲーム・チャット内容を送信しません。', className: 'is-demo' };
    return { route, label: '外部送信', help: 'AI生成に必要な名前・会話・ゲーム状態などが、このプロバイダーまたは接続先へ送信されます。', className: 'is-external' };
  }

  function providerDataRouteBadgeHtml(provider, attribute = '') {
    const meta = providerDataRouteMeta(provider);
    return `<span class="ai-data-route-badge ${meta.className}"${attribute ? ` ${attribute}` : ''}>${escapeHtml(meta.label)}</span>`;
  }

  function localServerPresetOptions(selectedPreset) {
    return Object.entries(LOCAL_SERVER_PRESETS)
      .map(([value, preset]) => `<option value="${escapeHtml(value)}"${value === selectedPreset ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`)
      .join('');
  }

  function discoveredModels(profileId) {
    return controller.discoveredModels.get(profileId) ?? [];
  }

  function modelDatalistHtml(profile) {
    const models = discoveredModels(profile.id);
    if (!models.length) return '';
    return `<datalist id="model-list-${escapeHtml(profile.id)}">${models.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist>`;
  }

  function enabledProfiles() {
    return controller.settings.profiles.filter((profile) => profile.enabled);
  }

  function firstEnabledProfileId() {
    return enabledProfiles()[0]?.id ?? null;
  }

  function bulkAssignmentProfileId() {
    const profiles = controller.settings.profiles ?? [];
    const selected = controller.bulkAssignmentProfileId;
    if (selected && profiles.some((profile) => profile.id === selected)) return selected;
    const fallback = firstEnabledProfileId() ?? profiles[0]?.id ?? '';
    controller.bulkAssignmentProfileId = fallback;
    return fallback;
  }

  function compatibleEndpointValidationMessage(profile) {
    if (!isCustomEndpointProvider(profile?.provider)) return '';
    return endpointPolicy.validateEndpoint(profile?.endpoint, { requireLoopback: isLocalProvider(profile?.provider) }).message;
  }

  function assignmentValidation(state = currentGameState()) {
    if (controller.settings.executionMode === 'manual') return { ok: true, errors: [] };
    const errors = [];
    for (const player of state?.players ?? []) {
      if (player.controller !== 'ai') continue;
      const profileId = assignedProfileId(player.id);
      if (!profileId) continue;
      const profile = profileById(profileId);
      if (!profile) {
        errors.push(`${player.name}: 指定されたAIプロファイルが存在しません。`);
        continue;
      }
      if (!profile.enabled) errors.push(`${player.name}: 「${profile.label}」は無効です。`);
      if (!profile.model?.trim()) errors.push(`${player.name}: 「${profile.label}」のモデルIDが未設定です。`);
      if (!['demo', LOCAL_OPENAI_PROVIDER].includes(profile.provider) && !profile.hasApiKey) errors.push(`${player.name}: 「${profile.label}」のAPIキーが未設定です。`);
      if (isLocalProvider(profile.provider) && Number(profile.contextWindowTokens ?? 0) < Number(profile.maxOutputTokens ?? 0) + 512) errors.push(`${player.name}: 「${profile.label}」のコンテキスト長は最大出力トークンより512以上大きくしてください。`);
      const endpointError = compatibleEndpointValidationMessage(profile);
      if (endpointError) errors.push(`${player.name}: 「${profile.label}」の${endpointError}`);
      if (!bridge.isDesktop && profile.provider !== 'demo') errors.push(`${player.name}: 実APIはElectron版でのみ使用できます。`);
    }
    return { ok: errors.length === 0, errors };
  }

  function playerProfileSelectHtml(player, locked = false) {
    const assigned = controller.settings.assignments?.[player.id] ?? '';
    const isHuman = player.controller !== 'ai';
    const options = controller.settings.profiles.map((profile) => {
      const suffix = profile.enabled ? '' : '（無効）';
      return `<option value="${escapeHtml(profile.id)}"${profile.id === assigned ? ' selected' : ''}>${escapeHtml(profile.label)}${suffix}</option>`;
    }).join('');
    const manual = controller.settings.executionMode === 'manual';
    const placeholder = isHuman ? '人間操作' : manual ? '手動プロンプト' : '未設定（手動生成）';
    return `<select class="ai-profile-select" data-ai-profile-player-id="${escapeHtml(player.id)}" data-ai-profile-assignable="${isHuman ? 'false' : 'true'}" data-ai-profile-locked="${locked ? 'true' : 'false'}" ${locked || isHuman || manual ? 'disabled' : ''}><option value=""${assigned ? '' : ' selected'}>${placeholder}</option>${options}</select>`;
  }

  function renderAssignmentValidation(state, locked = false) {
    if (locked) return '';
    const validation = assignmentValidation(state);
    if (validation.ok) return '<div class="validation success">✓ AI参加者はAPI実行または参加者別の手動生成で開始できます。</div>';
    return validation.errors.map((message) => `<div class="validation error">× ${escapeHtml(message)}</div>`).join('');
  }

  function canStartWithAiProfiles(state) {
    return assignmentValidation(state).ok;
  }

  function isCompatibleEndpointProvider(provider) {
    return isCustomEndpointProvider(provider);
  }

  function ollamaThinkingOptionsHtml(current) {
    const selected = OLLAMA_THINKING_LEVELS.includes(current)
      ? current
      : DEFAULT_OLLAMA_THINKING_LEVEL;
    return OLLAMA_THINKING_LEVELS
      .map((level) => `<option value="${level}"${selected === level ? ' selected' : ''}>${OLLAMA_THINKING_LEVEL_LABELS[level]}</option>`)
      .join('');
  }

  function profileConfigurationStatus(profile) {
    if (!profile.enabled) return { label: '無効', tone: 'muted' };
    if (profile.provider === 'demo') return { label: '利用可能', tone: 'ready' };
    if (!String(profile.model ?? '').trim()) return { label: 'モデル未設定', tone: 'warning' };
    if (isCustomEndpointProvider(profile.provider) && !String(profile.endpoint ?? '').trim()) return { label: '接続先未設定', tone: 'warning' };
    if (!['demo', LOCAL_OPENAI_PROVIDER].includes(profile.provider) && !profile.hasApiKey) return { label: 'APIキー未設定', tone: 'warning' };
    const billing = billingSettings(profile);
    if (billing.profileBudgetUsd > 0 && [billing.inputUsdPerMillion, billing.cachedInputUsdPerMillion, billing.cacheWriteUsdPerMillion, billing.outputUsdPerMillion].every((value) => Number(value) === 0)) {
      return { label: '単価未設定', tone: 'warning' };
    }
    return { label: '設定済み', tone: 'ready' };
  }

  function reorderedProfiles(profiles, profileId, offset) {
    const next = [...profiles];
    const index = next.findIndex((profile) => profile.id === profileId);
    const target = index + Number(offset);
    if (index < 0 || target < 0 || target >= next.length || target === index) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  function activeProfileId() {
    const profiles = controller.settings.profiles ?? [];
    if (profiles.some((profile) => profile.id === controller.selectedProfileId)) return controller.selectedProfileId;
    controller.selectedProfileId = profiles[0]?.id ?? null;
    return controller.selectedProfileId;
  }

  function profileListItemHtml(profile, selectedProfileId) {
    const status = profileConfigurationStatus(profile);
    return `<button class="ai-profile-list-item${profile.id === selectedProfileId ? ' is-selected' : ''}" data-ai-profile-select="${escapeHtml(profile.id)}" type="button" aria-pressed="${profile.id === selectedProfileId ? 'true' : 'false'}">
      <span class="ai-profile-list-copy"><strong data-profile-list-label>${escapeHtml(profile.label)}</strong><small data-profile-list-description>${escapeHtml(PROVIDER_LABELS[profile.provider] ?? profile.provider)} / ${escapeHtml(profile.model || 'モデル未設定')} / ${escapeHtml(providerDataRouteMeta(profile.provider).label)}</small></span>
      <span class="ai-profile-status is-${escapeHtml(status.tone)}" data-profile-list-status>${escapeHtml(status.label)}</span>
    </button>`;
  }

  function profileEditorTabButton(tabId, label) {
    const selected = controller.profileEditorTab === tabId;
    return `<button class="ai-profile-tab${selected ? ' is-selected' : ''}" data-ai-profile-tab="${tabId}" type="button" role="tab" aria-selected="${selected ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
  }

  function generationTestStageCardHtml(stage, index) {
    const statusClass = ['accepted', 'applied', 'fallback', 'skipped'].includes(stage.status) ? stage.status : 'error';
    const changeLabel = stage.status === 'fallback'
      ? '前工程の文章を継続'
      : stage.status === 'skipped'
        ? 'このタスクでは実行しない'
        : index === 0
          ? '最初の回答候補'
          : stage.changed
            ? '前工程から文章を変更'
            : '前工程から文章の変更なし';
    const rawDetails = stage.rawResponse
      ? `<details class="ai-generation-stage-raw"><summary>この工程のAI生回答を表示</summary><pre>${escapeHtml(stage.rawResponse)}</pre></details>`
      : '';
    return `<article class="ai-generation-stage-card is-${statusClass}">
      <header class="ai-generation-stage-card-head">
        <span class="ai-generation-stage-number">工程${index + 1}</span>
        <strong>${escapeHtml(stage.label)}</strong>
        <span class="ai-generation-stage-status">${escapeHtml(stage.statusLabel)}</span>
      </header>
      <p class="ai-generation-stage-executor">担当: ${escapeHtml(stage.executorLabel)}</p>
      <div class="ai-generation-stage-answer">
        <span>${escapeHtml(stage.answerLabel)}</span>
        <p>${escapeHtml(stage.answerText || '表示できる回答文章はありません。')}</p>
      </div>
      <footer class="ai-generation-stage-meta"><span>${escapeHtml(changeLabel)}</span><span>${Number(stage.answerLength ?? 0).toLocaleString('ja-JP')}文字</span></footer>
      ${stage.issueText ? `<p class="ai-generation-stage-issue">${escapeHtml(stage.issueText)}</p>` : ''}
      ${rawDetails}
    </article>`;
  }

  function generationTestResultHtml(generationTest) {
    if (!generationTest) return '';
    const status = escapeHtml(generationTest.status ?? (generationTest.ok ? 'success' : 'error'));
    const stages = Array.isArray(generationTest.stages) ? generationTest.stages : [];
    return `<div class="ai-generation-test-result ${status}">
      <div class="ai-generation-test-head"><strong>生成工程テスト</strong><span>${stages.length ? `${stages.length}工程の回答を比較` : '実行結果'}</span></div>
      <div class="ai-generation-test-summary">${generationTest.lines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>
      ${stages.length ? `<div class="ai-generation-stage-comparison" aria-label="工程ごとの回答比較">${stages.map(generationTestStageCardHtml).join('')}</div>` : ''}
    </div>`;
  }

  function formatUsd(value, digits = 6) {
    const amount = Number(value ?? 0);
    return `$${(Number.isFinite(amount) ? Math.max(0, amount) : 0).toFixed(digits)}`;
  }

  function profileUsage(profileId) {
    return controller.persistedUsage?.profiles?.[profileId] ?? emptyUsage();
  }

  function billingSettings(profile) {
    return {
      inputUsdPerMillion: Number(profile?.billing?.inputUsdPerMillion ?? 0),
      cachedInputUsdPerMillion: Number(profile?.billing?.cachedInputUsdPerMillion ?? 0),
      cacheWriteUsdPerMillion: Number(profile?.billing?.cacheWriteUsdPerMillion ?? 0),
      outputUsdPerMillion: Number(profile?.billing?.outputUsdPerMillion ?? 0),
      profileBudgetUsd: Number(profile?.billing?.profileBudgetUsd ?? 0),
    };
  }

  function billingPanelHtml(profile) {
    const billing = billingSettings(profile);
    const usage = profileUsage(profile.id);
    const spent = Number(usage.costUsd ?? 0);
    const limit = Number(billing.profileBudgetUsd ?? 0);
    const limited = Number.isFinite(limit) && limit > 0;
    const remaining = limited ? Math.max(0, limit - spent) : null;
    const percentage = limited ? Math.max(0, Math.min(100, limit ? spent / limit * 100 : 0)) : 0;
    const pricingMissing = limited && [billing.inputUsdPerMillion, billing.cachedInputUsdPerMillion, billing.cacheWriteUsdPerMillion, billing.outputUsdPerMillion].every((value) => Number(value) === 0);
    return `<section class="ai-profile-tab-panel" data-ai-profile-tab-panel="billing" role="tabpanel" ${controller.profileEditorTab === 'billing' ? '' : 'hidden'}>
      <div class="ai-profile-section-head"><div><h5>料金・上限</h5><p>このプロファイルのトークン単価と、用途を問わずこのプロファイル全体へ適用するAPI利用上限を設定します。</p></div></div>
      <div class="ai-response-group"><div class="ai-response-group-head"><h6>単価</h6><p>すべて100万tokensあたりのUSD単価です。単価変更は過去の使用額へ遡及せず、変更後のAPI要求から適用します。</p></div><div class="ai-profile-form-grid ai-billing-rate-grid">
        <label class="field"><span>通常入力</span><input data-profile-setting="billingInputUsdPerMillion" type="number" min="0" max="1000000" step="0.000001" value="${billing.inputUsdPerMillion}"><small>キャッシュされていない入力tokens。</small></label>
        <label class="field"><span>キャッシュ入力</span><input data-profile-setting="billingCachedInputUsdPerMillion" type="number" min="0" max="1000000" step="0.000001" value="${billing.cachedInputUsdPerMillion}"><small>キャッシュ読取tokens。未課金なら0。</small></label>
        <label class="field"><span>キャッシュ書込</span><input data-profile-setting="billingCacheWriteUsdPerMillion" type="number" min="0" max="1000000" step="0.000001" value="${billing.cacheWriteUsdPerMillion}"><small>キャッシュ作成tokens。未課金なら0。</small></label>
        <label class="field"><span>出力</span><input data-profile-setting="billingOutputUsdPerMillion" type="number" min="0" max="1000000" step="0.000001" value="${billing.outputUsdPerMillion}"><small>請求対象の出力・推論tokens。</small></label>
      </div></div>
      <div class="ai-response-group"><div class="ai-response-group-head"><h6>プロファイル利用上限</h6><p>0は無制限です。人狼・チャットルームなど用途を問わず、このAIプロファイルの累計使用額に対して適用します。次回要求を最大出力まで保守的に見積もり、超過見込みならAPI送信前に停止します。</p></div>
        <div class="ai-profile-form-grid"><label class="field"><span>プロファイル利用上限（USD）</span><input data-profile-setting="billingProfileBudgetUsd" type="number" min="0" max="1000000" step="0.000001" value="${billing.profileBudgetUsd}"><small>0 = 無制限。使用量をリセットすると上限判定の累計も0へ戻ります。</small></label></div>
        ${pricingMissing ? '<div class="validation warning ai-billing-warning">! 上限が設定されていますが単価がすべて0です。この状態では料金を加算できないため上限判定も進みません。</div>' : ''}
        <div class="ai-billing-usage-card${limited && spent >= limit ? ' is-reached' : ''}">
          <div class="ai-billing-usage-head"><div><span>このプロファイルの累計</span><strong>${formatUsd(spent)}</strong></div><span>${Number(usage.totalTokens ?? 0).toLocaleString('ja-JP')} tokens / ${Number(usage.calls ?? 0).toLocaleString('ja-JP')} calls</span></div>
          ${limited ? `<progress class="ai-billing-progress" max="100" value="${percentage.toFixed(2)}" aria-label="プロファイル利用上限使用率"></progress><div class="ai-billing-usage-meta"><span>上限 ${formatUsd(limit)}</span><span>残り ${formatUsd(remaining)}</span><span>${percentage.toFixed(1)}%</span></div>` : '<div class="ai-billing-usage-meta"><span>上限なし</span></div>'}
          <div class="ai-billing-reset-row"><p class="help">このプロファイルの累計使用量・使用額だけを0に戻します。他プロファイルと詳細APIログは残ります。</p><button class="button danger-ghost small" data-ai-action="reset-profile-usage" data-profile-id="${escapeHtml(profile.id)}" type="button">このプロファイルをリセット</button></div>
        </div>
      </div>
    </section>`;
  }

  function profileCard(profile, selectedProfileId) {
    const local = isLocalProvider(profile.provider);
    const keyPlaceholder = profile.hasApiKey
      ? '保存済みのキーを維持します。変更時のみ入力'
      : local ? '認証を使う場合のみ入力' : 'APIキーを入力';
    const compatible = isCustomEndpointProvider(profile.provider);
    const ollama = local && (profile.localServerPreset ?? 'lm-studio') === 'ollama';
    const endpointReadonly = !compatible || (local && (profile.localServerPreset ?? 'lm-studio') !== 'custom');
    const endpointHelp = local
      ? '同じPCで動作するローカルLLMサーバーへ接続します。LM Studio・Ollama・llama.cpp・vLLM・LocalAIのOpenAI互換APIに対応します。'
      : compatible
        ? '通信先にはHTTPSを使用してください。HTTPを許可するのはlocalhost・127.0.0.1・::1だけです。'
        : '公式プロバイダーでは送信先を固定し、入力したAPIキーを別のホストへ送信しません。';
    const modelListId = discoveredModels(profile.id).length ? `model-list-${profile.id}` : '';
    const generationTest = controller.generationTestResults.get(profile.id);
    const connectionSelected = controller.profileEditorTab === 'connection';
    const responseSelected = controller.profileEditorTab === 'response';
    const generationSelected = controller.profileEditorTab === 'generation';
    const profileIndex = controller.settings.profiles.findIndex((item) => item.id === profile.id);
    const canMoveUp = profileIndex > 0;
    const canMoveDown = profileIndex >= 0 && profileIndex < controller.settings.profiles.length - 1;
    return `<article class="ai-profile-card" data-ai-profile-id="${escapeHtml(profile.id)}" ${profile.id === selectedProfileId ? '' : 'hidden'}>
      <header class="ai-profile-editor-head">
        <div class="ai-profile-editor-title"><span class="eyebrow">選択中のAIプロファイル</span><h4 data-profile-editor-label>${escapeHtml(profile.label)}</h4><p class="ai-profile-provider-row"><span data-profile-editor-provider>${escapeHtml(PROVIDER_LABELS[profile.provider] ?? profile.provider)}</span> / <span data-profile-editor-model>${escapeHtml(profile.model || 'モデル未設定')}</span> ${providerDataRouteBadgeHtml(profile.provider, 'data-profile-editor-data-route')}</p><small data-profile-editor-generation>${escapeHtml(generationSummary(profile, profile.generation))}</small></div>
        <div class="ai-profile-editor-controls">
          <label class="ai-profile-enabled-switch"><input data-profile-setting="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><span>有効</span></label>
          <div class="ai-profile-editor-actions" role="group" aria-label="プロファイル操作">
            <button class="button ghost small" data-ai-action="move-profile-up" data-profile-id="${escapeHtml(profile.id)}" type="button" ${canMoveUp ? '' : 'disabled'}>上へ</button>
            <button class="button ghost small" data-ai-action="move-profile-down" data-profile-id="${escapeHtml(profile.id)}" type="button" ${canMoveDown ? '' : 'disabled'}>下へ</button>
            <button class="button ghost small" data-ai-action="duplicate-profile" data-profile-id="${escapeHtml(profile.id)}" type="button">複製</button>
            <button class="button danger-ghost small" data-ai-action="delete-profile" data-profile-id="${escapeHtml(profile.id)}" type="button">削除</button>
          </div>
        </div>
      </header>
      <nav class="ai-profile-tabs" role="tablist" aria-label="AIプロファイル設定">
        ${profileEditorTabButton('connection', '接続設定')}
        ${profileEditorTabButton('response', '応答設定')}
        ${profileEditorTabButton('billing', '料金・上限')}
        ${profileEditorTabButton('generation', '生成工程')}
      </nav>
      <section class="ai-profile-tab-panel" data-ai-profile-tab-panel="connection" role="tabpanel" ${connectionSelected ? '' : 'hidden'}>
        <div class="ai-profile-section-head"><div><h5>接続設定</h5><p>AIの接続先、認証情報、使用するモデルを設定します。</p></div><button class="button ghost" data-ai-action="test-profile" data-profile-id="${escapeHtml(profile.id)}" type="button">接続テスト</button></div>
        <div class="ai-profile-data-route" data-profile-data-route>${providerDataRouteBadgeHtml(profile.provider)}<p data-profile-data-route-help>${escapeHtml(providerDataRouteMeta(profile.provider).help)}</p></div>
        <div class="ai-profile-form-grid">
          <label class="field"><span>プロファイル名</span><input data-profile-setting="label" value="${escapeHtml(profile.label)}" maxlength="80"></label>
          <label class="field"><span>プロバイダー</span><select data-profile-setting="provider">${providerOptions(profile.provider)}</select></label>
          <label class="field" data-local-server-preset ${local ? '' : 'hidden'}><span>ローカルサーバー</span><select data-profile-setting="localServerPreset">${localServerPresetOptions(profile.localServerPreset ?? 'lm-studio')}</select></label>
          <label class="field full"><span>APIエンドポイント</span><input data-profile-setting="endpoint" value="${escapeHtml(profile.endpoint)}" placeholder="${escapeHtml(PROVIDER_DEFAULTS[profile.provider]?.endpoint ?? '')}" ${endpointReadonly ? 'readonly' : ''}><small data-endpoint-help>${escapeHtml(endpointHelp)}</small></label>
          <div class="field full ai-api-key-field"><span>${local ? 'APIキー（任意）' : 'APIキー'}</span><div class="ai-api-key-row"><input data-profile-setting="apiKey" type="password" autocomplete="off" placeholder="${escapeHtml(keyPlaceholder)}"><label class="check-row compact"><input data-profile-setting="clearApiKey" type="checkbox">保存済みキーを削除</label></div><small>${local ? '未入力時はAuthorizationヘッダーを送信しません。' : ''}</small></div>
          <div class="field full ai-model-field"><span>モデルID</span><div class="ai-model-row"><input data-profile-setting="model" value="${escapeHtml(profile.model)}" placeholder="モデル一覧から選択または直接入力" ${modelListId ? `list="${escapeHtml(modelListId)}"` : ''}><button class="button ghost" data-local-model-action data-ai-action="list-profile-models" data-profile-id="${escapeHtml(profile.id)}" type="button" ${local ? '' : 'hidden'}>モデル一覧を取得</button></div>${modelDatalistHtml(profile)}<small data-model-discovery-status>${local ? 'ローカルLLMサーバーで利用可能なモデルを一覧へ読み込みます。' : ''}</small></div>
          <label class="field"><span>タイムアウト（秒）</span><input data-profile-setting="timeoutSeconds" type="number" min="10" max="600" value="${Math.round((profile.timeoutMs ?? 180000) / 1000)}"></label>
        </div>
      </section>
      <section class="ai-profile-tab-panel" data-ai-profile-tab-panel="response" role="tabpanel" ${responseSelected ? '' : 'hidden'}>
        <div class="ai-profile-section-head"><div><h5>応答設定</h5><p>出力上限、応答形式、プロンプトキャッシュ、Thinking量など、モデルごとの詳細設定を行います。</p></div></div>
        <div class="ai-response-group" data-local-setting ${local ? '' : 'hidden'}><div class="ai-response-group-head"><h6>ローカルコンテキスト</h6><p>ローカルLLMが扱える入力と出力の合計上限を設定します。</p></div><div class="ai-profile-form-grid"><label class="field full"><span>モデルのコンテキスト上限</span><input data-profile-setting="contextWindowTokens" type="number" min="2048" max="1048576" value="${Number(profile.contextWindowTokens ?? 32768)}"><small>ローカルLLMサーバーでモデルを起動したときのコンテキスト上限に合わせてください。</small></label></div></div>
        <div class="ai-response-group"><div class="ai-response-group-head"><h6>プロンプトキャッシュ</h6><p>対応モデルでは、繰り返し利用する入力のキャッシュによりAPI利用量や応答時間を抑えられる場合があります。</p></div><div class="ai-profile-form-grid"><label class="field"><span>プロンプトキャッシュ</span><select data-profile-setting="promptCacheMode"><option value="auto" ${profile.promptCacheMode !== 'off' ? 'selected' : ''}>対応モデルで自動使用</option><option value="off" ${profile.promptCacheMode === 'off' ? 'selected' : ''}>使用しない</option></select><small>対応状況はプロバイダーやモデルによって異なります。</small></label><label class="field full"><span>Anthropicキャッシュ保持</span><select data-profile-setting="anthropicCacheTtl"><option value="auto" ${profile.anthropicCacheTtl === 'auto' || !profile.anthropicCacheTtl ? 'selected' : ''}>自動（全自動向け5分）</option><option value="5m" ${profile.anthropicCacheTtl === '5m' ? 'selected' : ''}>5分</option><option value="1h" ${profile.anthropicCacheTtl === '1h' ? 'selected' : ''}>1時間</option></select><small>人間入力待ちで同じAIの次回呼び出しが5分を超える卓だけ1時間を使用してください。</small></label></div></div>
        <div class="ai-response-group"><div class="ai-response-group-head"><h6>出力</h6><p>AIが1回の呼び出しで生成できる出力量を設定します。</p></div><div class="ai-profile-form-grid"><label class="field"><span>最大出力トークン</span><input data-profile-setting="maxOutputTokens" type="number" min="256" max="65536" value="${Number(profile.maxOutputTokens ?? 8192)}"><small>JSON応答が途中で切れにくいよう、8192以上を推奨します。</small></label><label class="field" data-compatible-token-field ${compatible ? '' : 'hidden'}><span>出力上限のパラメーター名</span><select data-profile-setting="chatTokenLimitField"><option value="max_completion_tokens" ${profile.chatTokenLimitField !== 'max_tokens' ? 'selected' : ''}>max_completion_tokens</option><option value="max_tokens" ${profile.chatTokenLimitField === 'max_tokens' ? 'selected' : ''}>max_tokens</option></select><small>OpenAI互換サーバーが受け付けるパラメーター名に合わせてください。</small></label></div></div>
        <div class="ai-response-group" data-local-setting ${local ? '' : 'hidden'}><div class="ai-response-group-head"><h6>応答形式</h6><p>AIへJSON出力を要求する方法と、回答前後の余分な文章を受信した場合の扱いを設定します。</p></div><div class="ai-profile-form-grid"><label class="field"><span>JSON要求方式</span><select data-profile-setting="jsonRequestMode"><option value="prompt-only" ${profile.jsonRequestMode !== 'json-object' ? 'selected' : ''}>プロンプト内だけでJSON出力を指示（互換性優先）</option><option value="json-object" ${profile.jsonRequestMode === 'json-object' ? 'selected' : ''}>APIのresponse_formatも使用</option></select><small>接続先がresponse_formatに未対応の場合は、プロンプト内だけで指示してください。</small></label><label class="field"><span>JSON回答の読み取り方</span><select data-profile-setting="jsonResponseMode"><option value="extract-object" ${profile.jsonResponseMode !== 'strict' ? 'selected' : ''}>最初のJSONオブジェクトだけを取り出す</option><option value="strict" ${profile.jsonResponseMode === 'strict' ? 'selected' : ''}>回答全体がJSONであることを要求</option></select><small>説明文やコードフェンスを付けるモデルでは、最初のJSONだけを取り出す方式が安定します。</small></label></div></div>
        <div class="ai-response-group" data-ollama-setting ${ollama ? '' : 'hidden'}><div class="ai-response-group-head"><h6>Thinking</h6><p>Ollama対応モデルが回答前に行う推論の量を設定します。</p></div><div class="ai-profile-form-grid"><label class="field full"><span>Thinking量</span><select data-profile-setting="thinkingLevel">${ollamaThinkingOptionsHtml(profile.thinkingLevel)}</select><small>noneはThinkingを行いません。lowからmaxへ上げるほど推論量が増え、応答時間も長くなる傾向があります。</small></label></div></div>
      </section>
      ${billingPanelHtml(profile)}
      <section class="ai-profile-tab-panel" data-ai-profile-tab-panel="generation" role="tabpanel" ${generationSelected ? '' : 'hidden'}>
        <div class="ai-profile-section-head"><div><h5>生成工程</h5><p>1つの回答を作る工程と担当AIを設定します。「生成工程をテスト」では現在の設定でテスト回答を生成し、結果を比較できます。テスト結果はゲームへ反映されません。</p></div><button class="button ghost" data-ai-action="test-generation-pipeline" data-profile-id="${escapeHtml(profile.id)}" type="button">生成工程をテスト</button></div>
        ${generationSectionHtml(profile)}
        ${generationTestResultHtml(generationTest)}
      </section>
    </article>`;
  }

  function profileWorkspaceHtml() {
    const selectedProfileId = activeProfileId();
    return `<div class="ai-profile-workspace">
      <aside class="ai-profile-sidebar" aria-label="AIプロファイル一覧"><div class="ai-profile-list">${controller.settings.profiles.map((profile) => profileListItemHtml(profile, selectedProfileId)).join('')}</div></aside>
      <div class="ai-profile-editors">${controller.settings.profiles.map((profile) => profileCard(profile, selectedProfileId)).join('')}</div>
    </div>`;
  }

  function assignmentCellHtml(player, locked = false) {
    if (!player) return '<div class="ai-assignment-row is-empty" aria-hidden="true"></div>';
    return `<div class="ai-assignment-row" data-ai-assignment-row="${escapeHtml(player.id)}">
      <span class="ai-assignment-player"><strong>${escapeHtml(player.name)}</strong><small>${player.controller === 'ai' ? 'AI操作' : '人間操作'}</small></span>
      ${playerProfileSelectHtml(player, locked)}
    </div>`;
  }

  function assignmentRows(state) {
    const players = state?.players ?? [];
    const locked = state.game?.phase !== 'setup';
    const rows = [];
    for (let index = 0; index < players.length; index += 2) {
      rows.push(`<div class="ai-assignment-pair-row">${assignmentCellHtml(players[index], locked)}${assignmentCellHtml(players[index + 1], locked)}</div>`);
    }
    return rows.join('');
  }

  function formatUsage(value) {
    return Number(value ?? 0).toLocaleString('ja-JP');
  }

  function usageMetricHtml(label, usage, note) {
    return `<div class="metric-card"><span>${escapeHtml(label)}</span><strong class="viz-stat-value">${formatUsage(usage.totalTokens)}</strong><small>${formatUsd(usage.costUsd)} / 入力 ${formatUsage(usage.inputTokens)} / 出力 ${formatUsage(usage.outputTokens)} / キャッシュ読取 ${formatUsage(usage.cachedInputTokens)} / 書込 ${formatUsage(usage.cacheWriteTokens)} / 推論 ${formatUsage(usage.reasoningTokens)}${note ? ` / ${escapeHtml(note)}` : ''}</small></div>`;
  }

  function taskUsageNote(usage) {
    const tasks = Math.max(0, Number(usage?.tasks ?? 0));
    const regeneratedTasks = Math.max(0, Number(usage?.regeneratedTasks ?? 0));
    const averageTokens = tasks ? Math.round(Math.max(0, Number(usage?.taskTotalTokens ?? 0)) / tasks) : 0;
    const regenerationRate = tasks ? ((regeneratedTasks / tasks) * 100).toFixed(1) : '0.0';
    return `タスク ${formatUsage(tasks)} / 平均 ${formatUsage(averageTokens)} tokens / 再生成 ${formatUsage(regeneratedTasks)}（${regenerationRate}%）`;
  }

  function managementSectionOpenAttribute(sectionId) {
    return controller.managementSectionOpen?.[sectionId] ? ' open' : '';
  }

  function captureManagementSectionState(root = document) {
    root?.querySelectorAll?.('details[data-ai-management-section]').forEach((section) => {
      const sectionId = section.dataset.aiManagementSection;
      if (Object.hasOwn(controller.managementSectionOpen, sectionId)) {
        controller.managementSectionOpen[sectionId] = Boolean(section.open);
      }
    });
  }

  function usagePanelHtml() {
    const current = controller.lastRequestUsage;
    const persistedTotals = controller.persistedUsage?.totals ?? emptyUsage();
    const totalUsage = { ...persistedTotals, costUsd: Number(controller.persistedUsage?.totalCostUsd ?? persistedTotals.costUsd ?? 0) };
    const currentHtml = current
      ? usageMetricHtml('直近API要求', current, 'tokens')
      : '<div class="metric-card"><span>直近API要求</span><strong class="viz-stat-value">—</strong><small>手動回答または未実行</small></div>';
    const knownIds = new Set(controller.settings.profiles.map((profile) => profile.id));
    const profileRows = controller.settings.profiles.map((profile) => {
      const usage = profileUsage(profile.id);
      const provider = PROVIDER_LABELS[profile.provider] ?? profile.provider;
      const model = profile.model || 'モデル未設定';
      return usageMetricHtml(profile.label, usage, `${provider} / ${model} / ${formatUsage(usage.calls)} calls / ${taskUsageNote(usage)} / 再試行 ${formatUsage(usage.retries)} / エラー ${formatUsage(usage.failedCalls)}`);
    });
    for (const [profileId, usage] of Object.entries(controller.persistedUsage?.profiles ?? {})) {
      if (knownIds.has(profileId)) continue;
      const label = usage.label || `削除済みプロファイル ${profileId}`;
      const provider = PROVIDER_LABELS[usage.provider] ?? usage.provider ?? '不明';
      const model = usage.model || 'モデル不明';
      profileRows.push(usageMetricHtml(label, usage, `${provider} / ${model} / ${formatUsage(usage.calls)} calls`));
    }
    return `<details class="panel ai-settings-section ai-usage-panel" data-ai-management-section="usage"${managementSectionOpenAttribute('usage')}>
      <summary class="ai-settings-summary">
        <span class="ai-settings-summary-copy"><strong>API使用量</strong><small>人狼・チャットルームなど全用途をAIプロファイル別に集計します。</small></span>
        <span class="ai-settings-summary-value" data-ai-usage-summary>累計 ${formatUsage(totalUsage.totalTokens)} tokens / ${formatUsd(totalUsage.costUsd)}</span>
      </summary>
      <div class="ai-settings-body">
        <p class="help ai-settings-intro">同じAIプロファイルを複数の機能で使用した場合も、使用量はそのプロファイルにまとめて集計されます。</p>
        <div class="ai-usage-grid">
          ${currentHtml}
          ${usageMetricHtml('全プロファイル累計', totalUsage, `${formatUsage(totalUsage.calls)} calls / ${taskUsageNote(totalUsage)} / 再試行 ${formatUsage(totalUsage.retries)} / エラー ${formatUsage(totalUsage.failedCalls)}`)}
          ${profileRows.join('')}
        </div>
        <div class="ai-usage-reset-actions">
          <p class="help">各プロファイルの個別リセットは、そのプロファイルの「料金・上限」から実行できます。詳細APIログは削除しません。</p>
          <div><button class="button danger-ghost" data-ai-action="reset-all-usage" type="button">全プロファイルの使用量をリセット</button></div>
        </div>
      </div>
    </details>`;
  }

  function historyStatusRows(state) {
    const statuses = new Map((runtime().getAiHistoryStatus() ?? []).map((item) => [item.playerId, item]));
    return (state?.players ?? []).filter((player) => player.controller === 'ai').map((player) => {
      const status = statuses.get(player.id);
      const sequence = Number(status?.lastPublicSequence ?? 0);
      return `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}（読了 #${sequence}）</option>`;
    }).join('');
  }

  function assignmentSummary(state) {
    const aiPlayers = (state?.players ?? []).filter((player) => player.controller === 'ai');
    if (controller.settings.executionMode === 'manual') return `AI ${aiPlayers.length}人 / 全員手動プロンプト`;
    const assigned = aiPlayers.filter((player) => profileById(assignedProfileId(player.id))).length;
    const manual = aiPlayers.length - assigned;
    return `API ${assigned}人 / 手動生成 ${manual}人`;
  }

  function optionSummary() {
    const actionLabels = { retry: '同じ内容で再試行', 'full-history-retry': '公開履歴全文で再試行', stop: '停止' };
    const recoveryLabels = { stop: '手動停止', repair: '部分修復', 'repair-regenerate': '修復＋再生成' };
    return `操作間隔 ${formatUsage(controller.settings.autoRun.intervalMs)}ms / 最大 ${formatUsage(controller.settings.autoRun.maxConsecutiveSteps)}ステップ / API ${actionLabels[controller.settings.aiOptions.apiErrorAction] ?? '停止'} / 回答 ${recoveryLabels[controller.settings.aiOptions.responseRecoveryMode] ?? '修復＋再生成'}`;
  }

  function readinessHtml(state) {
    const validation = assignmentValidation(state);
    const automatic = controller.settings.executionMode !== 'manual';
    if (validation.ok) {
      return `<div class="ai-readiness-bar success" data-ai-readiness><span><strong>✓ 実行可能</strong>${automatic ? '設定済み参加者はAPI実行し、未設定参加者は手動生成へ切り替わります。' : '手動プロンプト進行を使用できます。'}</span></div>`;
    }
    const remaining = Math.max(0, validation.errors.length - 1);
    return `<div class="ai-readiness-bar error" data-ai-readiness><span><strong>× 設定を確認してください</strong>${escapeHtml(validation.errors[0])}${remaining ? `（ほか${remaining}件）` : ''}</span><button class="button danger-ghost" data-ai-action="open-required-settings" type="button">設定を確認</button></div>`;
  }

  function renderManagementPage(state) {
    const aiPlayers = (state?.players ?? []).filter((player) => player.controller === 'ai');
    const validation = assignmentValidation(state);
    const enabledProfiles = controller.settings.profiles.filter((profile) => profile.enabled).length;
    const configuredKeys = controller.settings.profiles.filter((profile) => ['demo', LOCAL_OPENAI_PROVIDER].includes(profile.provider) || profile.hasApiKey).length;
    const selectedBulkProfileId = bulkAssignmentProfileId();
    const automatic = controller.settings.executionMode !== 'manual';
    const phaseLabel = getPhaseLabels()[state?.game?.phase] ?? state?.game?.phase ?? '未開始';
    return `<section class="page ai-management-page">
      <div class="page-head"><div><span class="eyebrow">AI MANAGEMENT</span><h2>AI管理</h2><p>ゲームの実行操作、参加者への割り当て、AI接続設定をこの画面で管理します。</p></div></div>
      ${bridge.isDesktop ? '' : '<div class="alert warning"><strong>ブラウザ・デモモード</strong><span>実APIのキー保存と接続はElectron版でのみ利用できます。</span></div>'}
      <div class="ai-data-privacy-notice" role="note">
        <div class="ai-data-privacy-notice-copy"><strong>AIへのデータ送信について</strong><p>外部LLMを使用すると、AI生成に必要なプレイヤー名・キャラクター設定・会話内容・ゲーム状態などが選択したサービスへ送信されます。家族・友人など実在人物の名前や個人情報を入力する場合はご注意ください。</p></div>
        <button class="button ghost small" data-ai-action="open-data-privacy" type="button">AI通信とプライバシー</button>
      </div>
      <div class="ai-summary-bar" aria-label="AI管理概要">
        <span><strong>実行方式</strong><b data-ai-summary-execution>${automatic ? '自動API実行' : '手動プロンプト'}</b></span>
        <span><strong>AI参加者</strong><b>${aiPlayers.length}人</b></span>
        <span><strong>プロファイル</strong><b>${enabledProfiles}/${controller.settings.profiles.length}件 有効</b></span>
        <span class="${validation.ok ? 'is-ready' : 'needs-attention'}"><strong>開始前確認</strong><b data-ai-summary-readiness>${validation.ok ? '実行可能' : `要修正 ${validation.errors.length}件`}</b></span>
      </div>
      <form id="ai-management-form">
        <div class="ai-management-stack">
          <section class="panel ai-operation-panel ai-operation-primary" aria-labelledby="ai-operation-heading">
            <div class="panel-title-row ai-section-title">
              <div><div><h3 id="ai-operation-heading">実行方式と進行</h3><p class="help">全自動の開始・停止、AIの1手実行、手動プロンプトへの切り替えを行います。</p></div></div>
              <span class="ai-save-indicator" data-ai-save-indicator>保存済み</span>
            </div>
            <div class="ai-progress-context"><strong>Day ${Number(state?.game?.day ?? 0)}・${escapeHtml(phaseLabel)}</strong><span>${escapeHtml(state?.game?.title || 'AI人狼ゲーム')}</span></div>
            <div class="ai-run-toolbar">
              <div class="ai-run-status"><span class="automation-indicator" data-automation-indicator aria-hidden="true"></span><strong data-automation-status data-status="${escapeHtml(controller.statusType)}">${escapeHtml(controller.statusMessage)}</strong></div>
              <div class="ai-run-controls">
                <button class="button primary" data-ai-action="toggle-run" type="button">全自動開始</button>
                <button class="button ghost" data-ai-action="step" type="button">AIを1手実行</button>
                <button class="button ghost" data-ai-action="open-live" type="button">公開実況を開く</button>
                <button class="button ghost" data-ai-action="open-manual" type="button">手動進行を開く</button>
              </div>
            </div>
            <div class="ai-operation-layout">
              <div class="ai-operation-mode">
                <label class="ai-operation-option"><span><input name="executionMode" type="radio" value="automatic" ${automatic ? 'checked' : ''}> <strong>自動API実行</strong></span><small>AIプロファイルが割り当てられた参加者はAPIで回答し、未設定の参加者だけ手動プロンプトで進めます。</small></label>
                <label class="ai-operation-option"><span><input name="executionMode" type="radio" value="manual" ${automatic ? '' : 'checked'}> <strong>手動プロンプト</strong></span><small>プロンプトをコピーし、外部AIのJSON回答を貼り付けて進めます。</small></label>
              </div>
              <div class="ai-operation-toggles">
                <label class="check-row"><input name="autoConfirmWarnings" type="checkbox" ${controller.settings.autoRun.autoConfirmWarnings ? 'checked' : ''}>AI応答の警告確認を自動承認</label>
                <label class="check-row"><input name="autoPublish" type="checkbox" ${controller.settings.autoRun.autoPublish ? 'checked' : ''}>投票・処刑・夜明け・結果を自動公開</label>
              </div>
            </div>
            <p class="help ai-operation-note">自動実行では、アプリが進行卓の操作を自動で行います。公開実況には、公開済みの発言と結果だけを表示します。</p>
          </section>

          ${readinessHtml(state)}

          <details class="panel ai-settings-section ai-profiles-panel" data-ai-management-section="profiles"${managementSectionOpenAttribute('profiles')}>
            <summary class="ai-settings-summary">
              <span class="ai-settings-summary-copy"><strong>AIプロファイル</strong><small>クラウドAPIとローカルLLMの接続情報を管理します。</small></span>
              <span class="ai-settings-summary-value">有効 ${enabledProfiles}件 / 接続情報 ${configuredKeys}件</span>
            </summary>
            <div class="ai-settings-body">
              <div class="ai-settings-actions"><p class="help">APIキーは必要な場合だけ設定してください。未設定の認証情報は送信されません。</p><div class="ai-profile-heading-actions"><button class="button ghost" data-ai-action="import-profile-json" type="button">プロファイル読込</button><button class="button ghost" data-ai-action="export-profile-json" type="button">プロファイル出力</button><button class="button primary" data-ai-action="add-profile" type="button">新規プロファイル</button></div></div>
              ${profileWorkspaceHtml()}
            </div>
          </details>


          <details class="panel ai-settings-section ai-assignment-panel" data-ai-management-section="assignments"${managementSectionOpenAttribute('assignments')}>
            <summary class="ai-settings-summary">
              <span class="ai-settings-summary-copy"><strong>参加者への割り当て</strong><small>AI操作の参加者ごとにAIプロファイルまたは「未設定（手動生成）」を選びます。</small></span>
              <span class="ai-settings-summary-value" data-ai-assignment-summary>${escapeHtml(assignmentSummary(state))}</span>
            </summary>
            <div class="ai-settings-body">
              <div class="ai-bulk-assignment"><span class="ai-bulk-assignment-label">AI参加者へ一括設定</span><div class="ai-bulk-assignment-controls"><select id="ai-bulk-profile" aria-label="AI参加者へ一括設定するプロファイル" ${automatic ? '' : 'disabled'}><option value="">プロファイルを選択</option>${controller.settings.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selectedBulkProfileId ? ' selected' : ''}>${escapeHtml(profile.label)}</option>`).join('')}</select><button class="button ghost" data-ai-action="bulk-assign" type="button" ${automatic ? '' : 'disabled'}>全AI参加者へ適用</button></div><p class="ai-bulk-assignment-note">AI参加者${aiPlayers.length}名の個別割り当てを、選択したプロファイルで上書きします。</p><div class="ai-bulk-assignment-feedback" data-ai-bulk-feedback hidden aria-live="polite"></div></div>
              <div class="ai-assignment-list">${assignmentRows(state)}</div>
              ${aiPlayers.length ? '' : '<div class="empty-state compact"><p>現在、AI操作の参加者はいません。</p></div>'}
            </div>
          </details>

          <details class="panel ai-settings-section ai-options-panel" data-ai-management-section="options"${managementSectionOpenAttribute('options')}>
            <summary class="ai-settings-summary">
              <span class="ai-settings-summary-copy"><strong>オプション</strong><small>自動実行、履歴、失敗時の処理、ログ保存を設定します。</small></span>
              <span class="ai-settings-summary-value" data-ai-options-summary>${escapeHtml(optionSummary())}</span>
            </summary>
            <div class="ai-settings-body ai-option-groups">
              <section class="ai-option-group" aria-labelledby="ai-auto-run-options-heading"><div class="ai-option-group-head"><h4 id="ai-auto-run-options-heading">自動実行</h4><p>操作間隔は各処理の待ち時間、連続ステップ上限は1回の自動実行で進める最大回数です。</p></div><div class="form-grid ai-options-grid"><label class="field"><span>操作間隔（ミリ秒）</span><input name="intervalMs" type="number" min="100" max="10000" value="${controller.settings.autoRun.intervalMs}"></label><label class="field"><span>連続ステップ上限</span><input name="maxConsecutiveSteps" type="number" min="1" max="5000" value="${controller.settings.autoRun.maxConsecutiveSteps}"></label></div></section>
              <section class="ai-option-group" aria-labelledby="ai-history-options-heading"><div class="ai-option-group-head"><h4 id="ai-history-options-heading">履歴・エラー処理</h4><p>AIへ送る履歴、失敗時の再試行、ログ保存を設定します。</p></div><div class="form-grid ai-options-grid">
                <label class="field full"><span>公開履歴の送信方式</span><select name="publicHistoryMode"><option value="full" ${controller.settings.aiOptions.publicHistoryMode === 'full' ? 'selected' : ''}>全公開履歴を無圧縮で送信</option><option value="compact" ${controller.settings.aiOptions.publicHistoryMode === 'compact' ? 'selected' : ''}>過去履歴を圧縮し、前回正常回答後は全文で送信</option><option value="delta" ${controller.settings.aiOptions.publicHistoryMode === 'delta' ? 'selected' : ''}>前回の正常回答後に増えた公開履歴だけを送信</option></select><small>通常は「前回の正常回答後に増えた公開履歴だけを送信」を使用します。文脈不足を感じる場合は「過去履歴を圧縮」、さらに必要な場合は「全公開履歴」を選んでください。</small></label>
                <label class="field"><span>APIエラー時</span><select name="apiErrorAction"><option value="retry" ${controller.settings.aiOptions.apiErrorAction === 'retry' ? 'selected' : ''}>同じ内容で1回再試行</option><option value="full-history-retry" ${controller.settings.aiOptions.apiErrorAction === 'full-history-retry' ? 'selected' : ''}>最新状態を再取得し、公開履歴全文で1回再試行</option><option value="stop" ${controller.settings.aiOptions.apiErrorAction === 'stop' ? 'selected' : ''}>停止して手動対応</option></select></label>
                <label class="field"><span>AI回答エラー時</span><select name="responseRecoveryMode">${responseRecoveryModeOptions(controller.settings.aiOptions.responseRecoveryMode)}</select><small>部分修復や再生成を選んだ場合でも、API通信エラーの再試行を含めて1タスク最大4回までです。</small></label>
                <label class="field full"><span>APIログ保存</span><select name="apiLogScope"><option value="none" ${controller.settings.aiOptions.apiLogScope === 'none' ? 'selected' : ''}>保存しない</option><option value="errors" ${controller.settings.aiOptions.apiLogScope === 'errors' ? 'selected' : ''}>エラー時だけ保存</option><option value="all" ${controller.settings.aiOptions.apiLogScope === 'all' ? 'selected' : ''}>すべて保存</option></select><small>トークン数と呼び出し回数の集計は、ログ本文を保存しない場合も残ります。</small></label>
                <div class="field full"><span>次回だけ全履歴を送信</span><div class="ai-resync-controls"><select id="ai-resync-player"><option value="">AI参加者を選択</option>${historyStatusRows(state)}</select><button class="button ghost" data-ai-action="resync-player" type="button">選択した参加者は次回だけ全履歴</button><button class="button ghost" data-ai-action="resync-all" type="button">全参加者は次回だけ全履歴</button></div><small>次回の回答後は、選択中の公開履歴送信方式へ自動で戻ります。</small></div>
              </div></section>
            </div>
          </details>

          ${usagePanelHtml()}
        </div>
        <div class="ai-management-save" data-ai-management-save hidden><span>未保存のAIプロファイル・オプション設定があります。</span><button class="button primary" type="submit">AI設定を保存</button></div>
      </form>
    </section>`;
  }

  function collectVisibleAssignments(baseAssignments = controller.settings.assignments) {
    const assignments = { ...baseAssignments };
    document.querySelectorAll('[data-ai-profile-player-id]').forEach((select) => {
      assignments[select.dataset.aiProfilePlayerId] = select.value || null;
    });
    return assignments;
  }

  function collectManagementForm() {
    const form = document.querySelector('#ai-management-form');
    if (!form) return structuredClone(controller.settings);
    const profiles = [...form.querySelectorAll('.ai-profile-card')].map((card) => {
      const previous = profileById(card.dataset.aiProfileId);
      const selectedProvider = card.querySelector('[data-profile-setting="provider"]').value;
      const selectedLocalServerPreset = card.querySelector('[data-profile-setting="localServerPreset"]')?.value
        ?? previous?.localServerPreset
        ?? 'custom';
      const provider = selectedProvider === 'openai-compatible' && selectedLocalServerPreset !== 'custom'
        ? LOCAL_OPENAI_PROVIDER
        : selectedProvider;
      return {
        id: card.dataset.aiProfileId,
        label: card.querySelector('[data-profile-setting="label"]').value.trim() || '名称未設定',
        provider,
        model: card.querySelector('[data-profile-setting="model"]').value.trim(),
        endpoint: card.querySelector('[data-profile-setting="endpoint"]').value.trim(),
        apiKey: card.querySelector('[data-profile-setting="apiKey"]').value,
        clearApiKey: card.querySelector('[data-profile-setting="clearApiKey"]').checked,
        enabled: card.querySelector('[data-profile-setting="enabled"]').checked,
        hasApiKey: Boolean(previous?.hasApiKey),
        timeoutMs: Number(card.querySelector('[data-profile-setting="timeoutSeconds"]').value) * 1000,
        maxOutputTokens: Number(card.querySelector('[data-profile-setting="maxOutputTokens"]').value),
        chatTokenLimitField: card.querySelector('[data-profile-setting="chatTokenLimitField"]')?.value ?? 'max_completion_tokens',
        contextWindowTokens: Number(card.querySelector('[data-profile-setting="contextWindowTokens"]')?.value ?? previous?.contextWindowTokens ?? 131072),
        promptCacheMode: card.querySelector('[data-profile-setting="promptCacheMode"]')?.value === 'off' ? 'off' : 'auto',
        anthropicCacheTtl: card.querySelector('[data-profile-setting="anthropicCacheTtl"]')?.value ?? 'auto',
        jsonRequestMode: card.querySelector('[data-profile-setting="jsonRequestMode"]')?.value ?? previous?.jsonRequestMode ?? 'prompt-only',
        jsonResponseMode: card.querySelector('[data-profile-setting="jsonResponseMode"]')?.value ?? previous?.jsonResponseMode ?? 'strict',
        thinkingLevel: card.querySelector('[data-profile-setting="thinkingLevel"]')?.value ?? DEFAULT_OLLAMA_THINKING_LEVEL,
        localServerPreset: selectedLocalServerPreset,
        billing: {
          inputUsdPerMillion: Number(card.querySelector('[data-profile-setting="billingInputUsdPerMillion"]')?.value ?? previous?.billing?.inputUsdPerMillion ?? 0),
          cachedInputUsdPerMillion: Number(card.querySelector('[data-profile-setting="billingCachedInputUsdPerMillion"]')?.value ?? previous?.billing?.cachedInputUsdPerMillion ?? 0),
          cacheWriteUsdPerMillion: Number(card.querySelector('[data-profile-setting="billingCacheWriteUsdPerMillion"]')?.value ?? previous?.billing?.cacheWriteUsdPerMillion ?? 0),
          outputUsdPerMillion: Number(card.querySelector('[data-profile-setting="billingOutputUsdPerMillion"]')?.value ?? previous?.billing?.outputUsdPerMillion ?? 0),
          profileBudgetUsd: Number(card.querySelector('[data-profile-setting="billingProfileBudgetUsd"]')?.value ?? previous?.billing?.profileBudgetUsd ?? 0),
        },
        generation: {
          depth: Number(card.querySelector('[data-generation-depth]:checked')?.value ?? previous?.generation?.depth ?? 1),
          reasoningProfileId: card.querySelector('[data-generation-profile-id="reasoningProfileId"]')?.value || null,
          outputProfileId: card.querySelector('[data-generation-profile-id="outputProfileId"]')?.value || null,
          critiqueProfileId: card.querySelector('[data-generation-profile-id="critiqueProfileId"]')?.value || null,
          taskOverrides: Object.fromEntries(GENERATION_TASK_OVERRIDE_DEFS.map(({ key }) => {
            const value = card.querySelector(`[data-generation-task-override="${key}"]`)?.value ?? '';
            return [key, value === '' ? null : Number(value)];
          })),
        },
      };
    });
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      executionMode: form.elements.executionMode.value === 'manual' ? 'manual' : 'automatic',
      autoRun: {
        intervalMs: Number(form.elements.intervalMs.value),
        maxConsecutiveSteps: Number(form.elements.maxConsecutiveSteps.value),
        autoConfirmWarnings: form.elements.autoConfirmWarnings.checked,
        autoPublish: form.elements.autoPublish.checked,
      },
      aiOptions: {
        publicHistoryMode: ['full', 'compact', 'delta'].includes(form.elements.publicHistoryMode.value) ? form.elements.publicHistoryMode.value : 'delta',
        apiErrorAction: form.elements.apiErrorAction.value,
        responseRecoveryMode: responseRetryPolicy.normalizeRecoveryMode(form.elements.responseRecoveryMode.value),
        apiLogScope: form.elements.apiLogScope.value,
      },
      profiles,
      assignments: collectVisibleAssignments(),
    };
  }

  return Object.freeze({
    createProfileId, providerOptions, isLocalProvider, isCustomEndpointProvider, localServerPresetOptions, discoveredModels, modelDatalistHtml, enabledProfiles, firstEnabledProfileId, bulkAssignmentProfileId, compatibleEndpointValidationMessage, assignmentValidation, playerProfileSelectHtml, renderAssignmentValidation, canStartWithAiProfiles, isCompatibleEndpointProvider, ollamaThinkingOptionsHtml, profileConfigurationStatus, providerDataRouteMeta, reorderedProfiles, activeProfileId, profileListItemHtml, profileEditorTabButton, generationTestStageCardHtml, generationTestResultHtml, profileCard, profileWorkspaceHtml, assignmentCellHtml, assignmentRows, formatUsage, usageMetricHtml, managementSectionOpenAttribute, captureManagementSectionState, usagePanelHtml, historyStatusRows, assignmentSummary, optionSummary, readinessHtml, renderManagementPage, collectVisibleAssignments, collectManagementForm,
  });
}
