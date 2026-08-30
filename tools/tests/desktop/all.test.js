/**
 * 責務: デスクトップ統合に必要な高価値テストだけを、一つのNodeテスト入口へ集約する。
 * 変更ルール: 過去不具合の再現専用テスト、表示文言だけを固定するテスト、同じ契約を重複確認するテストは登録しない。
 *             API境界、保存、停止・再試行、主要UI操作、ビルド・配布整合性のいずれかを直接守る場合だけ追加する。
 */

'use strict';

require('./appearanceStore.test.js');
require('./atomicJsonFile.test.js');
require('./automaticAiExecutor.test.js');
require('./automationRunControl.test.js');
require('./automaticRunCoordinator.test.js');
require('./autosaveStore.test.js');
require('./bootstrapUi.test.js');
require('./buildIntegrity.test.js');
require('./characterDataStore.test.js');
require('./chatRoomIntegration.test.js');
require('./spectatorRoomIntegration.test.js');
require('./dataCompatibility.test.js');
require('./desktopAutomationUi.test.js');
require('./endpointPolicy.test.js');
require('./ipcSenderGuard.test.js');
require('./localLlmClient.test.js');
require('./providerClients.test.js');
require('./postgameAnalysisAdapter.test.js');
require('./postgameAnalysisController.test.js');
require('./privacyNoticeStore.test.js');
require('./permissionPolicy.test.js');
require('./profileBudgetReservation.test.js');
require('./promiseDeadline.test.js');
require('./promptEnvelopeValidator.test.js');
require('./promptHashPolicy.test.js');
require('./releasePipeline.test.js');
require('./rendererStartupSmoke.test.js');
require('./responseRetryPolicy.test.js');
require('./runtimeHardening.test.js');
require('./settingsStore.test.js');
require('./unusedExportAudit.test.js');
require('./userCharacterDataStore.test.js');
