/**
 * 責務: 重要なゲーム状態遷移が要求する復元ポイント種別・表示名と、1回の状態更新内での作成要求を管理する。
 * 変更ルール: スナップショット保存やDOM操作を行わない。必須復元ポイントの追加・名称変更はStateStoreと全進行コマンドの検証を同時更新する。
 */

const REQUESTS = Symbol('mandatory-restore-point-requests');
const COLLECTOR = Symbol('mandatory-restore-point-collector');

export const RESTORE_POINT_TYPES = Object.freeze({
  BEFORE_ROLE_CONFIRM: 'before-role-confirm',
  BEFORE_GAME_START: 'before-game-start',
  BEFORE_VOTE_FINALIZE: 'before-vote-finalize',
  BEFORE_EXECUTION_PUBLISH: 'before-execution-publish',
  BEFORE_ATTACK_FINALIZE: 'before-attack-finalize',
  BEFORE_NIGHT_RESOLVE: 'before-night-resolve',
  BEFORE_DAWN_PUBLISH: 'before-dawn-publish',
  BEFORE_RESULT_PUBLISH: 'before-result-publish',
});

export const RESTORE_POINT_LABELS = Object.freeze({
  [RESTORE_POINT_TYPES.BEFORE_ROLE_CONFIRM]: '配役確定前',
  [RESTORE_POINT_TYPES.BEFORE_GAME_START]: 'ゲーム開始前',
  [RESTORE_POINT_TYPES.BEFORE_VOTE_FINALIZE]: '投票確定前',
  [RESTORE_POINT_TYPES.BEFORE_EXECUTION_PUBLISH]: '処刑公開前',
  [RESTORE_POINT_TYPES.BEFORE_ATTACK_FINALIZE]: '正式襲撃対象確定前',
  [RESTORE_POINT_TYPES.BEFORE_NIGHT_RESOLVE]: '夜解決前',
  [RESTORE_POINT_TYPES.BEFORE_DAWN_PUBLISH]: '夜明け公開前',
  [RESTORE_POINT_TYPES.BEFORE_RESULT_PUBLISH]: 'ゲーム結果公開前',
});


export const PINNED_RESTORE_POINT_LABELS = Object.freeze([
  RESTORE_POINT_LABELS[RESTORE_POINT_TYPES.BEFORE_ROLE_CONFIRM],
  RESTORE_POINT_LABELS[RESTORE_POINT_TYPES.BEFORE_GAME_START],
]);

export function requestMandatoryRestorePoint(state, type) {
  const label = RESTORE_POINT_LABELS[type];
  if (!state || !label) throw new Error(`未知の復元ポイント種別です: ${String(type)}`);
  if (typeof state[COLLECTOR] === 'function') {
    state[COLLECTOR]({ type, label });
    return;
  }
  if (!Object.hasOwn(state, REQUESTS)) {
    Object.defineProperty(state, REQUESTS, {
      value: [],
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }
  if (!state[REQUESTS].some((request) => request.type === type)) {
    state[REQUESTS].push({ type, label });
  }
}


export function installMandatoryRestorePointCollector(state, collector) {
  if (!state || typeof collector !== 'function') throw new TypeError('復元ポイント収集関数が不正です。');
  Object.defineProperty(state, COLLECTOR, {
    value: collector,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

export function removeMandatoryRestorePointCollector(state) {
  if (state && Object.hasOwn(state, COLLECTOR)) delete state[COLLECTOR];
}

export function consumeMandatoryRestorePointRequests(state) {
  if (!state?.[REQUESTS]) return [];
  const requests = [...state[REQUESTS]];
  delete state[REQUESTS];
  return requests;
}

export function restorePointMatchesRevision(point, label, state) {
  return Boolean(point
    && point.label === label
    && point.state?.game?.id === state?.game?.id
    && Number(point.state?.revision ?? -1) === Number(state?.revision ?? -2));
}
