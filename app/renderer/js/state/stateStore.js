/**
 * 責務: 状態の初期化、現在の準備設定を引き継ぐ再開始、正規化、Undo／Redo、ゲーム処理層から要求された必須復元ポイント、訂正開始時の安全復元、変更通知を管理し、役職に応じた本人限定陣営戦略の初期形を生成する。履歴スナップショットでは進行復旧に不要なAIプロンプト・生回答だけを圧縮し、現行状態の監査情報は保持する。
 * 変更ルール:
 * - ゲーム規則と陣営戦略の意味判定は専用モジュールへ委譲し、DOM操作・永続化を行わない。
 * - 通常の状態更新はStateStore.commit経由に統一し、commitは既にclone済みのdraftを再deepCloneせず、その場で全体検証・正規化して確定する。
 * - subscriber通知は確定済み状態を観測する副作用としてcommit結果から分離し、個別subscriberの例外で状態更新結果や後続通知を失敗扱いにしない。
 * - 外部入力だけは独立cloneする。
 * - 検証済みJSON全置換だけはreplaceのpreserveProvidedHistoryで提供済み履歴を変更せず採用する。
 * - revisionは状態更新通番としてUndo／Redoでも単調増加させ、過去状態へ戻って別分岐した場合も同一revisionを再利用しない。
 * - Undo／Redoで相互スタックへ積み直す履歴ラベルは元操作名を保持し、表示用の「取り消し／やり直し」文言を履歴ラベルへ連結しない。
 * - 必須復元ポイントはUIオプションではなくゲームコマンドの非永続要求から変更前状態を保存し、同一リビジョン・同一名称の重複を作らない。
 * - 復元ポイント一覧は復元対象外として保持し、復元前の後続イベントはキー順に依存しない内容比較で抽出して監査保存用コンテキストとして呼出元へ渡す。
 * - 設定引継ぎ再開始ではゲーム名・参加者ID・キャラクター・担当・開始前プレイヤー別配役・呼称・ルールだけを保持し、開始後のシャッフル・役職欠け結果を配役設定へ逆流させず、進行状態・本人限定判断・公開履歴・相関スナップショット・Undo／Redo・復元ポイントを必ず新規ゲーム状態へ戻す。
 * - JSON読込値はstateImportCompatibilityPolicy.jsで保存時バージョンではなく現在必要な構造・型として扱えるか確認してから渡す。
 * - 進行中・完走済みを問わず版番号だけでは拒否せず、ゲーム事実を推測・型変換しない。
 * - game.rulesは版番号に依存せず、既知の欠落項目だけを現在の既定値で補完し、未知項目を除去し、不正な既存値を拒否する。
 * - 履歴圧縮では判断・参照ID・フォールバック判定情報を削除せず、復元時に現行監査記録から同一AIターンの詳細を再結合する。
 */

import {
  APP_VERSION,
  PROMPT_SPEC_VERSION,
  DEFAULT_CHARACTER,
  DEFAULT_RULES,
  MAX_RESTORE_POINTS,
  MAX_UNDO,
  SCHEMA_VERSION,
} from '../config/constants.js';
import { BUILD_ID } from '../../generated/buildInfo.js';
import { createId, deepClone, deepMerge, nowIso, shuffle, stableStringify } from '../shared/utils.js';
import { assertStateShape } from './stateSchema.js';
import { createEmptyInternalMemory, createEmptyMemoryLedger, rebuildAllMemoryLedgers } from '../domain/memory/memoryLedger.js';
import { getPresetRolesForPlayerCount } from '../domain/setup/playerCountPolicy.js';
import { createEmptyFactionStrategyState } from '../domain/game/factionStrategyState.js';
import { createEmptyDecisionState } from '../domain/game/decisionState.js';
import { normalizeImportedGameRules } from '../domain/game/gameRulePolicy.js';
import { createRoleState } from '../domain/roles/roleState.js';
import {
  consumeMandatoryRestorePointRequests,
  installMandatoryRestorePointCollector,
  PINNED_RESTORE_POINT_LABELS,
  removeMandatoryRestorePointCollector,
  restorePointMatchesRevision,
} from '../domain/correction/restorePointPolicy.js';

function normalizeCallNameOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([targetPlayerId, entry]) => {
    const preferred = String(typeof entry === 'string' ? entry : entry?.preferred ?? '').trim();
    if (!preferred) return [];
    return [[targetPlayerId, preferred]];
  }));
}

