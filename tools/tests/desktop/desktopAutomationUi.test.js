/**
 * 責務: AI管理、公開実況、人間入力、自動進行の主要操作が画面契約を維持することを確認する。
 * 変更ルール: 表示の細部や一時的な実装文字列を固定せず、利用者が行う主要操作、AIプロファイル編集の責務分離、再描画後の操作状態維持を検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

const automationRoot = path.join(__dirname, '../../../app/renderer/js/automation');
function automationSource(filename) {
  let source = fs.readFileSync(path.join(automationRoot, filename), 'utf8');
  source = source.replace(
    /\nimport \{ DATA_SCHEMA_KIND, getCurrentDataSchemaVersion, migrateData \} from '\.\.\/config\/dataCompatibilityAdapter\.js';\s*/u,
    "\nconst { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = window.AiWerewolfDataSchemaVersions;\nconst { migrateData } = window.AiWerewolfDataMigration;\n",
  );
  return esmSourceAsVmScript(source);
}

const AUTOMATION_TEST_EXPORTS = Object.freeze({
  'runtimeAccess.js': ['getRuntime', 'reportInitializationFailure'],
  'automationRunControl.js': ['AutomationStoppedError', 'createRunSession', 'isStopped', 'assertRunning', 'requestStop', 'beginRequest', 'endRequest', 'delayWithAbort', 'completeSession', 'waitForCompletion', 'isAutomationStoppedError'],
  'automaticAiExecutor.js': ['createAutomaticAiExecutor', 'replaceTaskArtifact', 'buildFullCandidateStagePrompt'],
  'desktopAutomationConfig.js': ['createDesktopAutomationConfig'],
  'desktopAutomationManagementView.js': ['createManagementView'],
  'automationStatusController.js': ['createAutomationStatusController'],
  'liveProgressController.js': ['createLiveProgressController'],
  'automaticRunCoordinator.js': ['createAutomaticRunCoordinator'],
  'settingsPersistenceCoordinator.js': ['createSettingsPersistenceCoordinator'],
  'humanTaskCoordinator.js': ['createHumanTaskCoordinator'],
  'manualTaskCoordinator.js': ['createManualTaskCoordinator'],
  'profileEditorController.js': ['createProfileEditorController'],
  'aiProfileTransferController.js': ['createAiProfileTransferController'],
  'assignmentController.js': ['createAssignmentController'],
  'generationTestController.js': ['createGenerationTestController'],
  'aiManagementController.js': ['createAiManagementController'],
  'setupDecorationController.js': ['createSetupDecorationController'],
  'postgameAnalysisAdapter.js': ['createPostgameAnalysisAdapter'],
});

function executeAutomationModule(filename, context) {
  const source = automationSource(filename);
  const names = AUTOMATION_TEST_EXPORTS[filename] ?? [];
  const assignment = names.length
    ? `globalThis.__automationTestModules[${JSON.stringify(filename)}] = { ${names.join(', ')} };`
    : '';
  vm.runInContext(`(function(){${source}\n${assignment}}).call(globalThis);`, context, { filename });
}

