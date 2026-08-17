/**
 * 責務: ゲーム準備画面から実行する開始・配役・人数・ルール・プレイヤー詳細更新と、準備から役職通知へ続く初期提示記録を所有する。
 * 変更ルール: ゲーム規則を独自実装せず、gameRulePolicy.jsの正式な値変換・検証を使用する。入力項目の変更では準備画面専用commit窓口を使い、状態保存のたびに全画面再描画しない。AppUI全体へ依存せず、store・通知・描画・準備画面局所同期だけを明示依存として受け取る。
 */

// @ts-check

import { moveSetupPlayer, shuffleSetupPlayers } from '../../domain/setup/playerOrder.js';
import { applySetupRoles, assignSetupPlayerRole } from '../../domain/setup/setupRoles.js';
import { getPresetRolesForPlayerCount } from '../../domain/setup/playerCountPolicy.js';
import { assignCharacterCard, randomizeCharacterCards, shuffleCurrentRoles } from '../../characters/setupRandomizer.js';
import { shuffle } from '../../shared/utils.js';
import { createPlayer } from '../../state/stateStore.js';
import { applyGameRuleChange } from '../../domain/game/gameRulePolicy.js';
import { markBriefingShown } from '../../domain/briefing/briefingCommands.js';
import { applyPlayerDetailUpdate, preparePlayerDetailUpdate } from '../../domain/setup/playerDetailCommands.js';

