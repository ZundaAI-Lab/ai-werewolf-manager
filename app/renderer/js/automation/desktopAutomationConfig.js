/**
 * 責務: デスクトップAI実行の生成深度・工程、料金設定を含む設定初期値、トークン・実績料金の使用量集計、設定画面用の生成工程表示を提供する。
 * 変更ルール: ゲーム状態やDOM全体を更新せず、設定正規化と工程表示だけを扱う。プロバイダー既定エンドポイント・既定モデルはshared/providerDefaults.jsを正本とし、ここへ複製しない。プロファイル順序は呼出側のprofiles配列を正本とする。
 */

export function createDesktopAutomationConfig({
  localLlmConfig,
  providerDefaults,
  settingsSchema,
  getController,
  getProfileById,
  escapeHtml,
}) {
  const {
    DEFAULT_OLLAMA_THINKING_LEVEL,
    LOCAL_OPENAI_PROVIDER,
    LOCAL_SERVER_PRESETS,
    OLLAMA_THINKING_LEVELS,
  } = localLlmConfig;
  const { SETTINGS_SCHEMA_VERSION } = settingsSchema;

  const PROVIDER_LABELS = Object.freeze({
    demo: 'デモAI（API不要）',
    openai: 'OpenAI Responses API',
    anthropic: 'Anthropic Messages API',
    gemini: 'Google Gemini API',
    xai: 'xAI',
    deepseek: 'DeepSeek',
    qwen: 'Qwen / DashScope',
    kimi: 'Kimi / Moonshot',
    glm: 'GLM / Z.ai',
    'openai-compatible': 'OpenAI互換API',
    [LOCAL_OPENAI_PROVIDER]: 'ローカルLLM（OpenAI互換）',
  });

  const OLLAMA_THINKING_LEVEL_LABELS = Object.freeze({
    none: 'none：Thinkingなし（最速）',
    low: 'low：少ない（軽量）',
    medium: 'medium：標準',
    high: 'high：多い',
    max: 'max：最大',
  });

  const { PROVIDER_DEFAULTS } = providerDefaults;


  const GENERATION_TASK_OVERRIDE_DEFS = Object.freeze([
    Object.freeze({ key: 'speech', label: '公開発言' }),
    Object.freeze({ key: 'vote', label: '投票' }),
    Object.freeze({ key: 'nightAction', label: '夜行動' }),
    Object.freeze({ key: 'privateConversation', label: '秘密会話' }),
    Object.freeze({ key: 'resultImpression', label: '勝敗後感想' }),
    Object.freeze({ key: 'memoConsolidate', label: '内部メモ整理' }),
  ]);

  const GENERATION_DEPTH_DEFS = Object.freeze([
    Object.freeze({ depth: 1, label: '直接生成', description: 'ゲーム判断からキャラクター口調の完成応答までを1回で生成します。', stages: Object.freeze(['direct']), calls: 1 }),
    Object.freeze({ depth: 2, label: '判断＋キャラ発言化', description: '1回目は直接生成と同じ判断材料・人物の推理傾向で内容を決め、2回目で意味を変えずキャラクターらしい発言へ仕上げます。', stages: Object.freeze(['decide', 'render']), calls: 2 }),
    Object.freeze({ depth: 3, label: '客観分析＋最終回答', description: '1回目は人物設定を使わず自由記述で状況を分析し、2回目で分析を参考に人物として判断・発言します。', stages: Object.freeze(['analyze', 'finalize']), calls: 2 }),
    Object.freeze({ depth: 4, label: '客観分析＋批判的検証＋最終回答', description: '客観分析を別AI呼び出しで批判的に検証し、その両方を参考に人物として最終判断・発言します。', stages: Object.freeze(['analyze', 'critique', 'finalize']), calls: 3 }),
  ]);

  const GENERATION_STAGE_LABELS = Object.freeze({
    direct: '完成応答を直接生成',
    decide: '判断内容を決定',
    analyze: '客観的に分析',
    critique: '分析を批判的に検証',
    finalize: '人物として最終回答',
    render: 'キャラ口調へ発言化',
  });


  const COPY_BOUNDARY_STOP_CODES = new Set([
    'PUBLIC_SPEECH_COPIES_OTHER_PLAYER',
    'PUBLIC_SPEECH_COPIES_PRIVATE_DIALOGUE',
    'PUBLIC_SPEECH_REUSES_PRIVATE_DIALOGUE',
  ]);

  function generationFailureIssueCodes(error, pipelineResult = null) {
    const codes = new Set();
    const collect = (issues) => {
      for (const issue of issues ?? []) {
        const code = String(issue?.code ?? '');
        if (code) codes.add(code);
      }
    };
    collect(error?.issues);
    collect(error?.evaluation?.issues);
    collect(pipelineResult?.evaluation?.issues);
    for (const stage of error?.generationRun?.stages ?? pipelineResult?.generationRun?.stages ?? []) collect(stage?.issues);
    return codes;
  }

  function generationFailureRequiresStop(error, pipelineResult = null) {
    const codes = generationFailureIssueCodes(error, pipelineResult);
    return [...COPY_BOUNDARY_STOP_CODES].some((code) => codes.has(code));
  }

  function defaultGenerationSettings() {
    return {
      depth: 1,
      reasoningProfileId: null,
      outputProfileId: null,
      critiqueProfileId: null,
      taskOverrides: Object.fromEntries(GENERATION_TASK_OVERRIDE_DEFS.map(({ key }) => [key, null])),
    };
  }

  function normalizeGenerationSettings(generation) {
    const defaults = defaultGenerationSettings();
    const depth = Number(generation?.depth);
    return {
      depth: [1, 2, 3, 4].includes(depth) ? depth : 1,
      reasoningProfileId: generation?.reasoningProfileId ?? null,
      outputProfileId: generation?.outputProfileId ?? null,
      critiqueProfileId: generation?.critiqueProfileId ?? null,
      taskOverrides: Object.fromEntries(GENERATION_TASK_OVERRIDE_DEFS.map(({ key }) => {
        const value = generation?.taskOverrides?.[key];
        return [key, [1, 2, 3, 4].includes(Number(value)) ? Number(value) : null];
      })),
    };
  }

  function generationDepthDef(depth) {
    return GENERATION_DEPTH_DEFS.find((item) => item.depth === Number(depth)) ?? GENERATION_DEPTH_DEFS[0];
  }

  function generationStagesForTask(depth) {
    return [...generationDepthDef(depth).stages];
  }

  function effectiveGenerationDepthForTask(generation, taskKey) {
    const normalized = normalizeGenerationSettings(generation);
    return normalized.taskOverrides[taskKey] ?? normalized.depth;
  }

  function generationTaskPlans(generation) {
    const normalized = normalizeGenerationSettings(generation);
    return GENERATION_TASK_OVERRIDE_DEFS.map(({ key, label }) => {
      const depth = effectiveGenerationDepthForTask(normalized, key);
      return { key, label, depth, stages: generationStagesForTask(depth, key) };
    });
  }

  function generationSummary(profile, generation) {
    const settings = normalizeGenerationSettings(generation);
    const definition = generationDepthDef(settings.depth);
    if (!definition.stages.includes('critique')) return `深度${definition.depth}・${definition.label}`;
    const reviewer = generationExecutorProfile(profile, settings, 'critique');
    const reviewerLabel = reviewer?.id === profile.id
      ? '自己検証'
      : `「${reviewer?.label ?? `不明なプロファイル（${settings.critiqueProfileId ?? ''}）`}」による批判的検証`;
    return `深度4・客観分析 → ${reviewerLabel} → 最終回答`;
  }

  function generationFlowHtml(profile, generation) {
    const normalized = normalizeGenerationSettings(generation);
    const stages = generationDepthDef(normalized.depth).stages;
    const stageHtml = stages.map((stageId, index) => {
      const executor = generationExecutorProfile(profile, normalized, stageId);
      const executorLabel = executor?.id === profile.id ? '選択中のAI' : executor?.label ?? `不明なプロファイル（${normalized[generationExecutorReferenceKey(stageId)] ?? ''}）`;
      return `${index ? '<span class="ai-generation-arrow" aria-hidden="true">→</span>' : ''}<span class="ai-generation-stage">${escapeHtml(GENERATION_STAGE_LABELS[stageId])}: ${escapeHtml(executorLabel)}</span>`;
    }).join('');
    return `${stageHtml}<span class="ai-generation-arrow" aria-hidden="true">→</span><span class="ai-generation-stage is-system">システム検証</span>`;
  }

  function generationProfileOptions(selectedProfileId, ownerProfileId) {
    const ownSelected = selectedProfileId == null;
    const options = [`<option value=""${ownSelected ? ' selected' : ''}>選択中のプロファイル</option>`];
    for (const profile of getController().settings.profiles) {
      if (profile.id === ownerProfileId) continue;
      const suffix = profile.enabled ? '' : '（無効）';
      options.push(`<option value="${escapeHtml(profile.id)}"${profile.id === selectedProfileId ? ' selected' : ''}>${escapeHtml(profile.label)}${suffix}</option>`);
    }
    return options.join('');
  }

  function generationDepthOptionsHtml(depth, profileId) {
    return GENERATION_DEPTH_DEFS.map((definition) => `<label class="ai-depth-option${definition.depth === Number(depth) ? ' is-selected' : ''}"><input type="radio" data-generation-depth name="generation-depth-${escapeHtml(profileId)}" value="${definition.depth}" ${definition.depth === Number(depth) ? 'checked' : ''}><span><strong>深度${definition.depth} ${escapeHtml(definition.label)}</strong><small>${escapeHtml(definition.description)}</small></span></label>`).join('');
  }

  function generationTaskOverrideHtml(taskOverrides) {
    return GENERATION_TASK_OVERRIDE_DEFS.map(({ key, label }) => {
      const value = taskOverrides?.[key] ?? null;
      return `<label class="field"><span>${escapeHtml(label)}</span><select data-generation-task-override="${escapeHtml(key)}"><option value=""${value == null ? ' selected' : ''}>上で選んだ生成深度を使用</option>${GENERATION_DEPTH_DEFS.map(({ depth, label: depthLabel }) => `<option value="${depth}"${Number(value) === depth ? ' selected' : ''}>深度${depth}: ${escapeHtml(depthLabel)}</option>`).join('')}</select></label>`;
    }).join('');
  }

  function generationRequiredStages(generation) {
    return new Set(generationTaskPlans(generation).flatMap((plan) => plan.stages));
  }

  function generationExecutorReferenceKey(stageId) {
    return ({ decide: 'reasoningProfileId', analyze: 'reasoningProfileId', critique: 'critiqueProfileId', render: 'outputProfileId', finalize: 'outputProfileId' })[stageId] ?? null;
  }

  function generationExecutorProfile(profile, generation, stageId) {
    const referenceKey = generationExecutorReferenceKey(stageId);
    if (!referenceKey) return profile;
    const referenceId = generation?.[referenceKey] ?? null;
    return referenceId ? getProfileById(referenceId) ?? null : profile;
  }

  function generationMaximumNormalCalls(generation) {
    return Math.max(...generationTaskPlans(generation).map((plan) => plan.stages.length));
  }

  function generationCallBreakdown(profile, generation) {
    const maximumByProfile = new Map();
    generationTaskPlans(generation).forEach((plan) => {
      const planCounts = new Map();
      plan.stages.forEach((stageId) => {
        const executor = generationExecutorProfile(profile, generation, stageId) ?? profile;
        planCounts.set(executor.id, { label: executor.label, count: (planCounts.get(executor.id)?.count ?? 0) + 1 });
      });
      planCounts.forEach((item, profileId) => {
        const previous = maximumByProfile.get(profileId);
        if (!previous || item.count > previous.count) maximumByProfile.set(profileId, item);
      });
    });
    return [...maximumByProfile.values()].map((item) => `${item.label}: 最大${item.count}回`).join(' / ');
  }

  function generationExecutionPhrase(profile, generation, depth, taskKey = 'speech') {
    return generationStagesForTask(depth, taskKey).map((stageId) => {
      const executor = generationExecutorProfile(profile, generation, stageId) ?? profile;
      return `${executor.id === profile.id ? '選択中のAI' : executor.label}が${GENERATION_STAGE_LABELS[stageId]}`;
    }).join('し、');
  }

  function naturalGenerationSummary(profile, generation) {
    const normalized = normalizeGenerationSettings(generation);
    return generationTaskPlans(normalized)
      .map(({ key, label, depth }) => `${label}では、${generationExecutionPhrase(profile, normalized, depth, key)}します。`)
      .join(' ');
  }

  function generationSectionHtml(profile) {
    const generation = normalizeGenerationSettings(profile.generation);
    const definition = generationDepthDef(generation.depth);
    const requiredStages = generationRequiredStages(generation);
    const firstThinkingNeeded = requiredStages.has('decide') || requiredStages.has('analyze');
    const renderNeeded = requiredStages.has('render') || requiredStages.has('finalize');
    const reviewNeeded = requiredStages.has('critique');
    return `<section class="ai-generation-section full" data-generation-section>
      <div class="ai-generation-summary"><div><h4>生成深度</h4><p>1つのAI回答を作るまでに、判断とキャラクター表現を何工程に分けるか設定します。選んだ深度はモデル名に関係なく適用されます。</p></div><span data-generation-summary>${escapeHtml(generationSummary(profile, generation))}</span></div>
      <div class="ai-depth-options">${generationDepthOptionsHtml(generation.depth, profile.id)}</div>
      <div class="ai-generation-flow" data-generation-flow>${generationFlowHtml(profile, generation)}</div>
      <div class="ai-stage-assignment-grid">
        <label class="field" data-generation-stage-assignment="thinking" ${firstThinkingNeeded ? '' : 'hidden'}><span>第1工程（判断／客観分析）の担当AI</span><select data-generation-profile-id="reasoningProfileId">${generationProfileOptions(generation.reasoningProfileId, profile.id)}</select></label>
        <label class="field" data-generation-stage-assignment="render" ${renderNeeded ? '' : 'hidden'}><span>第2/最終工程（発言化／最終回答）の担当AI</span><select data-generation-profile-id="outputProfileId">${generationProfileOptions(generation.outputProfileId, profile.id)}</select></label>
        <label class="field" data-generation-stage-assignment="review" ${reviewNeeded ? '' : 'hidden'}><span>批判的検証の担当AI</span><select data-generation-profile-id="critiqueProfileId">${generationProfileOptions(generation.critiqueProfileId, profile.id)}</select></label>
      </div>
      <div class="ai-review-policy" data-review-policy ${reviewNeeded ? '' : 'hidden'}><strong>批判的検証では客観分析をゲーム情報と照合します。</strong><span>✓ 事実・対象・時系列の取り違え</span><span>✓ 根拠から結論への飛躍</span><span>✓ 多数意見への過度な依存</span><span>✓ 別仮説や有力候補の見落とし</span><span>✓ 役職・陣営目標との不整合</span><small>妥当な部分は無理に否定せず、問題点と解釈し直すべき点を自由記述で整理します。</small></div>
      <details class="ai-task-depth-grid"><summary>タスク別に生成深度を変更</summary><div class="form-grid">${generationTaskOverrideHtml(generation.taskOverrides)}</div></details>
      <div class="ai-generation-call-summary" data-generation-call-summary>1タスクあたりの最大AI呼び出し数: ${generationMaximumNormalCalls(generation)}回 / 担当別上限: ${escapeHtml(generationCallBreakdown(profile, generation))}<small>各深度の工程はタスク種別を問わず同じ順序で適用します。通信エラー時の再試行はこの回数に含みません。</small></div>
      <div class="ai-generation-summary" data-generation-natural-summary>${escapeHtml(naturalGenerationSummary(profile, generation))}</div>
    </section>`;
  }

  function updateGenerationCardUi(card) {
    if (!card) return;
    const checked = card.querySelector('[data-generation-depth]:checked');
    const depth = Number(checked?.value ?? 1);
    const taskOverrides = Object.fromEntries([...card.querySelectorAll('[data-generation-task-override]')].map((select) => [select.dataset.generationTaskOverride, select.value ? Number(select.value) : null]));
    const profile = getProfileById(card.dataset.aiProfileId);
    const generation = normalizeGenerationSettings({
      depth,
      taskOverrides,
      reasoningProfileId: card.querySelector('[data-generation-profile-id="reasoningProfileId"]')?.value || null,
      outputProfileId: card.querySelector('[data-generation-profile-id="outputProfileId"]')?.value || null,
      critiqueProfileId: card.querySelector('[data-generation-profile-id="critiqueProfileId"]')?.value || null,
    });
    const requiredStages = generationRequiredStages(generation);
    card.querySelectorAll('.ai-depth-option').forEach((option) => option.classList.toggle('is-selected', option.contains(checked)));
    const flow = card.querySelector('[data-generation-flow]');
    if (flow && profile) flow.innerHTML = generationFlowHtml(profile, generation);
    const summary = card.querySelector('[data-generation-summary]');
    if (summary) summary.textContent = generationSummary(profile, generation);
    const callSummary = card.querySelector('[data-generation-call-summary]');
    if (callSummary && profile) callSummary.innerHTML = `1タスクあたりの最大AI呼び出し数: ${generationMaximumNormalCalls(generation)}回 / 担当別上限: ${escapeHtml(generationCallBreakdown(profile, generation))}<small>各深度の工程はタスク種別を問わず同じ順序で適用します。通信エラー時の再試行はこの回数に含みません。</small>`;
    const naturalSummary = card.querySelector('[data-generation-natural-summary]');
    if (naturalSummary && profile) naturalSummary.textContent = naturalGenerationSummary(profile, generation);
    const thinkingField = card.querySelector('[data-generation-stage-assignment="thinking"]');
    if (thinkingField) thinkingField.hidden = !(requiredStages.has('decide') || requiredStages.has('analyze'));
    const renderField = card.querySelector('[data-generation-stage-assignment="render"]');
    if (renderField) renderField.hidden = !(requiredStages.has('render') || requiredStages.has('finalize'));
    const reviewField = card.querySelector('[data-generation-stage-assignment="review"]');
    if (reviewField) reviewField.hidden = !requiredStages.has('critique');
    const reviewPolicy = card.querySelector('[data-review-policy]');
    if (reviewPolicy) reviewPolicy.hidden = !requiredStages.has('critique');
  }



  function defaultSettings() {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      executionMode: 'automatic',
      autoRun: { intervalMs: 450, maxConsecutiveSteps: 500, autoConfirmWarnings: true, autoPublish: true },
      aiOptions: { publicHistoryMode: 'delta', apiErrorAction: 'retry', responseRecoveryMode: 'repair-regenerate', apiLogScope: 'errors' },
      profiles: [{
        id: 'profile-demo',
        label: 'デモAI',
        provider: 'demo',
        model: 'demo-balanced',
        endpoint: '',
        enabled: true,
        hasApiKey: false,
        timeoutMs: 180000,
        maxOutputTokens: 8192,
        chatTokenLimitField: 'max_completion_tokens',
        contextWindowTokens: 131072,
        promptCacheMode: 'auto',
        anthropicCacheTtl: 'auto',
        jsonRequestMode: 'prompt-only',
        jsonResponseMode: 'strict',
        thinkingLevel: DEFAULT_OLLAMA_THINKING_LEVEL,
        localServerPreset: 'custom',
        billing: { inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 0, profileBudgetUsd: 0 },
        generation: defaultGenerationSettings(),
      }],
      assignments: {},
    };
  }


  function emptyUsage() {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0, calls: 0, failedCalls: 0, retries: 0, taskTotalTokens: 0, tasks: 0, regeneratedTasks: 0 };
  }

  function addUsage(target, usage, {
    failed = false,
    retry = false,
    isTaskCall = false,
    taskStart = false,
    regeneratedTask = false,
  } = {}) {
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'costUsd']) {
      const value = Number(usage?.[key] ?? 0);
      target[key] += Number.isFinite(value) ? Math.max(0, value) : 0;
    }
    const totalTokens = Number(usage?.totalTokens ?? 0);
    target.calls += 1;
    if (failed) target.failedCalls += 1;
    if (retry) target.retries += 1;
    if (isTaskCall && Number.isFinite(totalTokens)) target.taskTotalTokens += Math.max(0, totalTokens);
    if (taskStart) target.tasks += 1;
    if (regeneratedTask) target.regeneratedTasks += 1;
    return target;
  }

  return Object.freeze({
    SETTINGS_SCHEMA_VERSION, PROVIDER_LABELS, OLLAMA_THINKING_LEVEL_LABELS, PROVIDER_DEFAULTS, GENERATION_TASK_OVERRIDE_DEFS, GENERATION_DEPTH_DEFS, GENERATION_STAGE_LABELS, COPY_BOUNDARY_STOP_CODES, generationFailureIssueCodes, generationFailureRequiresStop, defaultGenerationSettings, normalizeGenerationSettings, generationDepthDef, generationStagesForTask, effectiveGenerationDepthForTask, generationTaskPlans, generationSummary, generationFlowHtml, generationProfileOptions, generationDepthOptionsHtml, generationTaskOverrideHtml, generationRequiredStages, generationExecutorProfile, generationMaximumNormalCalls, generationCallBreakdown, generationExecutionPhrase, naturalGenerationSummary, generationSectionHtml, updateGenerationCardUi, defaultSettings, emptyUsage, addUsage,
  });
}
