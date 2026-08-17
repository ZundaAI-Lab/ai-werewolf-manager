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
const { pathToFileURL } = require('node:url');

const automationRoot = path.join(__dirname, '../../../app/renderer/js/automation');
function automationSource(filename) {
  return fs.readFileSync(path.join(automationRoot, filename), 'utf8')
    .replace(/\nimport \{ escapeHtml \} from '\.\.\/shared\/utils\.js';\s*/u, '\n')
    .replace(/\nimport \{ downloadJson, readFileText \} from '\.\.\/shared\/utils\.js';\s*/u, '\n')
    .replace(/\nimport \{ DATA_SCHEMA_KIND, getCurrentDataSchemaVersion, migrateData \} from '\.\.\/config\/dataCompatibilityAdapter\.js';\s*/u, "\nconst { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } = window.AiWerewolfDataSchemaVersions;\nconst { migrateData } = window.AiWerewolfDataMigration;\n")
    .replace(/\nexport \{\};\s*$/u, '\n');
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
  const runtimeAccessSource = automationSource('runtimeAccess.js');
  vm.runInContext(runtimeAccessSource, context, { filename: 'runtimeAccess.js' });
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
    const moduleSource = automationSource(filename);
    vm.runInContext(moduleSource, context, { filename });
  }
  window.AiWerewolfEndpointPolicy = context.AiWerewolfEndpointPolicy;
  window.AiWerewolfDataTransmissionPolicy = context.AiWerewolfDataTransmissionPolicy;
  window.AiWerewolfApiConversationStore = context.AiWerewolfApiConversationStore;
  window.AiWerewolfAutomationRunControl = context.AiWerewolfAutomationRunControl;
  window.AiWerewolfAutomaticAiExecutor = context.AiWerewolfAutomaticAiExecutor;
  const source = automationSource('desktopAutomation.js');
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


test('プレイヤー状態の投票済表示は現在日の投票フェーズだけを参照する', () => {
  const workbenchSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ui/views/workbench/workbenchTaskRenderer.js'), 'utf8');
  const liveSource = automationSource('liveProgressController.js');
  for (const source of [workbenchSource, liveSource]) {
    assert.match(source, /\['vote', 'runoff'\]\.includes\(state(?:\?|)\.game(?:\?|)\.phase\)/u);
    assert.match(source, /voteSession(?:\?|)\.day === state(?:\?|)\.game(?:\?|)\.day/u);
    assert.match(source, /Boolean\(state(?:\?|)\.voteSession(?:\?|)\.votes && player\.id in state\.voteSession\.votes\)/u);
  }
  assert.doesNotMatch(workbenchSource, /const voteDone = state\.voteSession\?\.votes && player\.id in state\.voteSession\.votes;/u);
  assert.doesNotMatch(liveSource, /const voteDone = Boolean\(state\?\.voteSession\?\.votes && player\.id in state\.voteSession\.votes\);/u);
});

