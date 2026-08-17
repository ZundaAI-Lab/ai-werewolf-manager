/**
 * 責務: 現行仕様の主要経路を直接確認するテストだけを、一つのNodeテスト入口へ集約する。
 * 変更ルール: 過去不具合の再現専用テスト、表示・最適化形状の固定テスト、重複する単体テストは登録しない。
 */

import './testEnvironment.js';
import './appearanceSettings.test.js';
import './playerCountPolicy.test.js';
import './productionPlaythrough.test.js';
import './priorityAnswer.test.js';
import './publicQuestionResolution.test.js';
import './largePlayerGame.test.js';
import './responseContract.test.js';
import './promptDataSerializer.test.js';
import './rolePromptKnowledge.test.js';
import './startRoleAssignment.test.js';
import './roleAssignment.test.js';
import './generationTextBoundary.test.js';
import './publicHistoryTransmissionMode.test.js';
import './generationPipeline.test.js';
import './aiTaskService.test.js';
import './aiTaskTaxonomy.test.js';
import './automaticAiFallback.test.js';
import './responseParser.test.js';
import './stateImport.test.js';
import './characterCatalog.test.js';
import './characterSettingsLimits.test.js';
import './chatRoom.test.js';
import './spectatorReplay.test.js';
import './reasoningProfilePolicy.test.js';
import './reasoningMetrics.test.js';
import './autosaveState.test.js';
import './stateStore.test.js';
import './internalMemoryWorkflow.test.js';
import './publicPrivateBoundary.test.js';
import './voteResolution.test.js';
import './testamentGraveyard.test.js';
import './wolfAttackVote.test.js';
import './specialRoles.test.js';
import './tohokuRoles.test.js';
import './tacticalKnowledgeBoundary.test.js';
import './automaticActionPolicy.test.js';
import './discussionModes.test.js';
