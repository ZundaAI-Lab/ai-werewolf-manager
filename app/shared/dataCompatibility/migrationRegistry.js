/**
 * 責務: 製品版ユーザーデータの「schema N → N+1」migrationをデータ種別ごとに登録・解決する。
 * 変更ルール: 正式リリース済みユーザーデータの一方向migrationは削除・意味変更せず、本体へ旧schema分岐を持ち込まない。内部実装の後方互換は不要だが、製品版で保存・出力した設定・ゲーム・AIプロファイルは本レジストリ配下で現行schemaへ移行する。新schema追加時は専用migrationと実データ相当fixtureを追加し、飛び級migrationは作らない。
 */

(function initializeMigrationRegistry(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) {
    root.AiWerewolfMigrationRegistry = api;
    if (root.window && root.window !== root) root.window.AiWerewolfMigrationRegistry = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function isDocument(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function renameGenerationProfileReferences(generation) {
    if (!isDocument(generation)) return generation;
    const {
      draftProfileId = null,
      renderProfileId = null,
      proofreadProfileId = null,
      ...rest
    } = generation;
    return {
      ...rest,
      reasoningProfileId: draftProfileId,
      outputProfileId: renderProfileId,
      critiqueProfileId: proofreadProfileId,
    };
  }

  function migrateProfileGenerations(documentValue) {
    if (!Array.isArray(documentValue.profiles)) return documentValue;
    return {
      ...documentValue,
      profiles: documentValue.profiles.map((profile) => (
        isDocument(profile)
          ? { ...profile, generation: renameGenerationProfileReferences(profile.generation) }
          : profile
      )),
    };
  }

  function migrateDesktopSettingsV1ToV2(raw) {
    const migrated = migrateProfileGenerations(raw);
    return { ...migrated, schemaVersion: 2 };
  }

  function migrateAiProfilePackageV1ToV2(raw) {
    const migrated = migrateProfileGenerations(raw);
    return { ...migrated, schemaVersion: 2 };
  }

  const LEGACY_GENERATION_STAGE_MAP = Object.freeze({
    direct: 'direct',
    draft: 'decide',
    render: 'render',
    proofread: 'render',
  });

  function migrateGenerationRunV1ToV2(run) {
    if (!isDocument(run) || run.schemaVersion !== 1) return run;
    const stages = Array.isArray(run.stages)
      ? run.stages.map((stage) => {
        if (!isDocument(stage)) return stage;
        return {
          ...stage,
          stageId: LEGACY_GENERATION_STAGE_MAP[stage.stageId] ?? stage.stageId,
          rejectedAttempts: [],
        };
      })
      : run.stages;
    return {
      ...run,
      schemaVersion: 2,
      finalStageId: LEGACY_GENERATION_STAGE_MAP[run.finalStageId] ?? run.finalStageId,
      stages,
    };
  }

  const HISTORY_KEYS = Object.freeze(['undoStack', 'redoStack', 'restorePoints']);

  function migrateGameSnapshotV1ToV2(snapshot) {
    if (!isDocument(snapshot)) return snapshot;
    const migrated = {
      ...snapshot,
      schemaVersion: 2,
      aiTurns: Array.isArray(snapshot.aiTurns)
        ? snapshot.aiTurns.map((turn) => (
          isDocument(turn)
            ? { ...turn, generationRun: migrateGenerationRunV1ToV2(turn.generationRun) }
            : turn
        ))
        : snapshot.aiTurns,
    };
    for (const key of HISTORY_KEYS) {
      if (!Array.isArray(snapshot[key])) continue;
      migrated[key] = snapshot[key].map((entry) => (
        isDocument(entry) && isDocument(entry.state)
          ? { ...entry, state: migrateGameSnapshotV1ToV2(entry.state) }
          : entry
      ));
    }
    return migrated;
  }

  function migrateGameStateV1ToV2(raw) {
    return migrateGameSnapshotV1ToV2(raw);
  }

  const DATA_MIGRATIONS = Object.freeze({
    'game-state': Object.freeze({ 1: migrateGameStateV1ToV2 }),
    'desktop-settings': Object.freeze({ 1: migrateDesktopSettingsV1ToV2 }),
    'ai-profile-package': Object.freeze({ 1: migrateAiProfilePackageV1ToV2 }),
  });

  function migrationFor(kind, fromVersion, registry = DATA_MIGRATIONS) {
    return registry?.[kind]?.[fromVersion] ?? null;
  }

  return Object.freeze({ DATA_MIGRATIONS, migrationFor });
});
