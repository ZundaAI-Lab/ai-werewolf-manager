/**
 * 責務: 処刑直前の遺言コマンドを公開する。
 * 変更ルール: 処刑解決・死亡公開はvoteRuntimeの責務として保持する。
 */
export { recordHumanTestament, recordAiTestament, skipTestament } from './testamentRuntime.js';
