/**
 * 責務: automation配下のside-effect ES ModuleをRenderer bundleへ取り込み、初期化順序をimport依存として固定する単一エントリを提供する。
 * 変更ルール: 処理本体を持たず、依存順序だけを明示する。新しいautomationモジュールはHTMLへ追加せず本ファイルから読み込む。
 */

import '../ai/apiRetryPolicy.js';
import './runtimeAccess.js';
import './automationRunControl.js';
import './automaticAiExecutor.js';
import './desktopAutomationConfig.js';
import './desktopAutomationManagementView.js';
import './automationStatusController.js';
import './liveProgressController.js';
import './automaticRunCoordinator.js';
import './settingsPersistenceCoordinator.js';
import './humanTaskCoordinator.js';
import './manualTaskCoordinator.js';
import './profileEditorController.js';
import './aiProfileTransferController.js';
import './assignmentController.js';
import './generationTestController.js';
import './aiManagementController.js';
import './setupDecorationController.js';
import './postgameAnalysisAdapter.js';
import './desktopAutomation.js';
