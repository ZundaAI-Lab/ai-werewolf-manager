/**
 * 責務: デスクトップ自動化の単一ES Module入口として、AI再試行PolicyとdesktopAutomationの静的依存グラフをRenderer bundleへ到達させる。
 * 変更ルール: 処理本体やautomation内部モジュールの列挙を重複保持せず、desktopAutomation.jsのimportを依存関係の正本とする。HTMLへautomation製品JSを直接追加しない。
 */

import '../ai/apiRetryPolicy.js';
import '../ai/responseRetryPolicy.js';
import './desktopAutomation.js';
