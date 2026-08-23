/**
 * 責務: app/shared/userCharacterLibraryPolicy.jsのユーザーキャラクターライブラリ総サイズ契約をRenderer ES Moduleへ接続する。
 * 変更ルール: サイズ上限・検証文言を複製せず、JSON読込とMain保存境界が共有契約の同じ値を参照する。
 */

import * as sharedPolicyModule from '../../../../shared/userCharacterLibraryPolicy.js';

const policy = sharedPolicyModule.default ?? globalThis.AiWerewolfUserCharacterLibraryPolicy;
if (!policy) throw new Error('共有ユーザーキャラクターライブラリポリシーを読み込めませんでした。');

export const { USER_CHARACTER_LIBRARY_MAX_BYTES } = policy;
