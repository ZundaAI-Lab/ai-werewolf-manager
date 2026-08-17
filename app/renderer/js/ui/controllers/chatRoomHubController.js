/**
 * 責務: サイドメニューの「チャットルーム」画面内で、既存の自由会話Controllerと独立した人狼観戦Controllerを切り替え、描画・DOMイベント・AI設定同期・キャラクター整合を各Controllerへ委譲する。
 * 変更ルール: 自由チャットState・観戦State・Game Stateの意味解釈やAI通信を持たない。モード切替だけを所有し、各機能の状態を相互変換・共有しない。
 */

import { createChatRoomController } from './chatRoomController.js';
import { createSpectatorRoomController } from './spectatorRoomController.js';

function modeSwitch(mode) {
  return `<div class="chat-room-mode-switch" role="tablist" aria-label="チャットルームモード"><button class="chat-room-mode-button${mode === 'free' ? ' active' : ''}" data-chat-room-mode="free" type="button" role="tab" aria-selected="${mode === 'free'}">自由会話</button><button class="chat-room-mode-button${mode === 'spectator' ? ' active' : ''}" data-chat-room-mode="spectator" type="button" role="tab" aria-selected="${mode === 'spectator'}">人狼観戦</button></div>`;
}

export function createChatRoomHubController({ ui, gameStore }) {
  let mode = 'free';
  const freeChat = createChatRoomController({ ui });
  const spectator = createSpectatorRoomController({ ui, gameStore, isVisible: () => mode === 'spectator' && ui.getActiveTab?.() === 'chat-room' });

  function activeController() {
    return mode === 'spectator' ? spectator : freeChat;
  }

  return Object.freeze({
    render() {
      return `${modeSwitch(mode)}${activeController().render()}`;
    },
    afterRender() {
      activeController().afterRender?.();
    },
    handleChange(event) {
      return activeController().handleChange(event);
    },
    handleClick(button) {
      const nextMode = String(button?.dataset?.chatRoomMode ?? '');
      if (['free', 'spectator'].includes(nextMode)) {
        mode = nextMode;
        ui.render();
        return true;
      }
      return activeController().handleClick(button);
    },
    setAiProfiles(profiles) {
      freeChat.setAiProfiles(profiles);
      spectator.setAiProfiles(profiles);
    },
    reconcileCharacters() {
      return Promise.all([freeChat.reconcileCharacters(), spectator.reconcileCharacters()]);
    },
    handleGameStateChange() {
      spectator.handleGameStateChange();
    },
    stopAuto() {
      return Promise.all([freeChat.stopAuto(), spectator.stopAll()]);
    },
  });
}
