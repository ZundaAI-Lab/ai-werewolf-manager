/**
 * 責務: ESMゲーム層がautomation層へ公開するruntimeファサードの必須メソッド契約を一元定義する。
 * 変更ルール: グローバル名や必須メソッドを変更する場合はautomation/runtimeAccess.jsと契約テストを同時更新する。任意メソッドを設けず、欠落は起動時エラーにする。
 */

export const RUNTIME_CONTRACT_VERSION = 1;
export const RUNTIME_REQUIRED_METHODS = Object.freeze([
  'getState', 'getAutosaveState', 'getCurrentWorkbenchTask', 'getPublicSnapshot', 'getRoleDisplayName', 'isWorkbenchPlayerFrozen', 'toast', 'dismissToast', 'beginAutomaticNotifications', 'endAutomaticNotifications',
  'beginNightActorPrivacy', 'endNightActorPrivacy', 'setTab', 'getActiveTab', 'registerTabView',
  'refreshTab', 'setAutomationUiState', 'setPublicHistoryTransmissionMode', 'setAiExecutionSettings', 'setPostgameAnalysisAdapter',
  'scheduleFullPublicHistory', 'getAiHistoryStatus', 'getCurrentAiTaskRequest', 'resolveAutomaticAction', 'executeAutomaticAction', 'prepareAiTask',
  'evaluateAiTaskCandidate', 'commitAiTaskCandidate', 'commitAiTaskFallback', 'resolveGenerationPlan',
  'runGenerationPipeline', 'createGenerationPipelineTestTask', 'resolveGenerationStagePromptPolicy',
  'buildDecideStagePrompt', 'buildAnalyzeStagePrompt', 'buildCritiqueStagePrompt', 'buildFinalizeStagePrompt', 'buildRenderStagePrompt', 'projectGenerationStagePromptEnvelope', 'parseTextPatchResponse',
  'validateTextPatchForStage', 'mergeTextPatch',
]);

export function createRuntimeFacade(implementation) {
  const missing = RUNTIME_REQUIRED_METHODS.filter((name) => typeof implementation?.[name] !== 'function');
  if (missing.length) throw new TypeError(`runtimeファサードの必須メソッドがありません: ${missing.join(', ')}`);
  return Object.freeze(Object.fromEntries(RUNTIME_REQUIRED_METHODS.map((name) => [name, implementation[name]])));
}

export function publishRuntimeContract(target = globalThis) {
  target.__AI_WEREWOLF_RUNTIME_CONTRACT__ = Object.freeze({
    version: RUNTIME_CONTRACT_VERSION,
    requiredMethods: RUNTIME_REQUIRED_METHODS,
  });
}