function desktopAutomationExecutableSource() {
  const source = automationSource('desktopAutomation.js');
  const bindings = [
    "const runtimeAccess = globalThis.__automationTestModules['runtimeAccess.js'];",
    "const automationRunControl = globalThis.__automationTestModules['automationRunControl.js'];",
    "const automaticAiExecutorApi = globalThis.__automationTestModules['automaticAiExecutor.js'];",
    "const { createDesktopAutomationConfig } = globalThis.__automationTestModules['desktopAutomationConfig.js'];",
    "const { createManagementView } = globalThis.__automationTestModules['desktopAutomationManagementView.js'];",
    "const { createAutomationStatusController } = globalThis.__automationTestModules['automationStatusController.js'];",
    "const { createLiveProgressController } = globalThis.__automationTestModules['liveProgressController.js'];",
    "const { createAutomaticRunCoordinator } = globalThis.__automationTestModules['automaticRunCoordinator.js'];",
    "const { createSettingsPersistenceCoordinator } = globalThis.__automationTestModules['settingsPersistenceCoordinator.js'];",
    "const { createHumanTaskCoordinator } = globalThis.__automationTestModules['humanTaskCoordinator.js'];",
    "const { createManualTaskCoordinator } = globalThis.__automationTestModules['manualTaskCoordinator.js'];",
    "const { createProfileEditorController } = globalThis.__automationTestModules['profileEditorController.js'];",
    "const { createAiProfileTransferController } = globalThis.__automationTestModules['aiProfileTransferController.js'];",
    "const { createAssignmentController } = globalThis.__automationTestModules['assignmentController.js'];",
    "const { createGenerationTestController } = globalThis.__automationTestModules['generationTestController.js'];",
    "const { createAiManagementController } = globalThis.__automationTestModules['aiManagementController.js'];",
    "const { createSetupDecorationController } = globalThis.__automationTestModules['setupDecorationController.js'];",
    "const { createPostgameAnalysisAdapter } = globalThis.__automationTestModules['postgameAnalysisAdapter.js'];",
  ].join('\n');
  return `(function(){${bindings}\n${source}}).call(globalThis);`;
}


