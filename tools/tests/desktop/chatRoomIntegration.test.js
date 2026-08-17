/**
 * 責務: チャットルームのMain保存境界・終了時flush、IPC接続、AppUI/キャラクター管理接続、サイドメニュー配置、準備・参加者編集UI、AIプロファイル無効化、生成中revision競合、キャラクター個別内部メモ、自動会話停止契約が人狼ゲーム自動保存・進行責務から独立していることを検証する。
 * 変更ルール: チャットの会話順・参加者差し替え・外部カタログ整合ロジックはgame/chatRoom.test.jsへ委譲し、ここではデスクトップ統合と保存・終了待機・停止・UI配線だけを検証する。準備・参加者編集画面は参加者1人1行・名前1行固定、プロフィール本文非表示、AIプロファイル欄の過剰伸長禁止、チャット専用AIプロファイル一括適用を現行UI契約とする。会話画面はデスクトップ幅で外側スクロールを持たず、会話ログと参加者一覧だけを内部スクロールさせ、お題とプレイヤー入力を常時残す。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { ChatRoomStore, CHAT_ROOM_SCHEMA_VERSION } = require('../../../app/main/chatRoomStore.js');
const { AutosaveStore } = require('../../../app/main/autosaveStore.js');

const projectRoot = join(__dirname, '..', '..', '..');
const read = (relativePath) => readFileSync(join(projectRoot, relativePath), 'utf8');

function sampleChat(overrides = {}) {
  return {
    schemaVersion: CHAT_ROOM_SCHEMA_VERSION,
    id: 'chat-test',
    status: 'setup',
    participants: [],
    messages: [],
    ...overrides,
  };
}

test('チャット保存はゲーム自動保存と別ファイルを使用し現行製品schemaだけを受理する', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'aiwm-chat-store-'));
  try {
    const chatStore = new ChatRoomStore(userData);
    const autosaveStore = new AutosaveStore(userData);
    assert.notEqual(chatStore.path, autosaveStore.autosavePath);
    assert.match(chatStore.path, /chat-room-session\.json$/u);
    const saves = [
      chatStore.save(sampleChat({ topic: 'テスト1' })),
      chatStore.save(sampleChat({ topic: 'テスト2' })),
      chatStore.save(sampleChat({ topic: 'テスト3' })),
    ];
    await chatStore.flush();
    await Promise.all(saves);
    assert.equal(fs.existsSync(autosaveStore.autosavePath), false);
    assert.equal(chatStore.loadSync().topic, 'テスト3');
    assert.throws(() => chatStore.save(sampleChat({ schemaVersion: 0 })), /schemaVersion/u);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('Mainとpreloadはチャット読込・保存専用IPCを公開しゲーム自動保存IPCへ混在させない', () => {
  const preload = read('app/main/preload.js');
  const main = read('app/main/main.js');
  assert.match(preload, /loadChatRoomSync: \(\) => ipcRenderer\.sendSync\('desktop:load-chat-room-sync'\)/u);
  assert.match(preload, /saveChatRoom: \(state\) => ipcRenderer\.invoke\('desktop:save-chat-room', state\)/u);
  assert.match(main, /trustedIpc\.onSync\('desktop:load-chat-room-sync'[\s\S]*chatRoomStore\.loadSync\(\)/u);
  assert.match(main, /trustedIpc\.handle\('desktop:save-chat-room'[\s\S]*chatRoomStore\.save\(state\)/u);
  assert.match(main, /settleWithin\([\s\S]*chatRoomStore\.flush\(\)[\s\S]*CHAT_ROOM_FLUSH_TIMEOUT_MS[\s\S]*CHAT_ROOM_FLUSH_TIMEOUT/u);
  assert.match(main, /Promise\.all\(\[autosaveFlush, chatRoomFlush\]\)/u);
});

test('チャットルームは正式タブとしてAppUIへ接続しゲーム進行操作のdata-actionと分離する', () => {
  const html = read('app/renderer/index.html');
  const appUi = read('app/renderer/js/ui/AppUI.js');
  assert.match(html, /data-tab="chat-room"[^>]*>[^<]*<span>💬<\/span>チャットルーム<\/button>|data-tab="chat-room"[^>]*><span>💬<\/span>チャットルーム<\/button>/u);
  assert.match(appUi, /this\.activeTab === 'chat-room'[\s\S]*\[data-chat-field\]/u);
  assert.match(appUi, /const chatButton = event\.target\.closest\('\[data-chat-action\]'\)/u);
  assert.match(appUi, /this\.chatRoomController\.handleClick\(chatButton\)/u);
});


test('チャットルームはサイドメニュー下部で外観設定の直前に配置する', () => {
  const html = read('app/renderer/index.html');
  const mainNavEnd = html.indexOf('</nav>');
  const chatIndex = html.indexOf('data-tab="chat-room"');
  const appearanceIndex = html.indexOf('id="appearance-button"');
  const footerIndex = html.indexOf('class="sidebar-footer"');
  assert.ok(chatIndex > mainNavEnd, 'チャットルームを人狼系メインナビゲーションから分離する');
  assert.ok(chatIndex > footerIndex && chatIndex < appearanceIndex, 'チャットルームは補助メニュー内で外観設定の直前に置く');
});

test('チャット準備画面は上下2パネル・プレイヤー名・参加者1人1行・AIプロファイル一括適用を提供する', () => {
  const view = read('app/renderer/js/ui/views/chat/chatRoomView.js');
  const css = read('app/renderer/css/styles.css');
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  assert.match(view, /chat-room-settings-panel[\s\S]*chat-participant-picker/u);
  assert.match(css, /\.chat-setup-layout \{[^}]*grid-template-columns:\s*1fr/u);
  assert.match(view, /data-chat-field="player-name"/u);
  assert.match(view, /class="chat-character-row/u);
  assert.doesNotMatch(view, /class="chat-character-grid/u);
  assert.doesNotMatch(view, /chat-character-profile"><span>AIプロファイル<\/span>/u);
  assert.match(css, /\.chat-character-main strong \{[^}]*white-space:\s*nowrap/u);
  assert.match(css, /\.chat-character-row \{[^}]*grid-template-columns:\s*auto\s+minmax\(220px,\s*1fr\)\s+minmax\(280px,\s*380px\)/u);
  assert.match(css, /\.chat-character-profile \{[^}]*max-width:\s*380px/u);
  assert.doesNotMatch(view, /card\.character\?\.profile/u);
  assert.match(view, /data-chat-field="bulk-profile"/u);
  assert.match(view, /data-chat-action="bulk-assign-profile"/u);
  assert.match(controller, /targets\.forEach\(\(participant\) => \{ participant\.profileId = profileId; \}\)/u);
  assert.doesNotMatch(controller, /settings\.assignments/u);
});

test('会話中は履歴を維持したまま参加者編集へ入り適用・キャンセルできる', () => {
  const view = read('app/renderer/js/ui/views/chat/chatRoomView.js');
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  assert.match(view, /data-chat-action="edit-participants"/u);
  assert.match(view, /renderChatRoomParticipantEdit/u);
  assert.match(view, /現在の会話履歴・お題・プレイヤー名を維持したまま/u);
  assert.match(view, /data-chat-action="apply-participant-edit"/u);
  assert.match(view, /data-chat-action="cancel-participant-edit"/u);
  assert.match(controller, /participantDraft = structuredClone\(state\.participants\)/u);
  assert.match(controller, /replaceChatRoomParticipants\(state, participantDraft\)/u);
  assert.match(controller, /addSystemMessage\(state, `参加キャラクターを変更しました/u);
  assert.match(controller, /await persist\(\);[\s\S]*会話履歴を保持したまま参加キャラクターを更新しました/u);
});

test('チャット会話画面は人数が増えてもお題とプレイヤー入力を残し必要領域だけ内部スクロールさせる', () => {
  const css = read('app/renderer/css/styles.css');
  assert.match(css, /#app-content:has\(\.chat-room-live\) \{[^}]*overflow:\s*hidden/u);
  assert.match(css, /\.chat-room-live \{[^}]*height:\s*100%[^}]*overflow:\s*hidden/u);
  assert.match(css, /\.chat-log \{[^}]*overflow:\s*auto/u);
  assert.match(css, /\.chat-participant-list \{[^}]*overflow:\s*auto/u);
  assert.match(css, /\.chat-side-column \{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/u);
  assert.doesNotMatch(css, /\.chat-live-layout \{\s*height:\s*100%/u);
});

test('チャットControllerは人狼State・discussionRuntimeを所有せず専用DomainとPromptへ委譲する', () => {
  const source = read('app/renderer/js/ui/controllers/chatRoomController.js');
  assert.match(source, /domain\/chat\/chatRoomState\.js/u);
  assert.match(source, /prompts\/chat\/chatRoomPrompt\.js/u);
  assert.doesNotMatch(source, /from ['"][^'"]*(?:stateStore|gameRuntime|discussionRuntime)/u);
  assert.match(source, /bridge\?\.saveChatRoom\?\.\(state\)/u);
});



test('チャット開始時はお題なしの場合だけ固有/汎用の初回きっかけを選び通常会話では低頻度cueを使う', () => {
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  const prompt = read('app/renderer/js/prompts/chat/chatRoomPrompt.js');
  const cuePolicy = read('app/renderer/js/prompts/chat/chatRoomConversationCuePolicy.js');
  const view = read('app/renderer/js/ui/views/chat/chatRoomView.js');
  assert.match(controller, /provisional\.opening\.seed = provisional\.topic \? null : selectOpeningConversationCue/u);
  assert.match(controller, /selectOptionalConversationCue\(\{ state, speakerCard, turnKind: turn\.kind \}\)/u);
  assert.match(prompt, /!answerTurn[\s\S]*state\.opening\.seed/u);
  assert.match(cuePolicy, /SYSTEM_CONVERSATION_CUES = Object\.freeze\(\[/u);
  assert.match(cuePolicy, /NORMAL_CHARACTER_WEIGHT = 10/u);
  assert.match(cuePolicy, /NORMAL_SYSTEM_WEIGHT = 5/u);
  assert.match(view, /開始できます。お題なしで自由に会話します。/u);
});

test('自動会話は設定発言数で停止し明示停止後は実行中要求をキャンセルする', () => {
  const source = read('app/renderer/js/ui/controllers/chatRoomController.js');
  assert.match(source, /for \(let completed = 0; completed < state\.autoBatchSize && autoRunning && token === autoRunToken;\)/u);
  assert.match(source, /const generated = await generateNext\(\);[\s\S]*if \(generated\) completed \+= 1/u);
  assert.match(source, /autoRunning = false;[\s\S]*autoRunToken \+= 1/u);
  assert.match(source, /bridge\?\.cancelRequest\?\.\(requestId\)/u);
  assert.match(source, /if \(!autoRunning && currentRequestId === null\) throw new Error\('AI生成を停止しました。'\)/u);
});

test('チャットと接続診断のAPI利用は共通usage更新イベントで料金画面へ反映する', () => {
  const chatController = read('app/renderer/js/ui/controllers/chatRoomController.js');
  const profileEditor = read('app/renderer/js/automation/profileEditorController.js');
  const desktopAutomation = read('app/renderer/js/automation/desktopAutomation.js');
  assert.match(chatController, /dispatchEvent\(new CustomEvent\('ai-werewolf-usage-updated'\)\)/u);
  assert.match(profileEditor, /dispatchEvent\(new CustomEvent\('ai-werewolf-usage-updated'\)\)/u);
  assert.match(desktopAutomation, /addEventListener\('ai-werewolf-usage-updated',[\s\S]*refreshUsageSummary/u);
});

test('チャット内部メモはAI応答の完成版を発言者だけへ保存し次回Promptへ再投入する', () => {
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  const prompt = read('app/renderer/js/prompts/chat/chatRoomPrompt.js');
  const state = read('app/renderer/js/domain/chat/chatRoomState.js');
  const memory = read('app/renderer/js/domain/chat/chatRoomMemory.js');
  assert.match(controller, /setCharacterMemory\(state, speakerId, result\.memory\)/u);
  assert.match(controller, /fallbackMemory: getCharacterMemory\(state, speakerId\)/u);
  assert.match(prompt, /# あなたの内部メモ/u);
  assert.match(prompt, /required: \['chatMessage', 'memory', 'interaction'\]/u);
  assert.match(prompt, /完成版/u);
  assert.match(state, /characterMemories:\s*\{\}/u);
  assert.match(memory, /CHAT_MEMORY_MAX_ENTRIES/u);
  assert.doesNotMatch(controller, /sharedMemory|globalMemory/u);
});



test('AIプロファイル無効化は参加者割当を別プロファイルへ暗黙置換せずUIでも利用不可として扱う', () => {
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  const view = read('app/renderer/js/ui/views/chat/chatRoomView.js');
  const start = controller.indexOf('function setAiProfiles(nextProfiles)');
  const end = controller.indexOf('\n  function characterCards()', start);
  assert.ok(start >= 0 && end > start);
  const block = controller.slice(start, end);
  assert.doesNotMatch(block, /participant\.profileId\s*=/u);
  assert.match(view, /function invalidProfileCount\(participants, profiles\)/u);
  assert.match(view, /AIプロファイル未設定または利用不可/u);
});

test('AI生成はターンを先に消費せずrevision一致確認後だけ通常/回答ターンを登録する', () => {
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  const start = controller.indexOf('async function generateNext()');
  const end = controller.indexOf('\n  async function startAuto()', start);
  const block = controller.slice(start, end);
  const ensureIndex = block.indexOf('const turn = ensureNextTurn(state)');
  const revisionIndex = block.indexOf('const requestRevision = state.revision');
  const requestIndex = block.indexOf('await requestAiCandidate');
  const staleIndex = block.indexOf('state.revision !== requestRevision');
  const consumeIndex = block.indexOf('const consumedTurn = consumeNextTurn(state)');
  assert.ok(ensureIndex >= 0 && revisionIndex > ensureIndex && requestIndex > revisionIndex);
  assert.ok(staleIndex > requestIndex && consumeIndex > staleIndex);
  assert.match(block, /requiredAnswerMessageId = turn\.kind === 'answer' \? turn\.questionMessageId : ''/u);
  assert.match(block, /consumeOpening: turn\.kind !== 'answer'/u);
  assert.doesNotMatch(block, /forceNextSpeaker\(state, speakerId\)/u);
});

test('チャットUIはAI質問を質問ごとの専用回答として説明しプレイヤー指名も回答ターン化する', () => {
  const view = read('app/renderer/js/ui/views/chat/chatRoomView.js');
  assert.match(view, /AI同士の明示的な質問は質問1件ごとに回答ターンを追加/u);
  assert.match(view, /通常巡回の発言枠は残します/u);
  assert.match(view, /プレイヤーの特定キャラ指定はこの設定に関係なく回答ターンを追加/u);
  assert.match(view, /次：\$\{escapeHtml\(nextCard\?\.name \?\? '未定'\)\} · \$\{escapeHtml\(nextTurnLabel\)\}/u);
});

test('チャット保存失敗はController内で握り潰さず成功通知前に呼び出し元へ伝播する', () => {
  const controller = read('app/renderer/js/ui/controllers/chatRoomController.js');
  const start = controller.indexOf('async function persist()');
  const end = controller.indexOf('\n  function readControl', start);
  const block = controller.slice(start, end);
  assert.match(block, /await bridge\?\.saveChatRoom\?\.\(state\)/u);
  assert.doesNotMatch(block, /catch\s*\(/u);
  assert.match(controller, /await persist\(\);[\s\S]*会話履歴を保持したまま参加キャラクターを更新しました/u);
});

test('キャラクター管理のカタログ変更はAppUI経由でチャットルーム整合処理へ通知する', () => {
  const appUi = read('app/renderer/js/ui/AppUI.js');
  const characterController = read('app/renderer/js/ui/controllers/characterLibraryController.js');
  const chatController = read('app/renderer/js/ui/controllers/chatRoomController.js');
  assert.match(appUi, /onCatalogChanged: \(\) => this\.chatRoomController\?\.reconcileCharacters\(\)/u);
  assert.match(characterController, /await onCatalogChanged\(\)/u);
  assert.match(characterController, /setCharacterEnabled\([\s\S]*await notifyCatalogChanged\(\)/u);
  assert.match(characterController, /setCharacterGroupEnabled\([\s\S]*await notifyCatalogChanged\(\)/u);
  assert.match(chatController, /reconcileChatRoomCharacters\(state, availableCharacterIds\(\)\)/u);
});
