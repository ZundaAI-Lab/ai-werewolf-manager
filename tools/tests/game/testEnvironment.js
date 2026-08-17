/**
 * 責務: ゲーム回帰テストがRenderer製品モジュールを読み込む前に、製品Mainと同じgroup.json正本ローダーをdesktopWerewolf同期ブリッジとして注入する。
 * 変更ルール: キャラクターデータ読込ロジックを複製せずapp/main/characterDataStore.jsを使用する。ゲーム規則や個別テスト用データをここへ追加しない。
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { readCharacterDataCatalog } = require('../../../app/main/characterDataStore.js');
const rawCatalog = readCharacterDataCatalog(join(projectRoot, 'app', 'renderer', 'data', 'characters'));

globalThis.desktopWerewolf = Object.freeze({ loadCharacterCatalogSync: () => rawCatalog });