function loadAutomationApi() {
  const listeners = new Map();
  const document = {
    readyState: 'loading',
    addEventListener(type, listener) { listeners.set(type, listener); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    confirm: () => true,
    addEventListener() {},
    setTimeout,
    clearTimeout,
    AiWerewolfDemoAi: { generate: () => '{"ok":true}' },
  };
  window.window = window;
  window.__AI_WEREWOLF_RUNTIME_CONTRACT__ = { requiredMethods: ['getAiHistoryStatus'] };
  window.__AI_WEREWOLF_RUNTIME__ = { getAiHistoryStatus: () => [] };
  const context = vm.createContext({
    window,
    document,
    navigator: {},
    structuredClone,
    crypto: globalThis.crypto,
    console,
    Event: class Event {},
    CSS: { escape: (value) => String(value) },
    setTimeout,
    clearTimeout,
    downloadJson: () => {},
    readFileText: async () => '',
    escapeHtml: (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('\"', '&quot;')
      .replaceAll("'", '&#039;'),
  });
  context.__automationTestModules = Object.create(null);
  context.__AI_WEREWOLF_RUNTIME_CONTRACT__ = window.__AI_WEREWOLF_RUNTIME_CONTRACT__;
  context.__AI_WEREWOLF_RUNTIME__ = window.__AI_WEREWOLF_RUNTIME__;
  executeAutomationModule('runtimeAccess.js', context);
  const retryPolicySource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ai/apiRetryPolicy.js'), 'utf8');
  vm.runInContext(retryPolicySource, context, { filename: 'apiRetryPolicy.js' });
  const responseRetryPolicySource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ai/responseRetryPolicy.js'), 'utf8');
  vm.runInContext(responseRetryPolicySource, context, { filename: 'responseRetryPolicy.js' });
  const localLlmConfigSource = fs.readFileSync(path.join(__dirname, '../../../app/shared/localLlmConfig.js'), 'utf8');
  vm.runInContext(localLlmConfigSource, context, { filename: 'localLlmConfig.js' });
  const providerDefaultsSource = fs.readFileSync(path.join(__dirname, '../../../app/shared/providerDefaults.js'), 'utf8');
  vm.runInContext(providerDefaultsSource, context, { filename: 'providerDefaults.js' });
  for (const relativePath of ['schemaVersions.js', 'migrationRegistry.js', 'migrateData.js']) {
    const compatibilitySource = fs.readFileSync(path.join(__dirname, '../../../app/shared/dataCompatibility', relativePath), 'utf8');
    vm.runInContext(compatibilitySource, context, { filename: relativePath });
  }
  const settingsSchemaSource = fs.readFileSync(path.join(__dirname, '../../../app/shared/settingsSchema.js'), 'utf8');
  vm.runInContext(settingsSchemaSource, context, { filename: 'settingsSchema.js' });
  const endpointPolicySource = fs.readFileSync(path.join(__dirname, '../../../app/shared/endpointPolicy.js'), 'utf8');
  vm.runInContext(endpointPolicySource, context, { filename: 'endpointPolicy.js' });
  const dataTransmissionPolicySource = fs.readFileSync(path.join(__dirname, '../../../app/shared/dataTransmissionPolicy.js'), 'utf8');
  vm.runInContext(dataTransmissionPolicySource, context, { filename: 'dataTransmissionPolicy.js' });
  for (const filename of ['automationRunControl.js', 'automaticAiExecutor.js', 'desktopAutomationConfig.js', 'desktopAutomationManagementView.js', 'automationStatusController.js', 'liveProgressController.js', 'automaticRunCoordinator.js', 'settingsPersistenceCoordinator.js', 'humanTaskCoordinator.js', 'manualTaskCoordinator.js', 'profileEditorController.js', 'aiProfileTransferController.js', 'assignmentController.js', 'generationTestController.js', 'aiManagementController.js', 'setupDecorationController.js', 'postgameAnalysisAdapter.js']) {
    executeAutomationModule(filename, context);
  }
  window.AiWerewolfEndpointPolicy = context.AiWerewolfEndpointPolicy;
  window.AiWerewolfDataTransmissionPolicy = context.AiWerewolfDataTransmissionPolicy;
  window.AiWerewolfApiConversationStore = context.AiWerewolfApiConversationStore;
  const source = desktopAutomationExecutableSource();
  vm.runInContext(source, context, { filename: 'desktopAutomation.js' });
  return window.AiWerewolfDesktopAutomation;
}

function sampleState() {
  return {
    game: { title: 'テスト村', day: 1, phase: 'discussion' },
    players: [
      { id: 'p1', name: 'ずんだもん', controller: 'ai', alive: true },
      { id: 'p2', name: '四国めたん', controller: 'human', alive: true },
      { id: 'p3', name: '東北きりたん', controller: 'ai', alive: false },
      { id: 'p4', name: '東北ずん子', controller: 'ai', alive: true },
    ],
    events: [
      { id: 'e1', sequence: 1, day: 1, type: 'public-speech', actorId: 'p1', status: 'published', audience: { type: 'public' }, payload: { text: '公開発言です。' } },
      { id: 'e2', sequence: 2, day: 1, type: 'private-note', actorId: 'p3', status: 'published', audience: { type: 'private', targetIds: ['p3'] }, payload: { text: '秘密の役職情報' } },
      { id: 'e3', sequence: 3, day: 1, type: 'system', actorId: null, status: 'published', audience: { type: 'public' }, payload: { text: '公開進行です。' } },
      { id: 'e4', sequence: 4, day: 1, type: 'public-speech', actorId: 'p2', status: 'draft', audience: { type: 'public' }, payload: { text: '未公開です。' } },
    ],
  };
}

test('Mainのプロバイダー既定値はshared/providerDefaultsと同一である', () => {
  const sharedDefaults = require('../../../app/shared/providerDefaults.js').PROVIDER_DEFAULTS;
  const mainConstants = require('../../../app/main/llm/providerConstants.js');
  assert.deepEqual(mainConstants.PROVIDER_DEFAULTS, sharedDefaults);
});
test('AI実行操作をAI管理画面へ集約する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /<h2>AI管理<\/h2>/u);
  assert.match(html, /AIへのデータ送信について/u);
  assert.match(html, /data-ai-action="open-data-privacy"/u);
  assert.match(html, /アプリ内デモ/u);
  assert.match(html, /data-ai-action="step"/u);
  assert.match(html, /data-ai-action="toggle-run"/u);
  assert.match(html, /data-ai-action="open-live"/u);
  assert.match(html, /data-ai-action="open-manual"/u);
  assert.match(html, /手動プロンプト/u);
  assert.match(html, /API使用量/u);
  assert.match(html, /公開履歴の送信方式/u);
  assert.match(html, /過去履歴を圧縮し、前回正常回答後は全文で送信/u);
  assert.match(html, /前回の正常回答後に増えた公開履歴だけを送信/u);
  assert.match(html, /data-ai-action="resync-player"/u);
  assert.match(html, /data-ai-action="resync-all"/u);
});

test('AIプロファイルの並び替え計算は境界位置を越えない', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /data-ai-action="move-profile-up"/u);
  assert.match(html, /data-ai-action="move-profile-down"/u);
  const profiles = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  assert.equal(api.reorderedProfiles(profiles, 'p2', -1).map((profile) => profile.id).join(','), 'p2,p1,p3');
  assert.equal(api.reorderedProfiles(profiles, 'p2', 1).map((profile) => profile.id).join(','), 'p1,p3,p2');
  assert.equal(api.reorderedProfiles(profiles, 'p1', -1).map((profile) => profile.id).join(','), 'p1,p2,p3');

});
test('API使用量はAIプロファイルを正本として個別または全体を確認付きリセットできる', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /人狼・チャットルームなど全用途をAIプロファイル別に集計/u);
  assert.match(html, /このプロファイルの累計/u);
  assert.match(html, /data-ai-action="reset-profile-usage"/u);
  assert.match(html, /data-ai-action="reset-all-usage"/u);
  assert.match(html, /詳細APIログは削除しません/u);

});
test('料金上限はゲームIDではなくAIプロファイル累計へ適用する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /プロファイル利用上限（USD）/u);
  assert.match(html, /data-profile-setting="billingProfileBudgetUsd"/u);
  assert.doesNotMatch(html, /1ゲームの上限/u);
});
test('ローカルLLM正式対応の設定・モデル取得・認証任意表示を提供する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /ローカルLLM（OpenAI互換）/u);
  assert.match(html, /data-ai-action="add-profile"/u);
  assert.doesNotMatch(html, /data-ai-action="add-local-profile"/u);
  assert.match(html, /data-local-model-action/u);
  assert.match(html, /data-profile-setting="contextWindowTokens"/u);
  assert.match(html, /data-profile-setting="promptCacheMode"/u);
  assert.match(html, /通常は「過去履歴を圧縮」を推奨します。/u);
  assert.match(html, /data-profile-setting="jsonRequestMode"/u);
  assert.match(html, /data-profile-setting="jsonResponseMode"/u);
  assert.match(html, /data-profile-setting="thinkingLevel"/u);
  assert.match(html, /none：Thinkingなし（最速）/u);
  assert.match(html, /low：少ない（軽量）/u);
  assert.match(html, /medium：標準/u);
  assert.match(html, /high：多い/u);
  assert.match(html, /max：最大/u);
  assert.match(html, /noneはThinkingを行いません。lowからmaxへ上げるほど推論量が増え/u);
  assert.match(html, /APIキーは必要な場合だけ設定してください。未設定の認証情報は送信されません。/u);
});
test('AIプロファイル編集は一覧と選択中編集を分離し設定責務を3タブへ整理する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  const workspace = html.indexOf('class="ai-profile-workspace"');
  const sidebar = html.indexOf('class="ai-profile-sidebar"', workspace);
  const editor = html.indexOf('class="ai-profile-editors"', sidebar);
  const connection = html.indexOf('data-ai-profile-tab="connection"', editor);
  const response = html.indexOf('data-ai-profile-tab="response"', connection);
  const generation = html.indexOf('data-ai-profile-tab="generation"', response);
  assert.ok(workspace >= 0 && sidebar > workspace && editor > sidebar);
  assert.ok(connection > editor && response > connection && generation > response);
  assert.match(html, /data-ai-profile-select="profile-demo"/u);
  assert.match(html, /data-ai-profile-tab-panel="connection"/u);
  assert.match(html, /data-ai-profile-tab-panel="response"[^>]*hidden/u);
  assert.match(html, /data-ai-profile-tab-panel="generation"[^>]*hidden/u);
  assert.match(html, /class="ai-profile-editor-head"/u);
  assert.match(html, /data-profile-setting="enabled"/u);
  assert.match(html, /class="ai-profile-editor-actions"/u);
  assert.match(html, /data-ai-action="duplicate-profile"[^>]*>複製<\/button>/u);
  assert.match(html, /data-ai-action="delete-profile"[^>]*>削除<\/button>/u);
  assert.doesNotMatch(html, /ai-profile-menu|プロファイル操作">⋮/u);
  assert.match(html, /AIの接続先、認証情報、使用するモデルを設定します。/u);
  assert.match(html, /出力上限、応答形式、プロンプトキャッシュ、Thinking量など、モデルごとの詳細設定を行います。/u);
  assert.match(html, /1つの回答を作る工程と担当AIを設定します。/u);

  const connectionPanel = html.slice(html.indexOf('data-ai-profile-tab-panel="connection"'), html.indexOf('data-ai-profile-tab-panel="response"'));
  const responsePanel = html.slice(html.indexOf('data-ai-profile-tab-panel="response"'), html.indexOf('data-ai-profile-tab-panel="generation"'));
  const generationPanel = html.slice(html.indexOf('data-ai-profile-tab-panel="generation"'));
  assert.match(connectionPanel, /APIエンドポイント/u);
  assert.match(connectionPanel, /data-ai-action="test-profile"/u);
  assert.match(connectionPanel, /data-ai-action="list-profile-models"/u);
  assert.doesNotMatch(connectionPanel, /最大出力トークン|生成深度/u);
  assert.match(responsePanel, /最大出力トークン/u);
  assert.match(responsePanel, /JSON要求方式/u);
  assert.doesNotMatch(responsePanel, /APIエンドポイント|生成深度/u);
  assert.match(generationPanel, /生成深度/u);
  assert.match(generationPanel, /data-ai-action="test-generation-pipeline"/u);
  assert.doesNotMatch(generationPanel, /APIエンドポイント/u);

});
test('AI管理画面は生成深度・工程担当・上書き・接続テストを提供する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /生成深度/u);
  assert.match(html, /深度1[\s\S]*直接生成/u);
  assert.match(html, /深度2[\s\S]*直接生成＋公開発言校正/u);
  assert.match(html, /深度3[\s\S]*構造草案＋発言化/u);
  assert.match(html, /深度4[\s\S]*構造草案＋発言化＋公開発言校正/u);
  assert.match(html, /判断・出力項目の担当AI/u);
  assert.match(html, /応答文作成の担当AI/u);
  assert.match(html, /公開発言校正の担当AI/u);
  assert.match(html, /タスク別に生成深度を変更/u);
  assert.match(html, /1タスクあたりの最大AI呼び出し数/u);
  assert.match(html, /公開発言校正は昼の発言だけに適用します/u);
  assert.match(html, /生成工程をテスト/u);
  assert.match(html, /1回のAI呼び出しで、ゲーム判断と完成した応答をまとめて生成します。/u);
  assert.match(html, /1回目で完成した応答を生成し、2回目で昼の公開発言だけを校正します。/u);
  assert.match(html, /1回目でゲーム判断と出力項目を決め、2回目で完成した応答文にします。/u);
  assert.match(html, /ゲーム判断と出力項目の決定、応答文の作成、昼の公開発言の校正を3回に分けます。/u);
  assert.match(html, /完成応答を生成: 選択中のAI[\s\S]*システム検証/u);
  assert.match(html, /公開発言では、選択中のAIが完成応答を生成します。/u);
  assert.match(html, /騙りCOをしている人狼陣営の発言が、主張中の役職として自然か/u);
  assert.match(html, /校正対象は昼の公開発言本文だけです/u);
  assert.doesNotMatch(html, /レビュー/u);
  assert.doesNotMatch(html, /現在と同じ方式|通常1回|通常2回|通常3回/u);
  assert.match(html, /上で選んだ生成深度を使用/u);
  assert.match(html, /通常は「過去履歴を圧縮」を推奨します。/u);
  assert.match(html, /最初のJSONオブジェクトだけを取り出す/u);
  assert.match(html, /現在の設定でテスト回答を生成し、結果を比較できます。/u);

});
test('全自動でもAIプロファイル未設定を参加者別の手動生成として許可する', () => {
  const api = loadAutomationApi();
  const state = sampleState();

  assert.equal(api.canStartWithAiProfiles(state), true);
  assert.match(api.playerProfileSelectHtml(state.players[0]), /<option value="" selected>未設定（手動生成）<\/option>/u);
  assert.match(api.renderManagementPage(state), /API 0人 \/ 手動生成 3人/u);
  assert.match(api.renderManagementPage(state), /未設定の参加者だけ手動プロンプトで進めます/u);
});


