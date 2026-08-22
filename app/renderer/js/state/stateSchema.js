/**
 * 責務: 現行保存状態で許可されるオブジェクトキーを一元定義し、未知項目・欠落項目を検出する。正規化前に限りgame.rules全体の欠落を許可し、正式な補完はgameRulePolicy.jsへ委譲する。再開始用の開始前プレイヤー別配役、役職欠け使用時の公開用配役構成、AI行代替の公開スキップ印、GM限定解決元、日終了プレイヤー相関スナップショットも現行形状として定義する。
 * 変更ルール: 値の意味・参照整合性はstateValidator.jsへ委譲する。状態項目を追加・削除した場合は生成元と同時にこの定義を更新し、旧キーを残さない。
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, requiredKeys, label, errors, { optionalKeys = [] } = {}) {
  if (!isPlainObject(value)) {
    errors.push(`${label}がオブジェクトではありません。`);
    return false;
  }
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  requiredKeys.forEach((key) => {
    if (!Object.hasOwn(value, key)) errors.push(`${label}.${key}がありません。`);
  });
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) errors.push(`${label}.${key}は定義されていない項目です。`);
  });
  return true;
}

function validateObjectArray(items, label, errors, validator) {
  if (!Array.isArray(items)) {
    errors.push(`${label}が配列ではありません。`);
    return;
  }
  items.forEach((item, index) => validator(item, `${label}[${index}]`, errors));
}

const ROOT_KEYS = [
  'schemaVersion', 'appVersion', 'runtime', 'revision', 'lastActionLabel',
  'game', 'players', 'playerKnowledge', 'briefing', 'discussion', 'voteSession',
  'wolfConversations', 'masonConversations', 'graveyardConversations', 'night', 'executionResolution', 'mediumResults', 'claims', 'publicAbilityClaims',
  'relationshipSnapshots', 'events', 'aiTurns', 'result', 'publicRevision', 'undoStack', 'redoStack', 'restorePoints',
];
const RUNTIME_KEYS = ['appVersion', 'schemaVersion', 'buildId', 'promptSpecVersion'];
const GAME_KEYS = [
  'id', 'title', 'preset', 'status', 'day', 'phase', 'phaseStartedAt', 'eventSequence',
  'stateRevision', 'winner', 'winnerReason', 'correctionMode', 'callNameSnapshot', 'setupRoleAssignments', 'publicRoleComposition', 'rules',
];
const CORRECTION_MODE_KEYS = ['enabled', 'reason', 'startedAt'];
const PLAYER_KEYS = [
  'id', 'name', 'aliases', 'characterCardId', 'callNameOverrides', 'controller', 'roleId', 'roleState', 'statusEffects',
  'alive', 'death', 'character', 'privateInfo', 'heartVoice', 'heartVoiceUpdatedAt',
  'heartVoiceHistory', 'internalMemory', 'memoryLedger', 'memoHistory', 'aiContextStatus', 'decisionState', 'factionStrategyState',
];
const NAMAHAGE_ROLE_STATE_KEYS = ['lastTargetId'];
const SNOW_WOMAN_ROLE_STATE_KEYS = ['lastTargetId'];
const ZASHIKI_ROLE_STATE_KEYS = ['ownerId', 'ownerRoleId', 'resolvedTeam'];
const STATUS_EFFECT_KEYS = ['type', 'day', 'sourcePlayerId'];
const DEATH_KEYS = ['day', 'phase', 'cause', 'announced'];
const CHARACTER_KEYS = [
  'profile', 'firstPerson', 'genericSecondPerson', 'speakingStyle', 'defaultEndings',
  'avoidedExpressions', 'speechLength', 'speechExamples', 'discussionBehavior', 'reasoningProfile',
];
const REASONING_PROFILE_KEYS = [
  'evidenceFocus', 'updateTempo', 'hypothesisBreadth', 'confrontationStyle', 'questionStyle', 'uncertaintyStyle',
];
const INTERNAL_MEMORY_KEYS = ['summary', 'notes', 'lastConsolidatedAt', 'consolidationRecommended'];
const INTERNAL_MEMORY_NOTE_KEYS = ['id', 'text', 'createdAt', 'sourceAiTurnId'];
const MEMORY_LEDGER_KEYS = ['privateFacts', 'publicCommitments', 'pendingDiscriminators', 'selectionRationales', 'updatedAt'];
const DECISION_STATE_KEYS = [
  'suspicionCandidateIds', 'executionCandidateIds', 'intendedVoteId', 'assessmentLevel',
  'keyPublicEvidenceEventIds', 'leaveAliveBenefit', 'misexecutionCost', 'selectionDifference', 'uncertainty',
  'nextDiscriminatingInformation', 'decisionReason', 'revisionCause', 'hasDecisionChanged', 'changedFields', 'updatedAt', 'sourceAiTurnId', 'sourceEventId', 'sourceDay',
];
const FACTION_STRATEGY_STATE_FIELDS_BY_PROFILE = Object.freeze({
  wolf: Object.freeze(['publicWorld', 'dayWinPath', 'partnerDisposition', 'collapsePlan', 'failureRisk']),
  madman: Object.freeze(['publicWorld', 'dayWinPath', 'linkageRisk', 'fallbackRoute', 'failureRisk']),
  fox: Object.freeze(['publicWorld', 'pressureGoal', 'failureRisk', 'nextDayPlan']),
});
const PLAYER_KNOWLEDGE_KEYS = ['knownWolfIds', 'knownMadmanIds', 'knownMasonIds', 'knownOwnerId', 'knownOwnerRoleId', 'resolvedTeam', 'roleNotifiedAt', 'knowledgeRevision'];
const BRIEFING_KEYS = [
  'roleAssignmentFrozen', 'eligiblePlayerIds', 'noticeStatusByPlayerId',
  'aiContextReadyByPlayerId', 'forcedReasonByPlayerId', 'completed',
];
const DISCUSSION_KEYS = [
  'day', 'mode', 'round', 'roundKind', 'roundStartedAtSequence', 'roundEligiblePlayerIds',
  'queue', 'currentIndex', 'designatedPlayerId', 'spokenInCurrentRound', 'deferredPlayerIds',
  'deferredCountByPlayer', 'allDeferred', 'remainingByPlayer', 'modeControl', 'reconsideration', 'completed',
];
const DESIGNATED_MODE_CONTROL_KEYS = ['type', 'preferredNextSpeakerId'];
const FREE_MODE_CONTROL_KEYS = ['type', 'stage', 'openingPreferenceByPlayerId', 'nextPreferenceByPlayerId', 'donePlayerIds'];
const RECONSIDERATION_KEYS = [
  'pending', 'active', 'items', 'reasons', 'sourceEventIds', 'affectedPlayerIds',
  'updatedAt', 'handledRound',
];
const VOTE_SESSION_KEYS = [
  'id', 'day', 'type', 'round', 'parentSessionId', 'triggerVoteResultEventId', 'status',
  'inputMode', 'candidateIds', 'eligibleVoterIds', 'currentVoterIndex', 'votes',
  'voteEventIdByVoterId', 'tally', 'result',
];
const VOTE_RESULT_KEYS = ['type', 'targetId', 'tiedCandidateIds', 'resolution'];
const WOLF_CONVERSATION_KEYS = [
  'id', 'day', 'purpose', 'status', 'participantIds', 'messages', 'summary', 'createdAt',
  'closedAt', 'speechCountPerParticipant', 'remainingByParticipant', 'sharedStrategy',
];
const MASON_CONVERSATION_KEYS = [
  'id', 'day', 'status', 'participantIds', 'messages', 'summary', 'createdAt',
  'closedAt', 'speechCountPerParticipant', 'remainingByParticipant',
];
const GRAVEYARD_CONVERSATION_KEYS = [
  'id', 'day', 'status', 'participantIds', 'messages', 'summary', 'createdAt',
  'closedAt', 'speechCountPerParticipant', 'remainingByParticipant',
];
const PRIVATE_MESSAGE_KEYS = ['id', 'sessionId', 'speakerId', 'content', 'sequence', 'timestamp', 'source', 'type', 'aiTurnId'];
const WOLF_SHARED_STRATEGY_KEYS = [
  'claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan', 'collapsePlan', 'discussionPlan',
  'attackPlan', 'updatedAt', 'updatedByPlayerId',
];
const NIGHT_KEYS = [
  'day', 'status', 'aliveAtStartIds', 'plan', 'slots', 'currentSlotIndex',
  'graveyardConversationId', 'masonConversationId', 'wolfConversationId', 'wolfAttack', 'resolution',
];
const NIGHT_SLOT_KEYS = ['id', 'type', 'actorId', 'targetId', 'status', 'override', 'rationale', 'aiTurnId'];
const WOLF_ATTACK_KEYS = [
  'status', 'conversationId', 'voterWolfIds', 'voteByWolfId', 'rationaleByWolfId',
  'overrideByWolfId', 'tally', 'finalTargetId',
];
const WOLF_ATTACK_TALLY_KEYS = ['countsByTargetId', 'topTargetIds', 'resolutionMethod'];
const DEATH_RESOLUTION_KEYS = ['playerId', 'cause', 'triggerPlayerId', 'sourcePlayerIds', 'selectedBy'];
const NIGHT_RESOLUTION_KEYS = [
  'attackedTargetId', 'guardedTargetIds', 'successfulGuardActorIds', 'deaths',
  'attackOutcome', 'statusApplications', 'actionExecutions',
  'freezeActorId', 'freezeTargetId', 'freezeOutcome', 'frozenPlayerId',
  'inspectedFoxIds', 'catCollateralWolfId',
  'privateResults', 'publicAnnouncement', 'gmNotes', 'winnerPreview',
];
const STATUS_APPLICATION_KEYS = ['type', 'sourcePlayerId', 'targetPlayerId', 'appliedNightDay'];
const ACTION_EXECUTION_KEYS = [
  'actionType', 'actorIds', 'fearfulActorIds', 'executionState', 'blockReason', 'consumedFearPlayerIds',
];
const EXECUTION_RESOLUTION_KEYS = [
  'targetId', 'status', 'deaths', 'collateralPlayerId', 'publicAnnouncement', 'winnerPreview', 'testament',
];
const TESTAMENT_RESOLUTION_KEYS = ['status', 'eventId', 'skippedReason', 'completedAt'];
const MEDIUM_RESULT_KEYS = [
  'id', 'mediumId', 'executedPlayerId', 'result', 'availableFromDay', 'delivered',
  'expired', 'eventId',
];
const CLAIM_KEYS = [
  'id', 'actorId', 'roleId', 'day', 'status', 'sourceEventId', 'withdrawnByEventId', 'voidedByEventId',
];
const PUBLIC_ABILITY_CLAIM_KEYS = [
  'id', 'actorId', 'claimedRoleId', 'actionType', 'targetId', 'result', 'observedDay',
  'announcedDay', 'selectionBasis', 'evidenceEventIds', 'selectionReasonAtTime',
  'sourceEventId', 'sourceClaimIndex', 'status', 'voidedByEventId',
];
const RELATIONSHIP_SNAPSHOT_KEYS = [
  'id', 'day', 'capturedAt', 'sourceEventId', 'sourceRef', 'latestVoteDay', 'nodes', 'edges',
];
const RELATIONSHIP_SNAPSHOT_NODE_KEYS = [
  'id', 'name', 'alive', 'controller', 'claimedRoleId', 'claimedRoleName', 'actualRoleId', 'actualRoleName',
  'suspicionTargetIds', 'suspicionStrength', 'decisionSourceDay',
];
const RELATIONSHIP_SNAPSHOT_EDGE_KEYS = [
  'id', 'type', 'sourceId', 'targetId', 'label', 'graphLabel', 'day', 'result', 'sourceEventId',
];

const EVENT_KEYS = [
  'id', 'sequence', 'day', 'phase', 'type', 'actorId', 'targetIds', 'audience',
  'payload', 'status', 'createdAt', 'publishedAt', 'voidedByEventId',
];
const AUDIENCE_KEYS = ['type', 'targetIds'];
const AI_TURN_KEYS = [
  'id', 'day', 'phase', 'stateRevision', 'promptContextFingerprint', 'promptMode', 'publicSequenceAtGeneration', 'publicSequenceAtRegistration', 'promptText',
  'rawResponse', 'parsedPublicSpeech', 'parsedSpeechInteraction', 'resolvedSpeechInteraction', 'parsedWolfConversationMessage', 'parsedMasonConversationMessage', 'parsedGraveyardConversationMessage', 'parsedSharedStrategyPatch',
  'parsedHeartVoice', 'parsedInternalMemoUpdate', 'parsedFullMemo', 'parsedActionAnswer',
  'parsedSelectionRationale', 'parsedCoOperation', 'parsedAbilityClaims', 'resolvedAbilityClaims',
  'parsedDecisionUpdate', 'resolvedDecisionUpdate', 'parsedFactionStrategyPatch', 'resolvedFactionStrategyState', 'parsedAttackAssessment', 'resolvedAttackAssessment',
  'estimatedWerewolfIds', 'predictedAttackTargetIds',
  'resolvedInternalReasoningDirective',
  'warnings', 'override', 'committedEntityIds', 'runtimeBuildId', 'promptSpecVersion',
  'taskType', 'playerId', 'timestamp', 'generationRun',
];

const GENERATION_RUN_KEYS = [
  'schemaVersion', 'executionMode', 'depth', 'ownerProfileId', 'taskCategory',
  'normalCallCount', 'totalCallCount', 'finalStageId', 'stages',
];
const GENERATION_STAGE_KEYS = [
  'stageId', 'executorProfileId', 'status', 'attemptCount', 'targetTextFields',
  'skipReason', 'rawResponse', 'fallbackUsed', 'issues', 'usage',
];
const GENERATION_ISSUE_KEYS = ['code', 'message'];
const GENERATION_USAGE_KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];

function validateGenerationRunShape(value, label, errors) {
  if (!exactKeys(value, GENERATION_RUN_KEYS, label, errors)) return;
  if (value.schemaVersion !== 1) errors.push(`${label}.schemaVersionが不正です。`);
  if (!['automatic', 'manual'].includes(value.executionMode)) errors.push(`${label}.executionModeが不正です。`);
  if (![1, 2, 3, 4].includes(value.depth)) errors.push(`${label}.depthが不正です。`);
  if (typeof value.ownerProfileId !== 'string') errors.push(`${label}.ownerProfileIdが文字列ではありません。`);
  if (typeof value.taskCategory !== 'string' || !value.taskCategory) errors.push(`${label}.taskCategoryが不正です。`);
  for (const key of ['normalCallCount', 'totalCallCount']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) errors.push(`${label}.${key}が0以上の整数ではありません。`);
  }
  if (!['direct', 'draft', 'render', 'proofread'].includes(value.finalStageId)) errors.push(`${label}.finalStageIdが不正です。`);
  validateObjectArray(value.stages, `${label}.stages`, errors, (stage, stageLabel, stageErrors) => {
    if (!exactKeys(stage, GENERATION_STAGE_KEYS, stageLabel, stageErrors)) return;
    if (!['direct', 'draft', 'render', 'proofread'].includes(stage.stageId)) stageErrors.push(`${stageLabel}.stageIdが不正です。`);
    if (typeof stage.executorProfileId !== 'string') stageErrors.push(`${stageLabel}.executorProfileIdが文字列ではありません。`);
    if (!['accepted', 'applied', 'skipped', 'fallback'].includes(stage.status)) stageErrors.push(`${stageLabel}.statusが不正です。`);
    if (!Number.isInteger(stage.attemptCount) || stage.attemptCount < 0) stageErrors.push(`${stageLabel}.attemptCountが0以上の整数ではありません。`);
    if (!Array.isArray(stage.targetTextFields) || stage.targetTextFields.some((field) => typeof field !== 'string')) stageErrors.push(`${stageLabel}.targetTextFieldsが不正です。`);
    if (!(stage.skipReason === null || stage.skipReason === 'NO_APPLICABLE_TEXT_FIELD')) stageErrors.push(`${stageLabel}.skipReasonが不正です。`);
    if (typeof stage.rawResponse !== 'string') stageErrors.push(`${stageLabel}.rawResponseが文字列ではありません。`);
    if (typeof stage.fallbackUsed !== 'boolean') stageErrors.push(`${stageLabel}.fallbackUsedが真偽値ではありません。`);
    validateObjectArray(stage.issues, `${stageLabel}.issues`, stageErrors, (item, issueLabel, issueErrors) => {
      if (!exactKeys(item, GENERATION_ISSUE_KEYS, issueLabel, issueErrors)) return;
      if (typeof item.code !== 'string' || typeof item.message !== 'string') issueErrors.push(`${issueLabel}が文字列ではありません。`);
    });
    if (exactKeys(stage.usage, GENERATION_USAGE_KEYS, `${stageLabel}.usage`, stageErrors)) {
      for (const key of GENERATION_USAGE_KEYS) {
        if (!Number.isFinite(stage.usage[key]) || stage.usage[key] < 0) stageErrors.push(`${stageLabel}.usage.${key}が0以上の数値ではありません。`);
      }
    }
    if (['direct', 'draft'].includes(stage.stageId) && stage.targetTextFields.length) stageErrors.push(`${stageLabel}.targetTextFieldsは空配列でなければなりません。`);
    if (stage.status === 'accepted' && !['direct', 'draft'].includes(stage.stageId)) stageErrors.push(`${stageLabel}.acceptedはdirectまたはdraftだけで使用できます。`);
    if (stage.status === 'applied' && !['render', 'proofread'].includes(stage.stageId)) stageErrors.push(`${stageLabel}.appliedはrenderまたはproofreadだけで使用できます。`);
    if (stage.status === 'skipped') {
      if (stage.attemptCount !== 0 || stage.targetTextFields.length || stage.skipReason !== 'NO_APPLICABLE_TEXT_FIELD' || stage.rawResponse !== '' || stage.fallbackUsed || stage.issues.length) {
        stageErrors.push(`${stageLabel}.skipped工程の形状が不正です。`);
      }
      if (GENERATION_USAGE_KEYS.some((key) => stage.usage?.[key] !== 0)) stageErrors.push(`${stageLabel}.skipped工程のusageは全項目0でなければなりません。`);
    } else if (stage.skipReason !== null) {
      stageErrors.push(`${stageLabel}.skipReasonはskipped工程以外ではnullでなければなりません。`);
    }
    if (stage.status === 'fallback' && !stage.fallbackUsed) stageErrors.push(`${stageLabel}.fallback工程ではfallbackUsedをtrueにしてください。`);
    if (stage.status !== 'fallback' && stage.fallbackUsed) stageErrors.push(`${stageLabel}.fallback以外でfallbackUsedをtrueにできません。`);
  });
  if (!Array.isArray(value.stages) || !value.stages.length) return;
  const finalStage = [...value.stages].reverse().find((stage) => stage.stageId === value.finalStageId);
  if (!finalStage || !['accepted', 'applied'].includes(finalStage.status)) errors.push(`${label}.finalStageIdが最終採用工程を指していません。`);
  if (value.executionMode === 'manual') {
    if (value.totalCallCount !== 0) errors.push(`${label}.手動方式のtotalCallCountは0でなければなりません。`);
    for (const stage of value.stages) {
      if (stage.attemptCount !== 0 || GENERATION_USAGE_KEYS.some((key) => stage.usage?.[key] !== 0)) errors.push(`${label}.手動方式のattemptCountとusageは0でなければなりません。`);
    }
  } else {
    const attempts = value.stages.reduce((total, stage) => total + Number(stage.attemptCount ?? 0), 0);
    if (attempts !== value.totalCallCount) errors.push(`${label}.totalCallCountが工程試行数合計と一致しません。`);
  }
}


const PARSED_SPEECH_INTERACTION_KEYS = ['questionTargetNames', 'answerToRefs'];
const RESOLVED_SPEECH_INTERACTION_KEYS = ['questionTargetIds', 'answersEventIds'];
const INTERNAL_REASONING_DIRECTIVE_KEYS = [
  'modeId', 'lens', 'focusPlayerIds', 'anchorEventSequences', 'publicSequenceAtGeneration',
];
const PARSED_ATTACK_ASSESSMENT_KEYS = [
  'hunterAliveChance', 'hunterSurvivalReason',
  'selectedTargetGuardRisk', 'selectedTargetValue', 'selectedTargetFailureCost',
  'otherTargetName', 'otherTargetGuardRisk', 'otherTargetValue', 'selectionDifference',
];
const RESOLVED_ATTACK_ASSESSMENT_KEYS = [
  'hunterAliveChance', 'hunterSurvivalReason',
  'selectedTargetGuardRisk', 'selectedTargetValue', 'selectedTargetFailureCost',
  'otherTargetId', 'otherTargetGuardRisk', 'otherTargetValue', 'selectionDifference',
];
const FACTION_STRATEGY_PATCH_KEYS = ['mode', 'changes'];
const FACTION_STRATEGY_CHANGE_KEYS = [
  'publicWorld', 'dayWinPath', 'partnerDisposition', 'collapsePlan', 'linkageRisk',
  'fallbackRoute', 'pressureGoal', 'failureRisk', 'nextDayPlan',
];
const SHARED_STRATEGY_PATCH_KEYS = ['mode', 'changes'];
const SHARED_STRATEGY_CHANGE_KEYS = ['claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan', 'collapsePlan', 'discussionPlan', 'attackPlan'];
const RESULT_KEYS = [
  'winner', 'reason', 'status', 'revealAllRoles', 'revealWolfConversation',
  'revealMasonConversation', 'revealGraveyardConversation', 'revealInternalMemos', 'publishedAt',
];
const HISTORY_ENTRY_KEYS = ['id', 'label', 'createdAt', 'state'];

// JSONインポート互換ポリシーが未知ルート／プレイヤー項目を除去するための正本。
// 値の意味や既定値はここへ持ち込まず、許可キー集合だけを共有する。
export const STATE_ROOT_KEYS = Object.freeze([...ROOT_KEYS]);
export const STATE_PLAYER_KEYS = Object.freeze([...PLAYER_KEYS]);
export const STATE_HISTORY_ENTRY_KEYS = Object.freeze([...HISTORY_ENTRY_KEYS]);

const EVENT_PAYLOAD_KEYS = Object.freeze({
  system: ['text'],
  'role-notified': ['roleId', 'status', 'forcedReason'],
  'night-action': ['actionType', 'targetId', 'nightDay', 'rationale', 'override', 'sourceAiTurnId', 'editReason', 'editedAt'],
  'private-result': ['actorId', 'actionType', 'targetId', 'result', 'ownerRoleId', 'resolvedTeam', 'availableFromDay', 'nightDay', 'acknowledgedAt'],
  'wolf-conversation': ['conversationId', 'messageId', 'content', 'purpose', 'sharedStrategyPatch', 'editReason', 'editedAt'],
  'mason-conversation': ['conversationId', 'messageId', 'content', 'editReason', 'editedAt'],
  'graveyard-conversation': ['conversationId', 'messageId', 'content', 'editReason', 'editedAt'],
  dawn: ['text', 'deadPlayerIds', 'frozenPlayerIds'],
  'public-speech': ['text', 'pass', 'speechKind', 'sourceQuestionEventId', 'round', 'roundKind', 'opportunityContext', 'correctsEventId', 'structured'],
  'vote-cast': ['text', 'voteSessionId', 'targetId', 'override', 'editReason', 'editedAt'],
  'vote-finalized': ['sessionId', 'type', 'round', 'text', 'tally', 'ballots', 'result'],
  execution: ['text', 'targetId', 'collateralPlayerIds', 'deadPlayerIds', 'revealedRoleId'],
  'game-result': ['text', 'winner', 'reason', 'roles', 'wolfConversations', 'masonConversations', 'graveyardConversations', 'internalMemos'],
  'result-impression': ['text', 'skipped', 'reason'],
  'priority-answer-resolution': ['questionEventId', 'targetPlayerId', 'resolution', 'reason', 'source'],
  correction: ['text', 'reason', 'targetEventId', 'replacementSpeechText', 'correctionType', 'beforeRoleId', 'correctedRoleId'],
  'correction-audit': ['text', 'reason', 'restorePointId', 'restoredFromRevision', 'restoredToRevision', 'supersededEventIds', 'supersededEvents'],
});

function validateFactionStrategyPatchShape(update, label, errors) {
  if (update === null) return;
  if (!exactKeys(update, FACTION_STRATEGY_PATCH_KEYS, label, errors)) return;
  exactKeys(update.changes, [], `${label}.changes`, errors, { optionalKeys: FACTION_STRATEGY_CHANGE_KEYS });
}

function validateSharedStrategyPatchShape(update, label, errors) {
  if (update === null) return;
  if (!exactKeys(update, SHARED_STRATEGY_PATCH_KEYS, label, errors)) return;
  exactKeys(update.changes, [], `${label}.changes`, errors, { optionalKeys: SHARED_STRATEGY_CHANGE_KEYS });
}

function validateEventShape(event, label, errors) {
  if (!exactKeys(event, EVENT_KEYS, label, errors)) return;
  exactKeys(event.audience, AUDIENCE_KEYS, `${label}.audience`, errors);
  const allowedPayloadKeys = EVENT_PAYLOAD_KEYS[event.type];
  if (!allowedPayloadKeys) {
    errors.push(`${label}.type「${event.type}」のpayload定義がありません。`);
    return;
  }
  exactKeys(event.payload, [], `${label}.payload`, errors, { optionalKeys: allowedPayloadKeys });
  if (event.type === 'wolf-conversation' && Object.hasOwn(event.payload, 'sharedStrategyPatch')) {
    validateSharedStrategyPatchShape(event.payload.sharedStrategyPatch, `${label}.payload.sharedStrategyPatch`, errors);
  }
}

function validatePlayerShape(player, label, errors) {
  if (!exactKeys(player, PLAYER_KEYS, label, errors)) return;
  if (player.death !== null) exactKeys(player.death, DEATH_KEYS, `${label}.death`, errors);
  if (player.roleId === 'namahage') exactKeys(player.roleState, NAMAHAGE_ROLE_STATE_KEYS, `${label}.roleState`, errors);
  else if (player.roleId === 'snowWoman') exactKeys(player.roleState, SNOW_WOMAN_ROLE_STATE_KEYS, `${label}.roleState`, errors);
  else if (player.roleId === 'zashikiWarashi') exactKeys(player.roleState, ZASHIKI_ROLE_STATE_KEYS, `${label}.roleState`, errors);
  else if (player.roleState !== null) errors.push(`${label}.roleStateはこの役職ではnullでなければなりません。`);
  validateObjectArray(player.statusEffects, `${label}.statusEffects`, errors, (effect, effectLabel, effectErrors) => {
    exactKeys(effect, STATUS_EFFECT_KEYS, effectLabel, effectErrors);
  });
  if (exactKeys(player.character, CHARACTER_KEYS, `${label}.character`, errors, { optionalKeys: ['conversationSeeds'] })) {
    exactKeys(player.character.reasoningProfile, REASONING_PROFILE_KEYS, `${label}.character.reasoningProfile`, errors);
  }
  if (exactKeys(player.internalMemory, INTERNAL_MEMORY_KEYS, `${label}.internalMemory`, errors)) {
    validateObjectArray(player.internalMemory.notes, `${label}.internalMemory.notes`, errors, (note, noteLabel, noteErrors) => {
      exactKeys(note, INTERNAL_MEMORY_NOTE_KEYS, noteLabel, noteErrors);
    });
  }
  exactKeys(player.memoryLedger, MEMORY_LEDGER_KEYS, `${label}.memoryLedger`, errors);
  exactKeys(player.decisionState, DECISION_STATE_KEYS, `${label}.decisionState`, errors);
  if (player.factionStrategyState !== null) {
    const profile = player.factionStrategyState.profile;
    const fields = FACTION_STRATEGY_STATE_FIELDS_BY_PROFILE[profile];
    if (!fields) errors.push(`${label}.factionStrategyStateのプロフィールが不正です。`);
    else exactKeys(
      player.factionStrategyState,
      ['profile', ...fields, 'updatedAt', 'sourceAiTurnId'],
      `${label}.factionStrategyState`,
      errors,
    );
  }
}

function validateHistoryEntries(entries, label, errors, options) {
  validateObjectArray(entries, label, errors, (entry, entryLabel, entryErrors) => {
    if (!exactKeys(entry, HISTORY_ENTRY_KEYS, entryLabel, entryErrors)) return;
    validateStateShapeInternal(entry.state, `${entryLabel}.state`, entryErrors, { ...options, includeHistory: false });
  });
}

function validateStateShapeInternal(raw, label, errors, { includeHistory = true, allowMissingGameRules = false } = {}) {
  if (!exactKeys(raw, ROOT_KEYS, label, errors)) return;
  exactKeys(raw.runtime, RUNTIME_KEYS, `${label}.runtime`, errors);
  const requiredGameKeys = allowMissingGameRules ? GAME_KEYS.filter((key) => key !== 'rules') : GAME_KEYS;
  const optionalGameKeys = allowMissingGameRules ? ['rules'] : [];
  if (exactKeys(raw.game, requiredGameKeys, `${label}.game`, errors, { optionalKeys: optionalGameKeys })) {
    exactKeys(raw.game.correctionMode, CORRECTION_MODE_KEYS, `${label}.game.correctionMode`, errors);
  }
  validateObjectArray(raw.players, `${label}.players`, errors, validatePlayerShape);
  if (!isPlainObject(raw.playerKnowledge)) errors.push(`${label}.playerKnowledgeがオブジェクトではありません。`);
  else Object.entries(raw.playerKnowledge).forEach(([playerId, knowledge]) => {
    exactKeys(knowledge, PLAYER_KNOWLEDGE_KEYS, `${label}.playerKnowledge.${playerId}`, errors);
  });
  if (raw.briefing !== null) exactKeys(raw.briefing, BRIEFING_KEYS, `${label}.briefing`, errors);
  if (raw.discussion !== null && exactKeys(raw.discussion, DISCUSSION_KEYS, `${label}.discussion`, errors)) {
    const control = raw.discussion.modeControl;
    if (raw.discussion.mode === 'ordered') {
      if (control !== null) errors.push(`${label}.discussion.modeControlは順番制ではnullでなければなりません。`);
    } else if (raw.discussion.mode === 'designated') {
      if (exactKeys(control, DESIGNATED_MODE_CONTROL_KEYS, `${label}.discussion.modeControl`, errors) && control.type !== 'designated') errors.push(`${label}.discussion.modeControl.typeが不正です。`);
    } else if (raw.discussion.mode === 'free') {
      if (exactKeys(control, FREE_MODE_CONTROL_KEYS, `${label}.discussion.modeControl`, errors) && control.type !== 'free') errors.push(`${label}.discussion.modeControl.typeが不正です。`);
    }
    exactKeys(raw.discussion.reconsideration, RECONSIDERATION_KEYS, `${label}.discussion.reconsideration`, errors);
  }
  if (raw.voteSession !== null && exactKeys(raw.voteSession, VOTE_SESSION_KEYS, `${label}.voteSession`, errors)) {
    if (raw.voteSession.result !== null) exactKeys(raw.voteSession.result, VOTE_RESULT_KEYS, `${label}.voteSession.result`, errors);
  }
  validateObjectArray(raw.wolfConversations, `${label}.wolfConversations`, errors, (session, sessionLabel, sessionErrors) => {
    if (!exactKeys(session, WOLF_CONVERSATION_KEYS, sessionLabel, sessionErrors)) return;
    exactKeys(session.sharedStrategy, WOLF_SHARED_STRATEGY_KEYS, `${sessionLabel}.sharedStrategy`, sessionErrors);
    validateObjectArray(session.messages, `${sessionLabel}.messages`, sessionErrors, (message, messageLabel, messageErrors) => {
      exactKeys(message, PRIVATE_MESSAGE_KEYS, messageLabel, messageErrors);
    });
  });
  validateObjectArray(raw.masonConversations, `${label}.masonConversations`, errors, (session, sessionLabel, sessionErrors) => {
    if (!exactKeys(session, MASON_CONVERSATION_KEYS, sessionLabel, sessionErrors)) return;
    validateObjectArray(session.messages, `${sessionLabel}.messages`, sessionErrors, (message, messageLabel, messageErrors) => {
      exactKeys(message, PRIVATE_MESSAGE_KEYS, messageLabel, messageErrors);
    });
  });
  validateObjectArray(raw.graveyardConversations, `${label}.graveyardConversations`, errors, (session, sessionLabel, sessionErrors) => {
    if (!exactKeys(session, GRAVEYARD_CONVERSATION_KEYS, sessionLabel, sessionErrors)) return;
    validateObjectArray(session.messages, `${sessionLabel}.messages`, sessionErrors, (message, messageLabel, messageErrors) => {
      exactKeys(message, PRIVATE_MESSAGE_KEYS, messageLabel, messageErrors);
    });
  });
  if (raw.night !== null && exactKeys(raw.night, NIGHT_KEYS, `${label}.night`, errors)) {
    validateObjectArray(raw.night.slots, `${label}.night.slots`, errors, (slot, slotLabel, slotErrors) => {
      exactKeys(slot, NIGHT_SLOT_KEYS.filter((key) => !['rationale', 'aiTurnId'].includes(key)), slotLabel, slotErrors, { optionalKeys: ['rationale', 'aiTurnId'] });
    });
    if (exactKeys(raw.night.wolfAttack, WOLF_ATTACK_KEYS, `${label}.night.wolfAttack`, errors)) {
      exactKeys(raw.night.wolfAttack.tally, WOLF_ATTACK_TALLY_KEYS, `${label}.night.wolfAttack.tally`, errors);
    }
    if (raw.night.resolution !== null && exactKeys(raw.night.resolution, NIGHT_RESOLUTION_KEYS, `${label}.night.resolution`, errors)) {
      validateObjectArray(raw.night.resolution.statusApplications, `${label}.night.resolution.statusApplications`, errors, (entry, entryLabel, entryErrors) => {
        exactKeys(entry, STATUS_APPLICATION_KEYS, entryLabel, entryErrors);
      });
      validateObjectArray(raw.night.resolution.actionExecutions, `${label}.night.resolution.actionExecutions`, errors, (entry, entryLabel, entryErrors) => {
        exactKeys(entry, ACTION_EXECUTION_KEYS, entryLabel, entryErrors);
      });
      validateObjectArray(raw.night.resolution.deaths, `${label}.night.resolution.deaths`, errors, (death, deathLabel, deathErrors) => {
        exactKeys(death, DEATH_RESOLUTION_KEYS, deathLabel, deathErrors);
      });
    }
  }
  if (raw.executionResolution !== null && exactKeys(raw.executionResolution, EXECUTION_RESOLUTION_KEYS, `${label}.executionResolution`, errors)) {
    exactKeys(raw.executionResolution.testament, TESTAMENT_RESOLUTION_KEYS, `${label}.executionResolution.testament`, errors);
    validateObjectArray(raw.executionResolution.deaths, `${label}.executionResolution.deaths`, errors, (death, deathLabel, deathErrors) => {
      exactKeys(death, DEATH_RESOLUTION_KEYS, deathLabel, deathErrors);
    });
  }
  validateObjectArray(raw.mediumResults, `${label}.mediumResults`, errors, (entry, entryLabel, entryErrors) => {
    exactKeys(entry, MEDIUM_RESULT_KEYS, entryLabel, entryErrors);
  });
  validateObjectArray(raw.claims, `${label}.claims`, errors, (claim, claimLabel, claimErrors) => {
    exactKeys(claim, CLAIM_KEYS, claimLabel, claimErrors);
  });
  validateObjectArray(raw.publicAbilityClaims, `${label}.publicAbilityClaims`, errors, (claim, claimLabel, claimErrors) => {
    exactKeys(claim, PUBLIC_ABILITY_CLAIM_KEYS, claimLabel, claimErrors);
  });
  validateObjectArray(raw.relationshipSnapshots, `${label}.relationshipSnapshots`, errors, (snapshot, snapshotLabel, snapshotErrors) => {
    if (!exactKeys(snapshot, RELATIONSHIP_SNAPSHOT_KEYS, snapshotLabel, snapshotErrors)) return;
    validateObjectArray(snapshot.nodes, `${snapshotLabel}.nodes`, snapshotErrors, (node, nodeLabel, nodeErrors) => {
      exactKeys(node, RELATIONSHIP_SNAPSHOT_NODE_KEYS, nodeLabel, nodeErrors);
    });
    validateObjectArray(snapshot.edges, `${snapshotLabel}.edges`, snapshotErrors, (edge, edgeLabel, edgeErrors) => {
      exactKeys(edge, RELATIONSHIP_SNAPSHOT_EDGE_KEYS, edgeLabel, edgeErrors);
    });
  });
  validateObjectArray(raw.events, `${label}.events`, errors, validateEventShape);
  validateObjectArray(raw.aiTurns, `${label}.aiTurns`, errors, (turn, turnLabel, turnErrors) => {
    if (!exactKeys(turn, AI_TURN_KEYS, turnLabel, turnErrors)) return;
    validateGenerationRunShape(turn.generationRun, `${turnLabel}.generationRun`, turnErrors);
    if (!Number.isInteger(turn.publicSequenceAtGeneration) || turn.publicSequenceAtGeneration < 0) {
      turnErrors.push(`${turnLabel}.publicSequenceAtGenerationは0以上の整数ではありません。`);
    }
    if (!Number.isInteger(turn.publicSequenceAtRegistration) || turn.publicSequenceAtRegistration < 0) {
      turnErrors.push(`${turnLabel}.publicSequenceAtRegistrationは0以上の整数ではありません。`);
    }
    if (turn.parsedSpeechInteraction !== null) {
      exactKeys(turn.parsedSpeechInteraction, PARSED_SPEECH_INTERACTION_KEYS, `${turnLabel}.parsedSpeechInteraction`, turnErrors);
    }
    if (turn.resolvedSpeechInteraction !== null) {
      exactKeys(turn.resolvedSpeechInteraction, RESOLVED_SPEECH_INTERACTION_KEYS, `${turnLabel}.resolvedSpeechInteraction`, turnErrors);
    }
    if (turn.parsedSharedStrategyPatch !== null) {
      validateSharedStrategyPatchShape(turn.parsedSharedStrategyPatch, `${turnLabel}.parsedSharedStrategyPatch`, turnErrors);
    }
    if (turn.parsedFactionStrategyPatch !== null) {
      validateFactionStrategyPatchShape(turn.parsedFactionStrategyPatch, `${turnLabel}.parsedFactionStrategyPatch`, turnErrors);
    }
    if (turn.parsedAttackAssessment !== null) {
      exactKeys(turn.parsedAttackAssessment, PARSED_ATTACK_ASSESSMENT_KEYS, `${turnLabel}.parsedAttackAssessment`, turnErrors);
    }
    if (turn.resolvedAttackAssessment !== null) {
      exactKeys(turn.resolvedAttackAssessment, RESOLVED_ATTACK_ASSESSMENT_KEYS, `${turnLabel}.resolvedAttackAssessment`, turnErrors);
    }
    if (turn.resolvedInternalReasoningDirective !== null) {
      if (exactKeys(turn.resolvedInternalReasoningDirective, INTERNAL_REASONING_DIRECTIVE_KEYS, `${turnLabel}.resolvedInternalReasoningDirective`, turnErrors)) {
        if (!Array.isArray(turn.resolvedInternalReasoningDirective.focusPlayerIds)) turnErrors.push(`${turnLabel}.resolvedInternalReasoningDirective.focusPlayerIdsが配列ではありません。`);
        if (!Array.isArray(turn.resolvedInternalReasoningDirective.anchorEventSequences)) turnErrors.push(`${turnLabel}.resolvedInternalReasoningDirective.anchorEventSequencesが配列ではありません。`);
      }
    }
  });
  if (raw.result !== null) exactKeys(raw.result, RESULT_KEYS, `${label}.result`, errors);
  if (includeHistory) {
    const historyOptions = { allowMissingGameRules };
    validateHistoryEntries(raw.undoStack, `${label}.undoStack`, errors, historyOptions);
    validateHistoryEntries(raw.redoStack, `${label}.redoStack`, errors, historyOptions);
    validateHistoryEntries(raw.restorePoints, `${label}.restorePoints`, errors, historyOptions);
  }
}

export function validateStateShape(raw, label = 'ルート', options = {}) {
  const errors = [];
  validateStateShapeInternal(raw, label, errors, options);
  return errors;
}

export function assertStateShape(raw, label = 'ルート', options = {}) {
  const errors = validateStateShape(raw, label, options);
  if (errors.length) throw new Error(errors.join('\n'));
  return raw;
}
