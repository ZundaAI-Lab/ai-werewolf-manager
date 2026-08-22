/**
 * 責務: 製品版ゲーム保存JSONを共有migrationで現行schemaへ上げた後、現在の実行に必要な構造・型で受入可能か判定できる形へ整える。
 * 変更ルール:
 * - schemaVersionはdataCompatibilityの互換契約として扱い、旧schemaは一方向migration、未来schemaは拒否する。appVersion・buildId・promptSpecVersionは出自確認用で読込拒否条件にしない。
 * - 進行中／完走済みを区別せず、現在必要なゲーム事実を推測・型変換せずに扱える状態だけを受理する。
 * - 未知のルート／player項目は現在の実行に不要なので除去する。game.rulesの既知欠落・未知項目処理はgameRulePolicy.jsへ委譲する。
 * - claims・公開能力結果・decisionState・memoryLedger公開派生部・discussion.reconsiderationなど再生成可能な値は現行ロジックで再構築できる初期形へ整える。
 * - Undo／Redo／復元ポイントは版差だけでは破棄しない。現在扱えない履歴エントリだけを個別に除外し、呼出元へ警告を返す。
 */

import { APP_VERSION, PROMPT_SPEC_VERSION, SCHEMA_VERSION } from '../config/constants.js';
import { DATA_SCHEMA_KIND, migrateData } from '../config/dataCompatibilityAdapter.js';
import { BUILD_ID } from '../../generated/buildInfo.js';
import { createEmptyDecisionState } from '../domain/game/decisionState.js';
import { createEmptyMemoryLedger } from '../domain/memory/memoryLedger.js';
import { deepClone } from '../shared/utils.js';
import {
  assertStateShape,
  STATE_HISTORY_ENTRY_KEYS,
  STATE_PLAYER_KEYS,
  STATE_ROOT_KEYS,
} from './stateSchema.js';

const HISTORY_KEYS = Object.freeze(['undoStack', 'redoStack', 'restorePoints']);
const ROOT_KEY_SET = new Set(STATE_ROOT_KEYS);
const PLAYER_KEY_SET = new Set(STATE_PLAYER_KEYS);
const HISTORY_ENTRY_KEY_SET = new Set(STATE_HISTORY_ENTRY_KEYS);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keepKnownKeys(source, allowedKeys) {
  if (!isPlainObject(source)) return source;
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowedKeys.has(key)));
}

function currentRuntime() {
  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: BUILD_ID,
    promptSpecVersion: PROMPT_SPEC_VERSION,
  };
}

function emptyReconsideration(previous = null) {
  const source = isPlainObject(previous) ? previous : {};
  return {
    pending: false,
    active: typeof source.active === 'boolean' ? source.active : false,
    items: [],
    reasons: [],
    sourceEventIds: [],
    affectedPlayerIds: [],
    updatedAt: typeof source.updatedAt === 'string' || source.updatedAt === null ? source.updatedAt : null,
    handledRound: Number.isInteger(source.handledRound) ? source.handledRound : null,
  };
}

function preparePlayer(player) {
  if (!isPlainObject(player)) return player;
  const prepared = keepKnownKeys(player, PLAYER_KEY_SET);
  const selectionRationales = Array.isArray(prepared.memoryLedger?.selectionRationales)
    ? deepClone(prepared.memoryLedger.selectionRationales)
    : [];
  prepared.decisionState = createEmptyDecisionState();
  prepared.memoryLedger = createEmptyMemoryLedger({ selectionRationales });
  return prepared;
}

function prepareSafeCurrentFields(snapshot) {
  snapshot.schemaVersion = SCHEMA_VERSION;
  snapshot.appVersion = APP_VERSION;
  snapshot.runtime = currentRuntime();
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) snapshot.revision = 0;
  if (typeof snapshot.lastActionLabel !== 'string') snapshot.lastActionLabel = '状態読込';
  if (!Number.isInteger(snapshot.publicRevision) || snapshot.publicRevision < 0) snapshot.publicRevision = 0;

  if (isPlainObject(snapshot.game)) {
    if (!Number.isInteger(snapshot.game.stateRevision) || snapshot.game.stateRevision < 0) {
      snapshot.game.stateRevision = snapshot.revision;
    }
    if (!isPlainObject(snapshot.game.correctionMode)) {
      snapshot.game.correctionMode = { enabled: false, reason: '', startedAt: null };
    }
    if (!Object.hasOwn(snapshot.game, 'callNameSnapshot')) snapshot.game.callNameSnapshot = null;
  }

  snapshot.claims = [];
  snapshot.publicAbilityClaims = [];
  if (!Array.isArray(snapshot.relationshipSnapshots)) snapshot.relationshipSnapshots = [];
  if (Array.isArray(snapshot.players)) snapshot.players = snapshot.players.map(preparePlayer);
  if (isPlainObject(snapshot.discussion)) {
    snapshot.discussion.reconsideration = emptyReconsideration(snapshot.discussion.reconsideration);
  }
}

function prepareHistoryEntry(entry, key, index, warnings) {
  if (!isPlainObject(entry) || !isPlainObject(entry.state)) {
    warnings.push(`${key}[${index}]は現在利用できる状態スナップショットではないため除外しました。`);
    return null;
  }
  try {
    const preparedState = prepareSnapshot(entry.state, { includeHistory: false, warnings });
    const preparedEntry = keepKnownKeys(entry, HISTORY_ENTRY_KEY_SET);
    preparedEntry.state = preparedState;
    assertStateShape(preparedEntry.state, `${key}[${index}].state`, { includeHistory: false, allowMissingGameRules: true });
    return preparedEntry;
  } catch (error) {
    warnings.push(`${key}[${index}]は現在利用できないため除外しました: ${error.message}`);
    return null;
  }
}

function prepareHistory(snapshot, warnings) {
  HISTORY_KEYS.forEach((key) => {
    const entries = snapshot[key];
    if (!Array.isArray(entries)) {
      if (entries !== undefined && entries !== null) warnings.push(`${key}が配列ではないため空の履歴として扱いました。`);
      snapshot[key] = [];
      return;
    }
    snapshot[key] = entries
      .map((entry, index) => prepareHistoryEntry(entry, key, index, warnings))
      .filter(Boolean);
  });
}

function prepareSnapshot(raw, { includeHistory = true, warnings = [] } = {}) {
  if (!isPlainObject(raw)) throw new Error('JSON状態がオブジェクトではありません。');

  const migrated = migrateData(DATA_SCHEMA_KIND.GAME_STATE, raw, { label: 'ゲーム保存データ' }).value;
  const snapshot = keepKnownKeys(deepClone(migrated), ROOT_KEY_SET);
  prepareSafeCurrentFields(snapshot);
  if (includeHistory) prepareHistory(snapshot, warnings);
  else HISTORY_KEYS.forEach((key) => { snapshot[key] = []; });

  assertStateShape(snapshot, 'インポート互換検査', { includeHistory, allowMissingGameRules: true });
  return snapshot;
}

export function prepareStateForImport(raw, { warnings = [] } = {}) {
  return prepareSnapshot(raw, { includeHistory: true, warnings });
}