export function createPlayer(overrides = {}) {
  const roleId = overrides.roleId ?? 'villager';
  const character = deepMerge(DEFAULT_CHARACTER, overrides.character ?? {});
  character.reasoningProfile = { ...(character.reasoningProfile ?? {}) };
  return {
    id: overrides.id ?? createId('player'),
    name: overrides.name ?? '新規プレイヤー',
    aliases: Array.isArray(overrides.aliases) ? overrides.aliases : [],
    characterCardId: overrides.characterCardId ?? null,
    callNameOverrides: normalizeCallNameOverrides(overrides.callNameOverrides),
    controller: overrides.controller ?? 'ai',
    roleId,
    roleState: createRoleState(roleId, overrides.roleState),
    statusEffects: Array.isArray(overrides.statusEffects) ? deepClone(overrides.statusEffects) : [],
    alive: overrides.alive ?? true,
    death: overrides.death ?? null,
    character,
    privateInfo: overrides.privateInfo ?? '',
    heartVoice: overrides.heartVoice ?? '',
    heartVoiceUpdatedAt: overrides.heartVoiceUpdatedAt ?? null,
    heartVoiceHistory: Array.isArray(overrides.heartVoiceHistory) ? overrides.heartVoiceHistory : [],
    internalMemory: createEmptyInternalMemory(overrides.internalMemory ?? {}),
    memoryLedger: createEmptyMemoryLedger(overrides.memoryLedger ?? {}),
    memoHistory: Array.isArray(overrides.memoHistory) ? overrides.memoHistory : [],
    aiContextStatus: overrides.aiContextStatus ?? 'not-ready',
    factionStrategyState: overrides.factionStrategyState === undefined
      ? createEmptyFactionStrategyState(roleId)
      : overrides.factionStrategyState === null
        ? null
        : deepMerge(createEmptyFactionStrategyState(roleId) ?? {}, overrides.factionStrategyState),
    decisionState: deepMerge(createEmptyDecisionState(), overrides.decisionState ?? {}),
  };
}

function createPlayers(count = 8) {
  const roles = shuffle(getPresetRolesForPlayerCount(count));
  return roles.map((roleId, index) => createPlayer({
    name: `プレイヤー${index + 1}`,
    roleId,
  }));
}

export function createInitialState(count = 8) {
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    runtime: {
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      buildId: BUILD_ID,
      promptSpecVersion: PROMPT_SPEC_VERSION,
    },
    revision: 0,
    lastActionLabel: '初期状態',

    game: {
      id: createId('game'),
      title: 'AI人狼ゲーム',
      preset: 'standard',
      status: 'setup',
      day: 0,
      phase: 'setup',
      phaseStartedAt: nowIso(),
      eventSequence: 0,
      stateRevision: 0,
      winner: null,
      winnerReason: '',
      correctionMode: { enabled: false, reason: '', startedAt: null },
      callNameSnapshot: null,
      setupRoleAssignments: null,
      publicRoleComposition: null,
      rules: deepClone(DEFAULT_RULES),
    },

    players: createPlayers(count),
    playerKnowledge: {},
    briefing: null,
    discussion: null,
    voteSession: null,
    wolfConversations: [],
    masonConversations: [],
    graveyardConversations: [],
    night: null,
    executionResolution: null,
    mediumResults: [],
    claims: [],
    publicAbilityClaims: [],
    relationshipSnapshots: [],
    events: [],
    aiTurns: [],
    result: null,
    publicRevision: 0,

    undoStack: [],
    redoStack: [],
    restorePoints: [],
  };
}

function createPlayerFromCurrentSetup(player, roleId = player.roleId) {
  return createPlayer({
    id: player.id,
    name: player.name,
    aliases: player.aliases,
    characterCardId: player.characterCardId,
    callNameOverrides: player.callNameOverrides,
    controller: player.controller,
    roleId,
    character: player.character,
    privateInfo: player.privateInfo,
  });
}

export function createRestartedGameState(sourceState) {
  if (!sourceState?.game || !Array.isArray(sourceState.players)) {
    throw new TypeError('設定を引き継ぐ元のゲーム状態が不正です。');
  }

  const restarted = createInitialState(sourceState.players.length);
  restarted.game.title = String(sourceState.game.title ?? restarted.game.title);
  restarted.game.preset = String(sourceState.game.preset ?? restarted.game.preset);
  restarted.game.rules = deepClone(sourceState.game.rules);
  const setupRoleAssignments = sourceState.game.setupRoleAssignments;
  restarted.players = sourceState.players.map((player) => createPlayerFromCurrentSetup(
    player,
    setupRoleAssignments?.[player.id] ?? player.roleId,
  ));
  return restarted;
}