export function createSetupActionController({ store, toast, render, commitSetupMutation, refreshSetupView }) {
  if (!store || typeof store.getState !== 'function' || typeof store.commit !== 'function') throw new TypeError('状態Storeがありません。');
  if (typeof toast !== 'function') throw new TypeError('通知関数がありません。');
  if (typeof render !== 'function') throw new TypeError('描画関数がありません。');
  if (typeof commitSetupMutation !== 'function') throw new TypeError('準備画面commit関数がありません。');
  if (typeof refreshSetupView !== 'function') throw new TypeError('準備画面同期関数がありません。');

  function _runEngine(label, command, options = {}) {
    const { notification = {}, ...commitOptions } = options;
    /** @type {any} */
    let response;
    try {
      store.commit(label, (draft) => {
        response = command(draft);
        if (!response.ok) throw new Error(response.message);
      }, commitOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error', { key: notification.errorKey ?? '', forceDisplay: true, source: label });
      return { ok: false, message };
    }
    if (response?.message) {
      if (notification.roleBriefingSummary) {
        const complete = response.message.startsWith('全員の役職通知が完了');
        const message = complete
          ? `役職通知が完了しました（${store.getState().players.length}名）`
          : response.message;
        toast(message, 'success', {
          key: notification.key ?? 'role-briefing',
          forceDisplay: complete,
          silent: !complete,
          source: label,
        });
      } else {
        toast(response.message, 'success', {
          ...notification,
          silent: Boolean(notification.silentSuccess),
          source: notification.source ?? label,
        });
      }
    }
    return response;
  }

  function _assignCharacterCard(playerId, characterCardId) {
    /** @type {any} */
    let response;
    const refresh = { participants: true, characterCards: true, validation: true };
    try {
      commitSetupMutation('キャラクターカード適用', (state) => {
        response = assignCharacterCard(state.players, playerId, characterCardId);
        if (!response.ok) throw new Error(response.message);
      }, { refresh });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error');
      refreshSetupView(refresh);
      return;
    }
    toast(response.message, 'success');
  }

  function _randomizeCharacters() {
    /** @type {any} */
    let response;
    try {
      store.commit('キャラクターランダム配置', (state) => {
        response = randomizeCharacterCards(state.players);
        if (!response.ok) throw new Error(response.message);
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    toast(response.message, 'success');
  }

  function _shuffleRoles() {
    /** @type {any} */
    let response;
    try {
      store.commit('役職ランダム配置', (state) => {
        response = shuffleCurrentRoles(state.players);
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    toast(response.message, 'success');
  }

  function _movePlayerOrder(playerId, direction) {
    const state = store.getState();
    if (state.game.phase !== 'setup') return toast('ゲーム開始後は参加者の並び順を変更できません。', 'error');

    /** @type {any} */
    let response;
    try {
      store.commit('参加者並び順変更', (draft) => {
        response = moveSetupPlayer(draft.players, playerId, direction);
        if (!response.ok) throw new Error(response.message);
        draft.game.callNameSnapshot = null;
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    toast(response.message, 'success');
  }

  function _shufflePlayerOrder() {
    const state = store.getState();
    if (state.game.phase !== 'setup') return toast('ゲーム開始後は参加者の並び順を変更できません。', 'error');

    /** @type {any} */
    let response;
    try {
      store.commit('参加者並び順シャッフル', (draft) => {
        response = shuffleSetupPlayers(draft.players);
        if (!response.ok) throw new Error(response.message);
        draft.game.callNameSnapshot = null;
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    toast(response.message, 'success');
  }

  function _changePlayerCount(count) {
    try {
      const roles = getPresetRolesForPlayerCount(count);
      store.commit('参加人数変更', (state) => {
        const current = state.players.length;
        if (count > current) {
          for (let index = current; index < count; index += 1) {
            state.players.push(createPlayer({ name: `プレイヤー${index + 1}` }));
          }
        } else {
          state.players = state.players.slice(0, count);
        }

        const participantIds = new Set(state.players.map((player) => player.id));
        state.players.forEach((player) => {
          player.callNameOverrides = Object.fromEntries(
            Object.entries(player.callNameOverrides ?? {})
              .filter(([targetPlayerId]) => participantIds.has(targetPlayerId) && targetPlayerId !== player.id),
          );
        });
        applySetupRoles(state.players, roles);
        state.game.callNameSnapshot = null;
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      render();
    }
  }

  function _applyPreset() {
    try {
      const state = store.getState();
      const roles = shuffle(getPresetRolesForPlayerCount(state.players.length));
      store.commit('推奨配役適用', (draft) => {
        applySetupRoles(draft.players, roles);
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    toast('推奨配役を適用しました。', 'success');
  }

  function _changeRule(path, rawValue) {
    const refresh = { rules: true, validation: true };
    try {
      commitSetupMutation('ルール変更', (state) => {
        state.game.rules = applyGameRuleChange(state.game.rules, path, rawValue);
      }, { refresh });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      refreshSetupView(refresh);
    }
  }

  function _changePlayerField(playerId, field, value) {
    const refresh = field === 'roleId'
      ? { roleSummary: true, rules: true, validation: true }
      : field === 'name'
        ? { participants: true, validation: true }
        : {};
    commitSetupMutation('プレイヤー設定変更', (state) => {
      const player = state.players.find((item) => item.id === playerId);
      if (!player) throw new Error(`プレイヤーが見つかりません: ${playerId}`);
      if (field === 'roleId') assignSetupPlayerRole(player, value);
      else player[field] = value;
    }, { refresh, decorateSetup: field === 'controller' });
  }

  function _commitPlayerDetailUpdate(playerId, values, validCallNameTargetPlayerIds) {
    const prepared = preparePlayerDetailUpdate(values, { validCallNameTargetPlayerIds });
    if (!prepared.ok) return prepared;
    store.commit('プレイヤー詳細変更', (draft) => {
      applyPlayerDetailUpdate(draft, playerId, prepared.patch);
    });
    return prepared;
  }

  function _markBriefingShown(playerId) {
    return _runEngine('AI初期プロンプト提示', (draft) => markBriefingShown(draft, playerId), {
      informationBarrier: true,
      notification: { silentSuccess: true },
    });
  }

  return Object.freeze({
    _runEngine,
    _assignCharacterCard,
    _randomizeCharacters,
    _shuffleRoles,
    _movePlayerOrder,
    _shufflePlayerOrder,
    _changePlayerCount,
    _applyPreset,
    _changeRule,
    _changePlayerField,
    _commitPlayerDetailUpdate,
    _markBriefingShown,
  });
}
