/**
 * 責務: app/shared/dataCompatibility配下の製品データschema・migration契約をRenderer ES Moduleへ接続する。
 * 変更ルール: schemaVersionやmigrationを複製しない。共有モジュールを唯一の正本とし、CommonJS/Browserどちらの読込形でも同じ契約を公開し、依存欠落時は起動を明示的に失敗させる。
 */

import * as versionsModule from '../../../shared/dataCompatibility/schemaVersions.js';
import '../../../shared/dataCompatibility/migrationRegistry.js';
import * as migrationModule from '../../../shared/dataCompatibility/migrateData.js';

const versions = versionsModule.default ?? globalThis.AiWerewolfDataSchemaVersions;
const migration = migrationModule.default ?? globalThis.AiWerewolfDataMigration;
if (!versions || !migration) throw new Error('共有データ互換モジュールを読み込めませんでした。');

export const { DATA_SCHEMA_KIND, CURRENT_DATA_SCHEMA_VERSIONS, getCurrentDataSchemaVersion } = versions;
export const { migrateData, migrateWithRegistry, requireSchemaVersion } = migration;