function normalizeWolfSharedStrategy(strategy, purpose) {
  const source = strategy ?? {};
  return {
    claimPlan: String(source.claimPlan ?? ''),
    blackReceivedPlan: String(source.blackReceivedPlan ?? ''),
    partnerExecutionPlan: String(source.partnerExecutionPlan ?? ''),
    collapsePlan: String(source.collapsePlan ?? ''),
    discussionPlan: String(source.discussionPlan ?? ''),
    attackPlan: purpose === 'opening-strategy' ? 'none' : String(source.attackPlan ?? ''),
    updatedAt: source.updatedAt ?? null,
    updatedByPlayerId: source.updatedByPlayerId ?? null,
  };
}

function normalizeWolfConversation(session) {
  const purpose = session?.purpose ?? 'attack-planning';
  return {
    ...session,
    purpose,
    participantIds: [...session.participantIds],
    messages: [...session.messages],
    speechCountPerParticipant: session.speechCountPerParticipant,
    remainingByParticipant: { ...session.remainingByParticipant },
    sharedStrategy: normalizeWolfSharedStrategy(session.sharedStrategy, purpose),
  };
}


function normalizeMasonConversation(session) {
  return {
    ...session,
    participantIds: [...session.participantIds],
    messages: [...session.messages],
    speechCountPerParticipant: session.speechCountPerParticipant,
    remainingByParticipant: { ...session.remainingByParticipant },
  };
}

function normalizeGraveyardConversation(session) {
  return {
    ...session,
    participantIds: [...session.participantIds],
    messages: [...session.messages],
    speechCountPerParticipant: session.speechCountPerParticipant,
    remainingByParticipant: { ...session.remainingByParticipant },
  };
}

function normalizeDiscussion(discussion) {
  if (!discussion) return null;
  const reconsideration = discussion.reconsideration ?? {};
  return {
    ...discussion,
    roundKind: discussion.roundKind ?? 'normal',
    roundStartedAtSequence: Number(discussion.roundStartedAtSequence ?? 0),
    roundEligiblePlayerIds: [...(discussion.roundEligiblePlayerIds ?? [])],
    deferredCountByPlayer: { ...(discussion.deferredCountByPlayer ?? {}) },
    reconsideration: {
      pending: Boolean(reconsideration.pending),
      active: Boolean(reconsideration.active),
      items: [...(reconsideration.items ?? [])].map((item) => ({ ...item, targetPlayerIds: [...(item.targetPlayerIds ?? [])] })),
      reasons: [...(reconsideration.reasons ?? [])],
      sourceEventIds: [...(reconsideration.sourceEventIds ?? [])],
      affectedPlayerIds: [...(reconsideration.affectedPlayerIds ?? [])],
      updatedAt: reconsideration.updatedAt ?? null,
      handledRound: reconsideration.handledRound ?? null,
    },
  };
}

function normalizeBriefing(briefing) {
  if (!briefing) return null;
  const eligible = Array.isArray(briefing.eligiblePlayerIds) ? briefing.eligiblePlayerIds : [];
  return {
    roleAssignmentFrozen: Boolean(briefing.roleAssignmentFrozen),
    eligiblePlayerIds: [...eligible],
    noticeStatusByPlayerId: { ...(briefing.noticeStatusByPlayerId ?? {}) },
    aiContextReadyByPlayerId: { ...(briefing.aiContextReadyByPlayerId ?? {}) },
    forcedReasonByPlayerId: { ...(briefing.forcedReasonByPlayerId ?? {}) },
    completed: Boolean(briefing.completed),
  };
}

function assertNormalizableSnapshot(raw, { normalizeHistory = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('JSON状態がオブジェクトではありません。');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`正規化前にschemaVersion差の読込準備が必要です。データ:${raw.schemaVersion ?? '不明'} / 現行:${SCHEMA_VERSION}`);
  }
  assertStateShape(raw, '状態正規化', { includeHistory: normalizeHistory, allowMissingGameRules: true });
}