test('準備画面のAI検証表示は開始ボタンと同じ検証コンテナへ挿入する', () => {
  const inserted = [];
  const startButton = { dataset: {}, disabled: false, parentNode: null };
  const validationRoot = {
    children: [startButton],
    querySelector(selector) {
      if (selector === '[data-action="start-game"]') return startButton;
      if (selector === '.desktop-ai-validation-list') return this.children.find((child) => child.className === 'desktop-ai-validation-list') ?? null;
      return null;
    },
    insertBefore(node, referenceNode) {
      if (referenceNode !== null && referenceNode.parentNode !== this) {
        throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
      }
      const index = referenceNode === null ? this.children.length : this.children.indexOf(referenceNode);
      node.parentNode = this;
      this.children.splice(index, 0, node);
      inserted.push(node);
      return node;
    },
  };
  startButton.parentNode = validationRoot;

  const heading = { textContent: '開始前確認' };
  const validationPanel = {
    querySelector(selector) {
      if (selector === ':scope > h3') return heading;
      if (selector === '[data-setup-validation]') return validationRoot;
      if (selector === '[data-action="start-game"]') return startButton;
      if (selector === '.desktop-ai-validation-list') return null;
      return null;
    },
    insertBefore(node, referenceNode) {
      if (referenceNode !== null && referenceNode.parentNode !== this) {
        throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
      }
      node.parentNode = this;
      inserted.push(node);
      return node;
    },
  };
  const list = {
    closest() { return null; },
    querySelector() { return null; },
  };
  const document = {
    activeElement: null,
    querySelector(selector) {
      if (selector === '#app-content .player-editor-list') return list;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '#app-content .panel' ? [validationPanel] : [];
    },
    createElement() {
      return { className: '', dataset: {}, innerHTML: '', parentNode: null };
    },
  };
  const window = { setTimeout, clearTimeout };
  const context = vm.createContext({
    window,
    document,
    DOMException,
    CSS: { escape: (value) => String(value) },
    console,
    setTimeout,
    clearTimeout,
  });
  context.__automationTestModules = Object.create(null);
  executeAutomationModule('setupDecorationController.js', context);
  const { createSetupDecorationController } = context.__automationTestModules['setupDecorationController.js'];
  const controller = createSetupDecorationController({
    activeTab: () => 'setup',
    assignmentValidation: () => ({ ok: true, errors: [] }),
    controller: {
      settings: { executionMode: 'automatic', profiles: [] },
      bulkAssignmentProfileId: '',
      setupDecorationTimer: null,
    },
    currentGameState: () => ({ game: { phase: 'setup' }, players: [] }),
    escapeHtml: (value) => String(value ?? ''),
    isManagementTabActive: () => false,
    playerProfileSelectHtml: () => '',
    runtime: () => ({ refreshTab() {} }),
  });

  assert.doesNotThrow(() => controller.decorateSetupView());
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].parentNode, validationRoot);
  assert.equal(validationRoot.children[0], inserted[0]);
  assert.equal(validationRoot.children[1], startButton);
});
