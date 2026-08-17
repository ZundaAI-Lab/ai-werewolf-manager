/**
 * 責務: アプリ起動口のグローバルUI操作と主要UI Controller境界が、現行の画面責務どおり接続されていることを検証する。
 * 変更ルール: bootstrap全体の実装詳細を固定せず、新規ゲーム確認dialog、人間操作のインライン登録境界、主要Controllerの依存方向だけを検査する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..', '..', '..');
const bootstrapSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'app', 'bootstrap.js'), 'utf8');
const indexHtml = readFileSync(join(projectRoot, 'app', 'renderer', 'index.html'), 'utf8');
const appUiSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'AppUI.js'), 'utf8');
const setupActionControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'setupActionController.js'), 'utf8');
const notificationControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'notificationController.js'), 'utf8');
const setupViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'setup', 'setupView.js'), 'utf8');
const mainSource = readFileSync(join(projectRoot, 'app', 'main', 'main.js'), 'utf8');
const publicWindowControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'publicWindowController.js'), 'utf8');
const publicHtmlExportSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'public', 'publicHtmlExport.js'), 'utf8');
const correctionControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'correctionController.js'), 'utf8');
const workbenchActionControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'workbenchActionController.js'), 'utf8');
const aiTaskCommitControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'aiTaskCommitController.js'), 'utf8');
const handoffControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'handoffController.js'), 'utf8');
const humanPlayerActionControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'humanPlayerActionController.js'), 'utf8');
const humanTaskViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'human', 'humanTaskView.js'), 'utf8');
const setupPlayerRowViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'setup', 'setupPlayerRowView.js'), 'utf8');
const aiResponseBoxViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'workbench', 'aiResponseBoxView.js'), 'utf8');
const rendererStyles = readFileSync(join(projectRoot, 'app', 'renderer', 'css', 'styles.css'), 'utf8');
const publicViewStyles = readFileSync(join(projectRoot, 'app', 'renderer', 'css', 'publicView.css'), 'utf8');
const sharedUtilsSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'shared', 'utils.js'), 'utf8');
const relationshipViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'records', 'playerRelationshipView.js'), 'utf8');
const relationshipDialogControllerSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'controllers', 'relationshipDialogController.js'), 'utf8');
const roleHelpViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'help', 'roleHelpView.js'), 'utf8');
const licenseViewSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'ui', 'views', 'license', 'licenseView.js'), 'utf8');
const constantsSource = readFileSync(join(projectRoot, 'app', 'renderer', 'js', 'config', 'constants.js'), 'utf8');


test('製品画面の名称はAI人狼マネージャーへ統一する', () => {
  assert.match(indexHtml, /<title>AI人狼マネージャー<\/title>/u);
  assert.match(indexHtml, /<h1>AI人狼マネージャー<\/h1>/u);
  assert.match(mainSource, /title: 'AI人狼マネージャー'/u);
  assert.match(licenseViewSource, /<span>AI人狼マネージャー<\/span>/u);
  assert.match(bootstrapSource, /console\.info\(`AI人狼マネージャー v\$\{APP_VERSION\}/u);
  const productTitleSources = [indexHtml, mainSource, licenseViewSource, bootstrapSource].join('\n');
  assert.doesNotMatch(productTitleSources, /AI人狼コントロールルーム/u);
});

test('ライセンス画面は本体MIT Licenseを権利情報へ統合しキャラクター管理元を十分な視認性で表示する', () => {
  assert.doesNotMatch(licenseViewSource, /<h3[^>]*>AI人狼マネージャー本体<\/h3>/u);
  assert.match(licenseViewSource, /<h3 id="license-rights-title">権利について<\/h3>/u);
  assert.match(licenseViewSource, /AI人狼マネージャー — MIT License/u);
  assert.match(licenseViewSource, /事前許可なく利用・複製・改変・結合・公開・再配布・再許諾・販売/u);
  assert.match(licenseViewSource, /第三者が権利を持つキャラクター/u);
  assert.match(licenseViewSource, /license-source-holder/u);
  assert.match(licenseViewSource, /管理・権利情報/u);
  assert.match(rendererStyles, /\.license-source-holder strong \{[^}]*font-size:\s*15px;[^}]*font-weight:\s*800;/u);
  assert.match(licenseViewSource, /group\.source\?\.officialUrl/u);
  assert.match(licenseViewSource, />公式サイト<\/a>/u);
  assert.match(licenseViewSource, />利用規約<\/a>/u);
  assert.match(licenseViewSource, /確認日:/u);
  assert.match(licenseViewSource, /safeHttpsUrl/u);
});

test('新規ゲーム確認は同期confirmではなく専用dialogを使用する', () => {
  assert.doesNotMatch(bootstrapSource, /window\.confirm\([^)]*現在のゲームを破棄/gu);
  assert.match(indexHtml, /<dialog id="new-game-dialog" class="modal" aria-labelledby="new-game-dialog-title">/u);
  assert.match(indexHtml, /<form method="dialog">/u);
  assert.match(indexHtml, /value="cancel" type="submit">キャンセル/u);
  assert.match(indexHtml, /value="restart-current-setup" type="submit" autofocus>設定を引き継いで最初から/u);
  assert.match(indexHtml, /value="confirm" type="submit">すべて初期化/u);
  assert.match(indexHtml, /AIプロファイル割り当てを維持/u);
  assert.match(correctionControllerSource, /function _openCorrectionRestoreDialog[\s\S]*訂正・復元理由[\s\S]*_restorePoint\(pointId, reason\)/u, '訂正モードを先に開始せず理由入力から復元できる');
  assert.match(correctionControllerSource, /function _correctPublicEvent\(\)[\s\S]*correctPublicEventWithMode\(state/u, '公開済み内容の訂正も一操作で訂正モードへ入る');
  assert.match(appUiSource, /_openNewGameDialog\(\)[\s\S]*dialog\.showModal\(\)/u);
});


test('新規ゲーム確定は状態初期化後に正式タブAPIでゲーム準備へ遷移する', () => {
  const closeHandler = bootstrapSource.match(/newGameDialog\.addEventListener\('close',[\s\S]*?\n  \}\);/u)?.[0] ?? '';
  assert.match(closeHandler, /if \(action === 'restart-current-setup'\) store\.restartWithCurrentSetup\(\);[\s\S]*else store\.reset\(8\);/u);
  assert.match(closeHandler, /ui\.setTab\('setup'\)/u);
  const restartIndex = closeHandler.indexOf('store.restartWithCurrentSetup()');
  const resetIndex = closeHandler.indexOf('store.reset(8)');
  const setupIndex = closeHandler.indexOf("ui.setTab('setup')");
  assert.ok(setupIndex > restartIndex && setupIndex > resetIndex, '初期化完了後にゲーム準備へ遷移する');
});



test('ゲーム準備の入力変更は状態保存を維持しつつ全画面再描画を局所同期へ置き換える', () => {
  assert.match(bootstrapSource, /store\.subscribe\(\(\) => \{[\s\S]*const changeDetail = ui\.handleStoreStateChange\(\);[\s\S]*ai-werewolf-state-changed[\s\S]*detail: changeDetail/u);
  assert.match(appUiSource, /_commitSetupMutation\(label, mutator, options = \{\}\)[\s\S]*suppressStoreRenderDuringSetupCommit = true[\s\S]*scope: 'setup-input'[\s\S]*this\.store\.commit\(label, mutator, commitOptions\)[\s\S]*this\._refreshSetupView\(refresh\)/u);
  assert.match(appUiSource, /setup\?\.dataset\.setup === 'title'\) this\._commitSetupMutation/u);
  assert.match(appUiSource, /isAutomationMutationLocked\(\)[\s\S]*_restoreSetupInputValue\(event\.target\)[\s\S]*return;/u);
  assert.match(setupActionControllerSource, /field === 'roleId'[\s\S]*roleSummary: true, rules: true, validation: true/u);
  assert.match(setupActionControllerSource, /decorateSetup: field === 'controller'/u);
  assert.match(appUiSource, /setupActionController\._changePlayerField\(playerField\.dataset\.playerId, field, playerField\.value\)/u);
  assert.match(setupActionControllerSource, /_assignCharacterCard[\s\S]*characterCards: true[\s\S]*commitSetupMutation\('キャラクターカード適用'/u);
  assert.match(setupActionControllerSource, /_changeRule[\s\S]*rules: true, validation: true[\s\S]*commitSetupMutation\('ルール変更'/u);
  assert.match(setupViewSource, /export function refreshSetupViewDom[\s\S]*data-setup-validation[\s\S]*renderSetupValidation/u);
});

test('AppUIは準備・訂正・手動勝敗のドメイン更新を各Controllerへ委譲する', () => {
  assert.doesNotMatch(appUiSource, /domain\/(?:game\/gameCommands|briefing\/briefingCommands|correction\/correctionCommands|setup\/playerDetailCommands|setup\/setupRoles)\.js/u);
  assert.match(appUiSource, /setupActionController\._commitPlayerDetailUpdate/u);
  assert.match(appUiSource, /setupActionController\._markBriefingShown/u);
  assert.match(appUiSource, /correctionController\._correctRoleAssignment/u);
  assert.match(appUiSource, /workbenchActionController\._manualFinish/u);
});

test('準備操作ControllerはAppUI全体ではなく局所更新を含む必要依存だけを受け取る', () => {
  assert.match(setupActionControllerSource, /createSetupActionController\(\{ store, toast, render, commitSetupMutation, refreshSetupView \}\)/u);
  assert.match(setupActionControllerSource, /\/\/ @ts-check/u);
  assert.doesNotMatch(setupActionControllerSource, /\{ ui \}|\.apply\(ui|this\./u);
  assert.match(appUiSource, /createSetupActionController\(\{[\s\S]*store: this\.store,[\s\S]*toast: \(message, type, options\) => this\.toast\(message, type, options\),[\s\S]*commitSetupMutation: \(label, mutator, options\) => this\._commitSetupMutation\(label, mutator, options\),[\s\S]*refreshSetupView: \(refresh\) => this\._refreshSetupView\(refresh\)/u);
});

test('残りの操作ControllerもAppUI全体依存を持たず明示依存と型検査へ移行する', () => {
  for (const source of [workbenchActionControllerSource, aiTaskCommitControllerSource, correctionControllerSource, handoffControllerSource]) {
    assert.match(source, /\/\/ @ts-check/u);
    assert.doesNotMatch(source, /\{ ui \}|\.apply\(ui|\bthis\./u);
  }
  assert.doesNotMatch(humanPlayerActionControllerSource, /\{ ui \}|\.apply\(ui|\bthis\./u);
  assert.match(appUiSource, /createWorkbenchActionController\(\{[\s\S]*store: this\.store,[\s\S]*controlValue: \(key, fallback\) => this\._controlValue\(key, fallback\),[\s\S]*runEngine: \(label, command, options\) => this\.setupActionController\._runEngine/u);
  assert.match(appUiSource, /createAiTaskCommitController\(\{[\s\S]*promptCache: this\.promptCache,[\s\S]*freshPromptState: \(state, playerId, taskType, slotId\) => this\._freshPromptState[\s\S]*clearSpeechMetadata: \(playerId\) => this\.workbenchActionController\._clearSpeechMetadata/u);
  assert.match(appUiSource, /createCorrectionController\(\{[\s\S]*modal: this\.modal,[\s\S]*isAutomationMutationLocked: \(\) => this\.isAutomationMutationLocked\(\)/u);
  assert.match(appUiSource, /createHumanPlayerActionController\(\{[\s\S]*store: this\.store,[\s\S]*modal: this\.modal,[\s\S]*runEngine: \(label, command, options\) => this\.setupActionController\._runEngine/u);
  assert.match(handoffControllerSource, /export \{ createHumanPlayerActionController \}/u);
  assert.doesNotMatch(appUiSource, /\bthis\.handoff\b|createHandoffController/u);
});

test('人間操作は進行卓内カードへ統一し役職通知だけ共通ダイアログを使用する', () => {
  assert.match(humanTaskViewSource, /export function renderHumanTaskCard/u);
  assert.match(humanTaskViewSource, /data-human-task-card/u);
  assert.match(humanTaskViewSource, /data-action="open-human-role-notice"/u);
  assert.match(humanTaskViewSource, /export function renderHumanRoleNoticeDialog/u);
  assert.match(humanPlayerActionControllerSource, /ai-werewolf-human-task-completed/u);
  assert.match(humanPlayerActionControllerSource, /modal\.innerHTML = renderHumanRoleNoticeDialog/u);
  assert.doesNotMatch([appUiSource, humanTaskViewSource, humanPlayerActionControllerSource, rendererStyles].join('\n'), /端末を渡してください|端末を返してください|handoff-active|handoff-screen/u);
});

test('長大HTMLは準備参加者行とAI応答ボックスを専用Viewへ分離する', () => {
  assert.match(setupViewSource, /renderSetupPlayerRow\(\{ players: state\.players, player, index, locked \}\)/u);
  assert.match(setupPlayerRowViewSource, /export function renderSetupPlayerRow/u);
  assert.match(setupPlayerRowViewSource, /data-player-field="name"[\s\S]*data-player-field="controller"[\s\S]*data-player-field="roleId"/u);
  assert.match(appUiSource, /return renderAiResponseBox\(\{[\s\S]*parsed,[\s\S]*parseErrors,[\s\S]*manualNotice/u);
  assert.match(aiResponseBoxViewSource, /export function renderAiResponseBox/u);
  assert.match(aiResponseBoxViewSource, /function renderParsedPreview/u);
  assert.doesNotMatch(appUiSource, /class="parse-preview/gu);
});

test('通知Controllerは通知内部状態をAppUIへ持たせずstoreと表示領域だけへ依存する', () => {
  assert.match(notificationControllerSource, /createNotificationController\(\{ store, toastRegion \}\)/u);
  assert.match(notificationControllerSource, /\/\/ @ts-check/u);
  assert.doesNotMatch(notificationControllerSource, /\{ ui \}|\.apply\(ui|this\./u);
  assert.match(notificationControllerSource, /const notificationHistory = \[\];[\s\S]*let activeToast = null;[\s\S]*let activeToastTimer = null;[\s\S]*let automaticNotificationDepth = 0;[\s\S]*let nightActorPrivacyDepth = 0;[\s\S]*let notificationSequence = 0;/u);
  assert.match(notificationControllerSource, /function hasActiveErrorToast\(\)[\s\S]*activeToast\?\.type === 'error'/u);
  assert.doesNotMatch(appUiSource, /this\.(?:notificationHistory|activeToast|activeToastTimer|automaticNotificationDepth|nightActorPrivacyDepth|notificationSequence)\s*=/u);
  assert.match(appUiSource, /createNotificationController\(\{[\s\S]*store: this\.store,[\s\S]*toastRegion/u);
  assert.match(appUiSource, /pressedButton && this\.notificationController\.hasActiveErrorToast\(\)/u);
});

test('Main画面の遷移防止はモジュール変数ではなくイベント送信元のURLを基準にする', () => {
  const navigationGuard = mainSource.match(/mainWindow\.webContents\.on\('will-navigate',[\s\S]*?^  \}\);/mu)?.[0] ?? '';
  assert.match(navigationGuard, /event\.sender\.getURL\(\)/u);
  assert.doesNotMatch(navigationGuard, /mainWindow\.webContents\.getURL\(\)/u);
});

test('公開表示ウィンドウはpreload権限を持たずCSPで表示用途へ限定する', () => {
  const publicWindowPolicy = mainSource.match(/if \(url === 'about:blank'\) \{[\s\S]*?^    \}/mu)?.[0] ?? '';
  assert.match(publicWindowPolicy, /preload: undefined/u);
  assert.match(publicWindowPolicy, /nodeIntegration: false/u);
  assert.match(publicWindowPolicy, /contextIsolation: true/u);
  assert.match(publicWindowPolicy, /sandbox: true/u);
  assert.match(publicWindowControllerSource, /Content-Security-Policy[\s\S]*script-src 'none'[\s\S]*object-src 'none'/u);
  assert.match(publicWindowControllerSource, /publicWindow\.opener = null/u);
});


test('公開表示ウィンドウは通常画面の固定overflowを解除して全文を縦スクロールできる', () => {
  assert.match(publicWindowControllerSource, /<html lang="ja" class="standalone-public-document">/u);
  assert.match(rendererStyles, /@import url\("\.\/publicView\.css"\)/u);
  assert.doesNotMatch(rendererStyles, /html\.standalone-public-document\s*\{/u);
  assert.match(publicViewStyles, /html\.standalone-public-document\s*\{[\s\S]*overflow-y:\s*auto/u);
  assert.match(publicViewStyles, /body\.standalone-public\s*\{[\s\S]*height:\s*auto[\s\S]*overflow-y:\s*visible/u);
});

test('公開HTML出力は現在の機密表示状態だけを固定し出力後の切替データを持たない', () => {
  assert.match(publicWindowControllerSource, /const includeConfidential = Boolean\(getConfidential\(\)\);[\s\S]*snapshot: buildPublicSnapshot\(state, \{ includeConfidential \}\)/u);
  assert.doesNotMatch(publicWindowControllerSource, /publicSnapshot:\s*buildPublicSnapshot|confidentialSnapshot:\s*buildPublicSnapshot/u);
  assert.match(publicHtmlExportSource, /buildStandalonePublicHtml\(\{[\s\S]*snapshot,[\s\S]*renderPublicSnapshot\(snapshot\)/u);
  assert.doesNotMatch(publicHtmlExportSource, /confidentialSnapshot|showConfidential|confidential-toggle|<script/u);
});


test('公開ウィンドウControllerはAppUI全体ではなく必要な依存だけを受け取る', () => {
  assert.match(publicWindowControllerSource, /createPublicWindowController\(\{ store, getConfidential, toast \}\)/u);
  assert.doesNotMatch(publicWindowControllerSource, /\{ ui \}|\.apply\(ui|this\.store|this\.showConfidential|this\.toast|this\.publicWindow/u);
  assert.match(appUiSource, /createPublicWindowController\(\{[\s\S]*store: this\.store,[\s\S]*getConfidential: \(\) => this\.showConfidential,[\s\S]*toast: \(message, type, options\) => this\.toast\(message, type, options\)/u);
  assert.doesNotMatch(appUiSource, /this\.publicWindow = null/u);
});

test('Renderer CSPはインラインスタイルを許可せずコピーfallbackもCSSクラスを使用する', () => {
  const csp = indexHtml.match(/Content-Security-Policy" content="([^"]+)"/u)?.[1] ?? '';
  assert.match(csp, /style-src 'self';/u);
  assert.match(csp, /style-src-attr 'none'/u);
  assert.doesNotMatch(csp, /unsafe-inline/u);
  assert.match(sharedUtilsSource, /textarea\.className = 'clipboard-copy-fallback'/u);
  assert.doesNotMatch(sharedUtilsSource, /textarea\.style\./u);
  assert.match(rendererStyles, /\.clipboard-copy-fallback\s*\{[^}]*position:\s*fixed;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/u);
});



test('プレイヤー相関図の公開能力結果は配役に存在する役職だけを役職別レイヤーとして独立切替する', () => {
  assert.match(appUiSource, /\.filter\(\(role\) => role\.publicAbilityClaim\)[\s\S]*\.map\(\(role\) => `ability:\$\{role\.id\}`\)/u);
  assert.match(relationshipViewSource, /configuredPublicAbilityRoleIds\(state\)\.map\(\(roleId\) => \(\{[\s\S]*layerKey: abilityLayerKey\(roleId\)[\s\S]*label: `\$\{getRoleName\(roleId\)\}結果`/u);
  assert.match(relationshipViewSource, /const configuredRoleIds = new Set\(\(state\?\.players \?\? \[\]\)\.map\(\(player\) => player\.roleId\)\);[\s\S]*PUBLIC_ABILITY_ROLE_IDS\.filter\(\(roleId\) => configuredRoleIds\.has\(roleId\)\)/u);
  assert.match(relationshipViewSource, /edge\.type === 'ability' \? abilityLayerKey\(edge\.abilityRoleId\) : edge\.type/u);
  assert.match(relationshipDialogControllerSource, /if \(!value\.startsWith\('ability:'\)\) return false;[\s\S]*ROLE_DEFINITIONS\[roleId\]\?\.publicAbilityClaim/u);
  assert.doesNotMatch(appUiSource, /new Set\(\['suspicion', 'ability'\]\)/u);
  assert.doesNotMatch(relationshipViewSource, /公開能力結果（占・霊）/u);
assert.match(relationshipViewSource, /function edgeLabelOffset\(edgeType, bend\) \{[\s\S]*edgeType === 'ability'[\s\S]*edgeType === 'vote'[\s\S]*Math\.sign\(bend\)/u);
assert.match(relationshipViewSource, /const curveMidpoint = \{[\s\S]*const labelOffset = edgeLabelOffset\(edge\.type, bend\);[\s\S]*curveMidpoint\.x \+ \(perpendicular\.x \* labelOffset\)[\s\S]*curveMidpoint\.y \+ \(perpendicular\.y \* labelOffset\)/u);
assert.match(relationshipViewSource, /const bend = reverseExists\s*\? 42\s*:\s*\(\(relationTypeIndex\(edge\.type\) - 1\) \* 15\)/u);
assert.doesNotMatch(relationshipViewSource, /lexicalDirection|42 \* lexicalDirection/u);
});


test('役職ヘルプは通知用descriptionと分離した統一3項目を全役職へ表示する', () => {
  const roleDefinitionBlock = constantsSource.match(/export const ROLE_DEFINITIONS = Object\.freeze\(\{[\s\S]*?\n\}\);\n\nexport const ROLE_IDS/u)?.[0] ?? '';
  const roleIds = [...roleDefinitionBlock.matchAll(/^  ([A-Za-z][A-Za-z0-9]*): Object\.freeze\(\{/gmu)].map((match) => match[1]);
  const helpDefinitions = [...roleDefinitionBlock.matchAll(/help: roleHelp\([\s\S]*?\n    \),/gu)];
  assert.equal(roleIds.length, 13);
  assert.equal(helpDefinitions.length, roleIds.length, '全役職がhelpを持つ');
  assert.match(constantsSource, /descriptionは役職通知用の短文、helpは人間向け役職ヘルプ用の統一説明/u);
  assert.doesNotMatch(constantsSource, /成否は通知され(?:ない|ません)/u);
  assert.match(roleHelpViewSource, /\['概要', help\.overview[\s\S]*\['能力', help\.ability[\s\S]*\['特徴・制約', help\.details/u);
  assert.match(roleHelpViewSource, /class="role-help-card-details"[\s\S]*role-help-detail-row/u);
  assert.doesNotMatch(roleHelpViewSource, /<p>\$\{escapeHtml\(role\.description/u);
  assert.match(rendererStyles, /\.role-help-detail-row\s*\{[\s\S]*grid-template-columns:\s*82px minmax\(0, 1fr\)/u);
});