function normalizeSnapshotInPlace(state, { normalizeHistory = true } = {}) {
  state.appVersion = APP_VERSION;
  state.runtime = {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: BUILD_ID,
    promptSpecVersion: PROMPT_SPEC_VERSION,
  };
  state.revision ??= 0;
  state.game ??= createInitialState().game;
  state.game.stateRevision ??= state.revision;
  state.game.rules = normalizeImportedGameRules(state.game.rules, { label: '状態正規化.game.rules' });
  state.game.correctionMode = deepMerge({ enabled: false, reason: '', startedAt: null }, state.game.correctionMode ?? {});
  state.game.callNameSnapshot ??= null;
  state.players = (state.players ?? []).map((player) => createPlayer(player));
  state.playerKnowledge ??= {};
  state.briefing = normalizeBriefing(state.briefing);
  state.discussion = normalizeDiscussion(state.discussion);
  state.wolfConversations = (state.wolfConversations ?? []).map(normalizeWolfConversation);
  state.masonConversations = (state.masonConversations ?? []).map(normalizeMasonConversation);
  state.graveyardConversations = (state.graveyardConversations ?? []).map(normalizeGraveyardConversation);
  state.executionResolution ??= null;
  state.mediumResults ??= [];
  state.claims ??= [];
  state.publicAbilityClaims ??= [];
  state.events ??= [];
  state.aiTurns ??= [];
  state.result ??= null;
  state.publicRevision ??= 0;
  state.lastActionLabel ??= '状態読込';
  state.undoStack = Array.isArray(state.undoStack) ? state.undoStack : [];
  state.redoStack = Array.isArray(state.redoStack) ? state.redoStack : [];
  state.restorePoints = Array.isArray(state.restorePoints) ? state.restorePoints : [];
  if (normalizeHistory) {
    const normalizeEntry = (entry, { compactAudit = true } = {}) => {
      const normalizedState = entry?.state ? normalizeSnapshot(entry.state, { normalizeHistory: false }) : entry?.state;
      return {
        ...entry,
        state: normalizedState && compactAudit ? compactHistorySnapshot(normalizedState) : normalizedState,
      };
    };
    state.undoStack = state.undoStack.map((entry) => normalizeEntry(entry));
    state.redoStack = state.redoStack.map((entry) => normalizeEntry(entry, { compactAudit: false }));
    state.restorePoints = state.restorePoints.map((entry) => normalizeEntry(entry));
  }
  return state;
}

function normalizeSnapshot(raw, { normalizeHistory = true } = {}) {
  assertNormalizableSnapshot(raw, { normalizeHistory });
  return normalizeSnapshotInPlace(deepClone(raw), { normalizeHistory });
}

export function normalizeState(raw) {
  return normalizeSnapshot(raw);
}

function stateRootClone(state) {
  const snapshot = deepClone({
    ...state,
    undoStack: [],
    redoStack: [],
    restorePoints: [],
  });
  return snapshot;
}

function compactGenerationRun(generationRun) {
  if (!generationRun) return generationRun;
  return {
    ...generationRun,
    stages: (generationRun.stages ?? []).map((stage) => ({
      ...stage,
      rawResponse: '',
    })),
  };
}

function compactHistorySnapshot(state) {
  const snapshot = stateRootClone(state);
  snapshot.aiTurns = (snapshot.aiTurns ?? []).map((turn) => ({
    ...turn,
    promptText: '',
    rawResponse: '',
    generationRun: compactGenerationRun(turn.generationRun),
  }));
  return snapshot;
}

function hydrateHistorySnapshot(snapshot, auditSourceState) {
  const restored = stateRootClone(snapshot);
  const auditByTurnId = new Map((auditSourceState?.aiTurns ?? []).map((turn) => [turn.id, turn]));
  restored.aiTurns = (restored.aiTurns ?? []).map((turn) => {
    const audit = auditByTurnId.get(turn.id);
    if (!audit) return turn;
    return {
      ...turn,
      promptText: audit.promptText,
      rawResponse: audit.rawResponse,
      generationRun: deepClone(audit.generationRun),
    };
  });
  return restored;
}

function attachHistory(state, { undoStack = [], redoStack = [], restorePoints = [] } = {}) {
  state.undoStack = [...undoStack];
  state.redoStack = [...redoStack];
  state.restorePoints = [...restorePoints];
  return state;
}

function normalizeCommittedState(state) {
  const histories = {
    undoStack: state.undoStack,
    redoStack: state.redoStack,
    restorePoints: state.restorePoints,
  };
  state.undoStack = [];
  state.redoStack = [];
  state.restorePoints = [];
  assertNormalizableSnapshot(state, { normalizeHistory: false });
  normalizeSnapshotInPlace(state, { normalizeHistory: false });
  return attachHistory(state, histories);
}