test('デスクトップ自動化は共通escapeHtmlを利用しデモAI欠落を明示失敗させる', () => {
  const rawSource = fs.readFileSync(path.join(automationRoot, 'desktopAutomation.js'), 'utf8');
  assert.match(rawSource, /import \{ escapeHtml \} from '\.\.\/shared\/utils\.js';/u);
  assert.equal((rawSource.match(/function escapeHtml\(/gu) ?? []).length, 0);
  assert.match(rawSource, /const demoAi = window\.AiWerewolfDemoAi;[\s\S]*typeof demoAi\.generate !== 'function'[\s\S]*デモAIを初期化できませんでした。/u);
  assert.doesNotMatch(rawSource, /text:\s*window\.AiWerewolfDemoAi\.generate/u);
});

test('MainとRendererはプロバイダー既定値をshared/providerDefaultsだけから参照する', () => {
  const sharedDefaults = require('../../../app/shared/providerDefaults.js').PROVIDER_DEFAULTS;
  const mainConstants = require('../../../app/main/llm/providerConstants.js');
  const mainSource = fs.readFileSync(path.join(__dirname, '../../../app/main/llm/providerConstants.js'), 'utf8');
  const rendererSource = automationSource('desktopAutomationConfig.js');

  assert.deepEqual(mainConstants.PROVIDER_DEFAULTS, sharedDefaults);
  assert.match(mainSource, /require\('\.\.\/\.\.\/shared\/providerDefaults\.js'\)/u);
  assert.match(rendererSource, /const \{ PROVIDER_DEFAULTS \} = providerDefaults/u);
  for (const endpoint of ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']) {
    assert.equal(mainSource.includes(endpoint), false, `Mainへ${endpoint}を複製しない`);
    assert.equal(rendererSource.includes(endpoint), false, `Rendererへ${endpoint}を複製しない`);
  }
});


test('AI管理画面へ応答修復ポリシーを明示注入する', () => {
  const automationFacadeSource = automationSource('desktopAutomation.js');
  const managementViewSource = automationSource('desktopAutomationManagementView.js');

  assert.match(automationFacadeSource, /createManagementView\(\{[\s\S]*?responseRetryPolicy,[\s\S]*?responseRecoveryModeOptions:/u);
  assert.match(managementViewSource, /function createManagementView\(\{[\s\S]*?responseRetryPolicy,[\s\S]*?responseRecoveryModeOptions,/u);
  assert.match(managementViewSource, /responseRecoveryMode: responseRetryPolicy\.normalizeRecoveryMode\(/u);
});


test('AI管理画面は欠損Thinking設定をローカルLLM既定値へ正規化し公開APIを重複定義しない', () => {
  const managementViewSource = automationSource('desktopAutomationManagementView.js');
  const managementControllerSource = automationSource('aiManagementController.js');
  assert.match(managementViewSource, /const \{ DEFAULT_OLLAMA_THINKING_LEVEL, LOCAL_OPENAI_PROVIDER, LOCAL_SERVER_PRESETS, OLLAMA_THINKING_LEVELS \} = localLlmConfig;/u);
  assert.match(managementViewSource, /thinkingLevel: card\.querySelector\('\[data-profile-setting="thinkingLevel"\]'\)\?\.value \?\? DEFAULT_OLLAMA_THINKING_LEVEL/u);
  const publicApiStart = managementControllerSource.indexOf('return Object.freeze({');
  const publicApiEnd = managementControllerSource.indexOf('});', publicApiStart);
  const publicApi = managementControllerSource.slice(publicApiStart, publicApiEnd);
  assert.equal((publicApi.match(/^\s+syncProfileProviderFields,$/gmu) ?? []).length, 1);
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



test('一括設定はAI設定保存と画面遷移から分離され選択値を保持する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.doesNotMatch(html, /data-ai-action="return-to-game"/u);
  assert.match(html, /AI参加者3名の個別割り当てを、選択したプロファイルで上書きします。/u);
  assert.match(html, /data-ai-bulk-feedback/u);
  assert.match(html, /未保存のAIプロファイル・オプション設定があります。/u);
  assert.match(html, />AI設定を保存<\/button>/u);

  const automationFacadeSource = automationSource('desktopAutomation.js');
  const managementControllerSource = automationSource('aiManagementController.js');
  const managementViewSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/desktopAutomationManagementView.js'), 'utf8');
  const source = `${automationFacadeSource}\n${managementControllerSource}\n${managementViewSource}`;
  assert.match(automationFacadeSource, /bulkAssignmentProfileId: null/u);
  assert.match(managementViewSource, /function bulkAssignmentProfileId\(\)/u);
  assert.match(source, /event\.target\.id === 'ai-bulk-profile'[\s\S]*controller\.bulkAssignmentProfileId = event\.target\.value/u);
  assert.match(source, /\[data-ai-profile-player-id\], #ai-bulk-profile/u);

  const bulkStart = source.indexOf("if (action === 'bulk-assign')");
  const bulkEnd = source.indexOf('function beforeManagementTabRender', bulkStart);
  const bulkAction = bulkStart >= 0 && bulkEnd > bulkStart ? source.slice(bulkStart, bulkEnd) : '';
  assert.match(bulkAction, /persistSettings\(\{ \.\.\.controller\.settings, assignments \}, \{ refresh: false/u);
  assert.match(bulkAction, /showBulkAssignmentFeedback/u);
  assert.match(bulkAction, /return;/u);
  assert.doesNotMatch(bulkAction, /setTab/u);
});

test('ゲーム準備ヘッダーはゲーム操作だけを集約しAI管理への重複導線を追加しない', () => {
  const setupDecorationSource = automationSource('setupDecorationController.js');
  assert.doesNotMatch(setupDecorationSource, /managementButton|pageActions\.prepend/u);
  assert.match(setupDecorationSource, /currentSelect\.outerHTML !== nextSelect\.outerHTML[\s\S]*currentSelect\.replaceWith\(nextSelect\)/u);
  const setupViewSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ui/views/setup/setupView.js'), 'utf8');
  assert.match(setupViewSource, /<div class="page-head-actions"><button class="button ghost" data-action="game-data-import"[^>]*>ゲームデータ読込<\/button><button class="button ghost" data-action="game-data-export"[^>]*>ゲームデータ出力<\/button><button class="button danger-ghost" data-action="new-game"[^>]*>新しいゲーム<\/button>/u);
});


test('ゲーム準備の局所入力通知は自動保存以外の不要な自動化全体更新を省略する', () => {
  const desktopSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/desktopAutomation.js'), 'utf8');
  assert.match(desktopSource, /const setupInputChange = event\.detail\?\.scope === 'setup-input'/u);
  assert.match(desktopSource, /if \(setupInputChange\)[\s\S]*event\.detail\?\.decorateSetup[\s\S]*else \{[\s\S]*reconcileAssignments[\s\S]*refreshLiveView\(\)[\s\S]*refreshAutomationStatus\(\)/u);
  assert.match(desktopSource, /settingsPersistenceCoordinator\.scheduleAutosave\(\)/u);
  assert.match(desktopSource, /setupLocalMutationSelector[\s\S]*data-ai-profile-player-id[\s\S]*records\.every\(isSetupLocalMutation\)/u);
});

test('AI管理はAppUIの正式タブとして登録し画面DOMの所有権を二重化しない', () => {
  const automationFacadeSource = automationSource('desktopAutomation.js');
  const managementControllerSource = automationSource('aiManagementController.js');
  const automationImplementationSource = `${automationFacadeSource}\n${managementControllerSource}`;
  const bootstrapSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/app/bootstrap.js'), 'utf8');
  const appUiSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ui/AppUI.js'), 'utf8');
  const tabControllerSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ui/controllers/tabController.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../../../app/renderer/index.html'), 'utf8');

  assert.match(indexHtml, /data-tab="ai-management"[^>]*><span>◇<\/span>AI管理<\/button>/u);
  assert.doesNotMatch(indexHtml, /id="ai-management-nav-button"/u);
  assert.match(bootstrapSource, /registerTabView: \(tab, view\) => ui\.registerTabView\(tab, view\)/u);
  assert.match(bootstrapSource, /getActiveTab: \(\) => ui\.getActiveTab\(\)/u);
  assert.match(bootstrapSource, /refreshTab: \(tab\) => ui\.refreshTab\(tab\)/u);
  assert.match(tabControllerSource, /function registerTabView\(tab, view = \{\}\)/u);
  assert.match(appUiSource, /const registeredView = this\.registeredTabViews\.get\(this\.activeTab\)/u);
  assert.match(automationFacadeSource, /registerTabView\('ai-management'/u);
  assert.match(automationFacadeSource, /render: \(\{ state \}\) => renderManagementPage\(state\)/u);
  assert.match(automationImplementationSource, /runtime\(\)\.setTab\('ai-management'\)/u);

  assert.doesNotMatch(automationImplementationSource, /managementOpen/u);
  assert.doesNotMatch(automationImplementationSource, /updateNavigationState/u);
  assert.doesNotMatch(automationImplementationSource, /root\.innerHTML = renderManagementPage/u);
  assert.doesNotMatch(automationImplementationSource, /#new-game-dialog/u);
});



test('AI管理からの各遷移は正式タブAPIだけを使用する', () => {
  const source = `${automationSource('aiManagementController.js')}\n${automationSource('liveProgressController.js')}`;
  const manualAction = source.match(/if \(action === 'open-manual'\) \{[\s\S]*?\n    \}/u)?.[0] ?? '';
  const prepareLive = source.match(/async function prepareLiveWorkbench\(\) \{[\s\S]*?\n\s+\}/u)?.[0] ?? '';
  assert.doesNotMatch(source, /return-to-game/u);
  assert.match(manualAction, /setTab\(currentGameState\(\)\?\.game\?\.phase === 'setup' \? 'setup' : 'workbench'\)/u);
  assert.match(prepareLive, /setTab\('workbench'\)/u);
  for (const block of [manualAction, prepareLive]) {
    assert.doesNotMatch(block, /innerHTML|managementOpen|updateNavigationState/u);
  }
});

test('人間操作待ちの進行卓導線は公開発言も通常進行卓の入力タスクを開く', () => {
  const source = automationSource('aiManagementController.js');
  const pendingAction = source.match(/if \(action === 'open-pending-task'\) \{[\s\S]*?\n\s+\}/u)?.[0] ?? '';
  assert.match(pendingAction, /automationMode === 'waiting-human'[\s\S]*return openHumanTask\(\)/u);
  assert.doesNotMatch(pendingAction, /pendingHumanTask\?\.kind === 'human-private'/u);
  assert.doesNotMatch(pendingAction, /prepareLiveWorkbench\(\)/u);
});

test('AIプロファイルを上下へ並び替えて保存できる', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /data-ai-action="move-profile-up"/u);
  assert.match(html, /data-ai-action="move-profile-down"/u);
  const profiles = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  assert.equal(api.reorderedProfiles(profiles, 'p2', -1).map((profile) => profile.id).join(','), 'p2,p1,p3');
  assert.equal(api.reorderedProfiles(profiles, 'p2', 1).map((profile) => profile.id).join(','), 'p1,p3,p2');
  assert.equal(api.reorderedProfiles(profiles, 'p1', -1).map((profile) => profile.id).join(','), 'p1,p2,p3');

  const source = automationSource('aiManagementController.js');
  assert.match(source, /current\.profiles = reordered;[\s\S]*persistSettings\(current, \{ refresh: true/u);
});

test('自動保存は専用スナップショットを遅延集約し終了前flushを登録する', () => {
  const source = automationSource('settingsPersistenceCoordinator.js');
  assert.match(source, /AUTOSAVE_DEBOUNCE_MS = 750/u);
  assert.match(source, /AUTOSAVE_MAX_WAIT_MS = 2000/u);
  assert.match(source, /runtime\(\)\.getAutosaveState\(\)/u);
  assert.match(source, /registerAutosaveFlushHandler/u);
  assert.doesNotMatch(source, /runtime\(\)\.getState\(\)/u);
});

test('使用量画面は1タスク平均トークンと再生成発生率を表示する', () => {
  const executorSource = automationSource('automaticAiExecutor.js');
  const managementSource = automationSource('desktopAutomationManagementView.js');
  assert.match(executorSource, /isTaskCall: true/u);
  assert.match(executorSource, /taskStart: taskApiCallCount === 0/u);
  assert.match(executorSource, /regeneratedTask: requestPurpose === 'regenerate'/u);
  assert.match(managementSource, /平均 .*tokens \/ 再生成/u);
});


test('API使用量はAIプロファイルを正本として個別または全体を確認付きリセットできる', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /人狼・チャットルームなど全用途をAIプロファイル別に集計/u);
  assert.match(html, /このプロファイルの累計/u);
  assert.match(html, /data-ai-action="reset-profile-usage"/u);
  assert.match(html, /data-ai-action="reset-all-usage"/u);
  assert.match(html, /詳細APIログは削除しません/u);

  const managementControllerSource = automationSource('aiManagementController.js');
  const preloadSource = fs.readFileSync(path.join(__dirname, '../../../app/main/preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '../../../app/main/main.js'), 'utf8');
  assert.match(managementControllerSource, /bridge\.resetProfileUsage\(profileId\)/u);
  assert.match(managementControllerSource, /bridge\.resetUsageSummary\('all'\)/u);
  assert.doesNotMatch(managementControllerSource, /window\.confirm/u);
  assert.match(preloadSource, /resetProfileUsage: \(profileId\) => ipcRenderer\.invoke\('desktop:reset-profile-usage'/u);
  assert.match(preloadSource, /resetUsageSummary: \(scope\) => ipcRenderer\.invoke\('desktop:reset-usage-summary'/u);
  assert.match(mainSource, /settingsStore\.resetUsageSummary\('profile', profileId\)/u);
});

test('料金上限はゲームIDではなくAIプロファイル累計へ適用する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /プロファイル利用上限（USD）/u);
  assert.match(html, /data-profile-setting="billingProfileBudgetUsd"/u);
  assert.doesNotMatch(html, /1ゲームの上限/u);
  const mainSource = fs.readFileSync(path.join(__dirname, '../../../app/main/main.js'), 'utf8');
  const reservationSource = fs.readFileSync(path.join(__dirname, '../../../app/main/profileBudgetReservation.js'), 'utf8');
  assert.ok([...mainSource.matchAll(/profileBudgetReservations\.reserve\(profile, promptEnvelope\)/gu)].length >= 2, '通常生成と接続テストの双方で利用上限を予約する');
  assert.match(reservationSource, /getProfileUsage\(profileId\)/u);
  assert.match(reservationSource, /PROFILE_BUDGET_EXCEEDED/u);
});


test('ローカルLLM正式対応の設定・モデル取得・認証任意表示を提供する', () => {
  const api = loadAutomationApi();
  const html = api.renderManagementPage(sampleState());
  assert.match(html, /ローカルLLM（OpenAI互換）/u);
  assert.match(html, /data-ai-action="add-profile"/u);
  assert.doesNotMatch(html, /data-ai-action="add-local-profile"/u);
  assert.match(automationSource('desktopAutomationConfig.js'), /\[LOCAL_OPENAI_PROVIDER\]: 'ローカルLLM（OpenAI互換）'/u);
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
  const mainSource = fs.readFileSync(path.join(__dirname, '../../../app/main/main.js'), 'utf8');
  const handlerStart = mainSource.indexOf("trustedIpc.handle('desktop:list-profile-models'");
  const handlerEnd = mainSource.indexOf("trustedIpc.handle('desktop:test-profile'", handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf('isLocalProvider(profile)') >= 0, 'モデル一覧取得はMain境界でもローカルプロファイルを再検証する');
  assert.ok(handler.indexOf('isLocalProvider(profile)') < handler.indexOf('settingsStore.decryptApiKey(profileId)'), '外部プロファイルのAPIキーを復号する前にローカル判定する');
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

  const source = automationSource('profileEditorController.js');
  assert.match(source, /function switchProfileEditor\(profileId\)/u);
  assert.match(source, /function switchProfileEditorTab\(tabId\)/u);
  assert.match(source, /controller\.selectedProfileId/u);
  assert.match(source, /controller\.profileEditorTab/u);
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

  const source = `${automationSource('desktopAutomationConfig.js')}\n${automationSource('desktopAutomationManagementView.js')}\n${automationSource('profileEditorController.js')}\n${automationSource('generationTestController.js')}\n${automationSource('aiManagementController.js')}`;
  assert.match(source, /generationTaskPlans/u);
  assert.match(source, /generationStagesForTask/u);
  assert.match(source, /generationMaximumNormalCalls/u);
  assert.match(source, /data-generation-profile-id/u);
  assert.match(source, /naturalGenerationSummary/u);
});


test('全自動でもAIプロファイル未設定を参加者別の手動生成として許可する', () => {
  const api = loadAutomationApi();
  const state = sampleState();

  assert.equal(api.canStartWithAiProfiles(state), true);
  assert.match(api.playerProfileSelectHtml(state.players[0]), /<option value="" selected>未設定（手動生成）<\/option>/u);
  assert.match(api.renderManagementPage(state), /API 0人 \/ 手動生成 3人/u);
  assert.match(api.renderManagementPage(state), /未設定の参加者だけ手動プロンプトで進めます/u);
});



test('runtime必須操作は共有契約で検証し欠落を無言で無視しない', () => {
  const runtimeFacadeSource = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/app/runtimeFacade.js'), 'utf8');
  const runtimeAccessSource = automationSource('runtimeAccess.js');
  const automationSources = fs.readdirSync(automationRoot)
    .filter((name) => name.endsWith('.js') && name !== 'runtimeAccess.js')
    .map((name) => automationSource(name)).join('\n');
  assert.match(runtimeFacadeSource, /RUNTIME_REQUIRED_METHODS/u);
  assert.match(runtimeAccessSource, /contract\.requiredMethods\.filter/u);
  assert.match(runtimeAccessSource, /reportInitializationFailure/u);
  assert.doesNotMatch(automationSources, /runtime\(\)\?\./u);
  assert.match(automationSource('desktopAutomation.js'), /contentMutationRefreshPending[\s\S]*queueMicrotask/u);
});

test('AIプロファイルJSONは選択中プロファイルと生成工程依存を安全な現行形式で転送する', () => {
  const viewSource = automationSource('desktopAutomationManagementView.js');
  const transferSource = automationSource('aiProfileTransferController.js');
  assert.match(viewSource, /data-ai-action="import-profile-json"/u);
  assert.match(viewSource, /data-ai-action="export-profile-json"/u);
  assert.match(transferSource, /ai-werewolf-ai-profile-package/u);
  assert.match(transferSource, /dependencyProfiles\(root\.id/u);
  assert.match(transferSource, /const idMap = new Map/u);
  assert.match(transferSource, /generation\[key\] = generation\[key\] === null \? null : idMap\.get/u);
  assert.doesNotMatch(transferSource, /PROFILE_KEYS[^\n]*apiKey/u);
  assert.match(transferSource, /APIキー・暗号化キー・使用量・参加者割り当ては転送対象に含めない/u);
});
