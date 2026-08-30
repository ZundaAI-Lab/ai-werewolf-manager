/**
 * 責務: AI管理の共有既定値、責務分離、プロファイル並び替え、未割当時の手動生成可否という操作契約を確認する。
 * 変更ルール: 説明文、タブ構成、DOM配置、設定項目の列挙は固定せず、別の保存・通信・生成テストで守られる契約を重複検証しない。
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
test('AI管理の割り当て表示更新はassignmentControllerの責務を参照する', () => {
  const context = vm.createContext({ console });
  context.__automationTestModules = Object.create(null);
  executeAutomationModule('aiManagementController.js', context);
  const { createAiManagementController } = context.__automationTestModules['aiManagementController.js'];
  const updateManagementReadouts = () => {};
  const applyManagementExecutionModeUi = () => {};
  const testProfile = () => {};
  const listProfileModels = () => {};
  const controller = createAiManagementController({
    profileEditorController: {
      switchProfileEditor() {},
      switchProfileEditorTab() {},
      syncProfileProviderFields() {},
      updateProfileEditorPreview() {},
      testProfile,
      listProfileModels,
    },
    aiProfileTransferController: {
      exportSelectedProfileJson() {},
      importProfileJsonFile() {},
    },
    assignmentController: {
      updateManagementReadouts,
      applyManagementExecutionModeUi,
      saveAssignment() {},
      showBulkAssignmentFeedback() {},
    },
    generationTestController: {
      generationCandidateAnswer() {},
      buildGenerationTestStageSnapshots() {},
      testGenerationPipeline() {},
    },
  });
  assert.equal(controller.updateManagementReadouts, updateManagementReadouts);
  assert.equal(controller.applyManagementExecutionModeUi, applyManagementExecutionModeUi);
  assert.equal(controller.testProfile, testProfile);
  assert.equal(controller.listProfileModels, listProfileModels);
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
test('全自動でもAIプロファイル未設定を参加者別の手動生成として許可する', () => {
  const api = loadAutomationApi();
  const state = sampleState();

  assert.equal(api.canStartWithAiProfiles(state), true);
  assert.match(api.playerProfileSelectHtml(state.players[0]), /<option value="" selected>未設定（手動生成）<\/option>/u);
  assert.match(api.renderManagementPage(state), /API 0人 \/ 手動生成 3人/u);
  assert.match(api.renderManagementPage(state), /未設定の参加者だけ手動プロンプトで進めます/u);
});


test('デスクトップAI設定の初回読込失敗時は既定設定へフォールバックして保存処理を継続しない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/desktopAutomation.js'), 'utf8');
  assert.doesNotMatch(source, /bridge\.getSettings\(\)\.catch\(\(\) => defaultSettings\(\)\)/u);
  assert.match(source, /settingsLoadState = 'failed'/u);
  assert.match(source, /SETTINGS_INITIAL_LOAD_FAILED/u);
});

test('起動時割り当て整合はAI設定全体ではなく割り当て専用保存APIを使用する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/settingsPersistenceCoordinator.js'), 'utf8');
  assert.match(source, /bridge\.saveAssignments\(assignments\)/u);
  assert.doesNotMatch(source, /persistSettings\(\{ \.\.\.controller\.settings, assignments \}, \{ refresh: true \}\)/u);
  assert.match(source, /SETTINGS_NOT_LOADED/u);
});