function historyEntry(label, state, { compactAudit = true } = {}) {
  return {
    id: createId('history'),
    label,
    createdAt: nowIso(),
    state: compactAudit ? compactHistorySnapshot(state) : stateRootClone(state),
  };
}

function restorePointEntry(label, state) {
  return { id: createId('restore'), label, createdAt: nowIso(), state: compactHistorySnapshot(state) };
}

function appendRestorePoint(points, label, sourceState) {
  const normalizedLabel = String(label ?? '').trim();
  if (!normalizedLabel) return points;
  if (points.some((point) => restorePointMatchesRevision(point, normalizedLabel, sourceState))) return points;
  const gameId = sourceState?.game?.id;
  const withoutReplacedAnchor = PINNED_RESTORE_POINT_LABELS.includes(normalizedLabel)
    ? points.filter((point) => !(point.label === normalizedLabel && point.state?.game?.id === gameId))
    : points;
  const nextPoints = [...withoutReplacedAnchor, restorePointEntry(normalizedLabel, sourceState)];
  if (nextPoints.length <= MAX_RESTORE_POINTS) return nextPoints;
  const pinned = nextPoints.filter((point) => PINNED_RESTORE_POINT_LABELS.includes(point.label));
  const regular = nextPoints.filter((point) => !PINNED_RESTORE_POINT_LABELS.includes(point.label));
  const regularLimit = Math.max(0, MAX_RESTORE_POINTS - pinned.length);
  return [...pinned.slice(-MAX_RESTORE_POINTS), ...(regularLimit ? regular.slice(-regularLimit) : [])];
}


function deepFreezeState(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreezeState);
  return Object.freeze(value);
}

function immutableState(state) {
  return deepFreezeState(state);
}

export class StateStore {
  #state;
  #listeners = new Set();

  constructor(initialState) {
    this.#state = immutableState(normalizeState(initialState));
  }

  getState() {
    return this.#state;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  commit(label, mutator, options = {}) {
    const before = this.#state;
    const draft = attachHistory(stateRootClone(this.#state), {
      undoStack: this.#state.undoStack,
      redoStack: this.#state.redoStack,
      restorePoints: this.#state.restorePoints,
    });
    const mandatoryRestorePoints = [];
    installMandatoryRestorePointCollector(draft, ({ type, label: restorePointLabel }) => {
      if (mandatoryRestorePoints.some((request) => request.type === type)) return;
      mandatoryRestorePoints.push({ type, label: restorePointLabel, snapshot: stateRootClone(draft) });
    });
    try {
      mutator(draft);
    } finally {
      removeMandatoryRestorePointCollector(draft);
    }
    rebuildAllMemoryLedgers(draft);
    draft.revision = (this.#state.revision ?? 0) + 1;
    draft.game.stateRevision = draft.revision;
    draft.lastActionLabel = label;

    consumeMandatoryRestorePointRequests(draft).forEach((request) => {
      if (!mandatoryRestorePoints.some((item) => item.type === request.type)) {
        mandatoryRestorePoints.push({ ...request, snapshot: before });
      }
    });
    mandatoryRestorePoints.forEach(({ label: restorePointLabel, snapshot }) => {
      draft.restorePoints = appendRestorePoint(draft.restorePoints, restorePointLabel, snapshot ?? before);
    });
    const publishedDuringCommit = (draft.publicRevision ?? 0) !== (this.#state.publicRevision ?? 0);
    if (options.clearHistory || options.publicBarrier || options.informationBarrier || publishedDuringCommit) {
      draft.undoStack = [];
      draft.redoStack = [];
    } else if (options.recordUndo !== false) {
      draft.undoStack.push(historyEntry(label, before));
      if (draft.undoStack.length > MAX_UNDO) draft.undoStack.shift();
      draft.redoStack = [];
    }

    this.#state = immutableState(normalizeCommittedState(draft));
    this.#notify();
    return this.#state;
  }

  replace(label, state, options = {}) {
    const next = normalizeState(state);
    if (options.preserveProvidedHistory === true) {
      this.#state = immutableState(next);
      this.#notify();
      return this.#state;
    }
    return this.commit(label, (draft) => {
      Object.keys(draft).forEach((key) => delete draft[key]);
      Object.assign(draft, next);
    }, options);
  }

  reset(count = 8) {
    this.#state = immutableState(createInitialState(count));
    this.#notify();
  }

  restartWithCurrentSetup() {
    this.#state = immutableState(createRestartedGameState(this.#state));
    this.#notify();
  }

  undo() {
    const entry = this.#state.undoStack.at(-1);
    if (!entry) return false;
    const current = historyEntry(entry.label, this.#state, { compactAudit: false });
    const restored = normalizeSnapshot(hydrateHistorySnapshot(entry.state, this.#state), { normalizeHistory: false });
    restored.redoStack = [...this.#state.redoStack, current].slice(-MAX_UNDO);
    restored.undoStack = this.#state.undoStack.slice(0, -1);
    restored.restorePoints = [...this.#state.restorePoints];
    restored.revision = Number(this.#state.revision ?? 0) + 1;
    restored.game.stateRevision = restored.revision;
    restored.lastActionLabel = `${entry.label}を取り消し`;
    this.#state = immutableState(restored);
    this.#notify();
    return true;
  }

  redo() {
    const entry = this.#state.redoStack.at(-1);
    if (!entry) return false;
    const current = historyEntry(entry.label, this.#state);
    const restored = normalizeSnapshot(hydrateHistorySnapshot(entry.state, this.#state), { normalizeHistory: false });
    restored.undoStack = [...this.#state.undoStack, current].slice(-MAX_UNDO);
    restored.redoStack = this.#state.redoStack.slice(0, -1);
    restored.restorePoints = [...this.#state.restorePoints];
    restored.revision = Number(this.#state.revision ?? 0) + 1;
    restored.game.stateRevision = restored.revision;
    restored.lastActionLabel = `${entry.label}をやり直し`;
    this.#state = immutableState(restored);
    this.#notify();
    return true;
  }

  canUndo() { return this.#state.undoStack.length > 0; }
  canRedo() { return this.#state.redoStack.length > 0; }
  getUndoLabel() { return this.#state.undoStack.at(-1)?.label ?? ''; }
  getRedoLabel() { return this.#state.redoStack.at(-1)?.label ?? ''; }

  createRestorePoint(label) {
    const existing = this.#state.restorePoints.find((point) => restorePointMatchesRevision(point, label, this.#state));
    if (existing) return existing;
    const restorePoints = appendRestorePoint(this.#state.restorePoints, label, this.#state);
    const next = attachHistory(stateRootClone(this.#state), {
      undoStack: this.#state.undoStack,
      redoStack: this.#state.redoStack,
      restorePoints,
    });
    this.#state = immutableState(normalizeCommittedState(next));
    this.#notify();
    return this.#state.restorePoints.find((point) => restorePointMatchesRevision(point, label, this.#state)) ?? null;
  }

  restoreFromPoint(pointId, label, afterRestore = null) {
    const point = this.#state.restorePoints.find((item) => item.id === pointId);
    if (!point) return false;
    const currentState = this.#state;
    const pointEventsById = new Map((point.state?.events ?? []).map((event) => [event.id, event]));
    const supersededEvents = (currentState.events ?? [])
      .filter((event) => {
        const pointEvent = pointEventsById.get(event.id);
        return !pointEvent || stableStringify(pointEvent) !== stableStringify(event);
      })
      .map((event) => deepClone(event));
    const safetyLabel = `訂正開始時の現在状態（${currentState.game.day}日目・${currentState.game.phase}）`;
    const preservedPoints = appendRestorePoint(currentState.restorePoints, safetyLabel, currentState);
    const restored = normalizeSnapshot(hydrateHistorySnapshot(point.state, currentState), { normalizeHistory: false });
    restored.restorePoints = preservedPoints;
    restored.undoStack = [];
    restored.redoStack = [];
    restored.game.correctionMode = { enabled: true, reason: label, startedAt: nowIso() };
    restored.lastActionLabel = label;
    const restoreContext = {
      restorePointId: point.id,
      restorePointLabel: point.label,
      restoredFromRevision: currentState.revision,
      restoredToRevision: point.state?.revision ?? 0,
      supersededEvents,
    };
    if (afterRestore) afterRestore(restored, restoreContext);
    restored.revision = (currentState.revision ?? 0) + 1;
    restored.game.stateRevision = restored.revision;
    this.#state = immutableState(normalizeCommittedState(restored));
    this.#notify();
    return true;
  }

  #notify() {
    this.#listeners.forEach((listener) => {
      try {
        listener(this.#state);
      } catch (error) {
        console.error('[StateStore] subscriber failed', error);
      }
    });
  }
}
