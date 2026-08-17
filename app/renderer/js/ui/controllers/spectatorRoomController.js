/**
 * 責務: 人狼観戦ルームの専用State・永続化・推理観戦/神視点観戦の情報境界・追っかけ再生カーソル・公開Snapshot購読・観戦者選択・AI生成・質問回答・観戦コメント自動生成・人狼卓1手進行の橋渡しを調停する。
 * 変更ルール: 追っかけ中はGame Stateを書き換えずpublicReplaySnapshotだけを進め、リアルタイム中の1手進行だけAI管理の共通runSingleGameStepへ委譲する。推理観戦は再生位置の公開Snapshotだけ、神視点観戦はそこへ最後に再生済みの公開event sequenceまでに確定した真役職・現在陣営・役職基本能力だけを追加し、非公開sequenceをcutoffへ直接使用しない。心の声・内部メモ・私有会話・未確定行動は神視点でも渡さない。AI生成開始時の公開Snapshot・再生位置をcommit境界として固定し、生成中に観戦ソースが進んだ応答は破棄して既読カーソルを進めない。ログ送りは常に手動で、autoCommentは表示済み公開更新への観戦AI反応だけを自動生成する。自由チャットState/Promptを流用せず、起動復元を含む新ゲーム検出時は旧観戦文脈を破棄する。
 */

import { getCharacterGroups } from '../../characters/catalog/characterCatalog.js';
import { buildPublicSnapshot } from '../../public/publicSnapshot.js';
import {
  buildPublicReplaySnapshot,
  latestHistoricalPublicSequence,
  nextHistoricalPublicEvent,
  resolveHistoricalPublicCutoffSequence,
  resolvePublicReplayStart,
} from '../../public/publicReplaySnapshot.js';
import { ensureExternalDataNoticeForProfile } from '../../privacy/dataTransmissionNotice.js';
import {
  addSpectatorAiMessage,
  addSpectatorHumanMessage,
  addSpectatorPublicUpdate,
  addSpectatorSystemMessage,
  beginSpectatorRoom,
  consumeSpectatorNextTurn,
  createSpectatorRoomState,
  ensureSpectatorNextTurn,
  forceSpectatorSpeaker,
  getSpectatorMemory,
  setSpectatorPlayback,
  normalizeSpectatorRoomState,
  pendingSpectatorQuestionsFor,
  reconcileSpectatorParticipants,
  replaceSpectatorParticipants,
  resetSpectatorForNewGame,
  scheduleSpectatorReactionTurns,
  setSpectatorMemory,
  setSpectatorObserverCursor,
  updateSpectatorSettings,
} from '../../domain/spectator/spectatorRoomState.js';
import {
  buildSpectatorPublicFeed,
  spectatorPublicFactSignature,
  summarizeSpectatorPublicUpdate,
} from '../../domain/spectator/spectatorPublicFeed.js';
import {
  buildSpectatorOmniscientFeed,
  spectatorOmniscientFactSignature,
} from '../../domain/spectator/spectatorOmniscientFeed.js';
import { resolveSpectatorReactionCount } from '../../domain/spectator/spectatorReactionPolicy.js';
import { buildSpectatorPromptEnvelope, parseSpectatorResponse } from '../../prompts/spectator/spectatorPrompt.js';
import { renderSpectatorRoomLive, renderSpectatorRoomSetup } from '../views/chat/spectatorRoomView.js';

const MAX_AUTO_COMMENT_GENERATIONS = 8;

function enabledProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).filter((profile) => profile?.enabled !== false && profile?.id);
}

function providerErrorMessage(response) {
  return String(response?.error?.message ?? response?.message ?? '観戦AI生成に失敗しました。');
}

export function createSpectatorRoomController({ ui, gameStore, isVisible = () => true }) {
  if (!ui) throw new TypeError('AppUIがありません。');
  if (!gameStore || typeof gameStore.getState !== 'function') throw new TypeError('Game State Storeがありません。');
  const bridge = window.desktopWerewolf;
  const renderIfVisible = () => { if (isVisible()) ui.render(); };
  let state = normalizeSpectatorRoomState(bridge?.loadSpectatorRoomSync?.() ?? null);
  let profiles = [];
  let profilesLoading = true;
  let generating = false;
  let autoDraining = false;
  let currentRequestId = null;
  let bulkProfileId = '';
  let drainToken = 0;
  let reconcilePromise = Promise.resolve();

  function gameState() {
    return gameStore.getState();
  }

  function livePublicSnapshot() {
    return buildPublicSnapshot(gameState(), { includeConfidential: false });
  }

  function playbackSnapshot() {
    if (state.status === 'active' && !state.followingLive) {
      return buildPublicReplaySnapshot(gameState(), state.playbackEventSequence, { includeConfidential: false });
    }
    return livePublicSnapshot();
  }

  function omniscientFeed(snapshot = playbackSnapshot(), cutoffSequence = state.status === 'active' && !state.followingLive ? state.playbackEventSequence : null) {
    if (state.observationMode !== 'omniscient') return null;
    const current = gameState();
    const publicCutoffSequence = cutoffSequence === null
      ? null
      : resolveHistoricalPublicCutoffSequence(current, cutoffSequence);
    return buildSpectatorOmniscientFeed(current, { publicSnapshot: snapshot, cutoffSequence: publicCutoffSequence });
  }

  function currentLiveHeadSequence() {
    return latestHistoricalPublicSequence(gameState());
  }

  function captureGenerationSource(snapshot) {
    const followingLive = state.followingLive;
    const eventSequence = followingLive ? currentLiveHeadSequence() : state.playbackEventSequence;
    return Object.freeze({
      sourceGameId: state.sourceGameId,
      followingLive,
      eventSequence,
      publicRevision: snapshot.publicRevision,
      factSignature: feedSignature(snapshot, { cutoffSequence: followingLive ? null : eventSequence }),
    });
  }

  function generationSourceIsCurrent(source) {
    const current = gameState();
    if (current.game.id !== source.sourceGameId || current.game.status === 'setup' || state.sourceGameId !== source.sourceGameId) return false;
    if (state.followingLive !== source.followingLive) return false;
    if (!source.followingLive && state.playbackEventSequence !== source.eventSequence) return false;
    const currentEventSequence = source.followingLive ? latestHistoricalPublicSequence(current) : source.eventSequence;
    if (currentEventSequence !== source.eventSequence) return false;
    const snapshot = source.followingLive
      ? buildPublicSnapshot(current, { includeConfidential: false })
      : buildPublicReplaySnapshot(current, source.eventSequence, { includeConfidential: false });
    if (snapshot.publicRevision !== source.publicRevision) return false;
    return feedSignature(snapshot, { cutoffSequence: source.followingLive ? null : source.eventSequence }) === source.factSignature;
  }

  function gameView() {
    const snapshot = playbackSnapshot();
    const godView = omniscientFeed(snapshot);
    const latestEventSequence = currentLiveHeadSequence();
    const nextEventSequence = state.status === 'active' && !state.followingLive
      ? nextHistoricalPublicEvent(gameState(), state.playbackEventSequence)?.sequence ?? null
      : null;
    return {
      title: snapshot.game.title,
      day: snapshot.game.day,
      phaseLabel: snapshot.game.phaseLabel,
      status: snapshot.game.status,
      publicRevision: snapshot.publicRevision,
      aliveCount: snapshot.players.filter((player) => player.alive).length,
      deadCount: snapshot.players.filter((player) => !player.alive).length,
      claimCount: snapshot.claims.length,
      abilityClaimCount: snapshot.publicAbilityClaims.length,
      observationMode: state.observationMode,
      revealedRoles: godView?.players ?? [],
      followingLive: state.status === 'active' ? state.followingLive : true,
      playbackEventSequence: state.playbackEventSequence,
      latestEventSequence,
      nextEventSequence,
    };
  }

  function characterGroups() {
    return getCharacterGroups();
  }

  function characterCards() {
    return characterGroups().flatMap((group) => group.characters);
  }

  function cardById(id) {
    return characterCards().find((card) => card.id === id) ?? null;
  }

  function excludedCharacterIds() {
    return [...new Set(gameState().players.map((player) => String(player.characterCardId ?? '')).filter(Boolean))];
  }

  function availableObserverIds() {
    const excluded = new Set(excludedCharacterIds());
    return characterGroups().filter((group) => group.enabled !== false).flatMap((group) => group.characters
      .filter((card) => card.enabled !== false && !excluded.has(card.id)).map((card) => card.id));
  }

  async function persist() {
    state.updatedAt = new Date().toISOString();
    await bridge?.saveSpectatorRoom?.(state);
  }

  function setAiProfiles(nextProfiles) {
    profiles = structuredClone(enabledProfiles(nextProfiles));
    const valid = new Set(profiles.map((profile) => profile.id));
    if (!valid.has(bulkProfileId)) bulkProfileId = profiles[0]?.id ?? '';
  }

  async function refreshProfiles() {
    profilesLoading = true;
    try {
      const settings = await bridge?.getSettings?.();
      if (settings?.profiles) setAiProfiles(settings.profiles);
    } catch (error) {
      ui.toast(`観戦用AIプロファイルを読み込めませんでした: ${error.message}`, 'error');
    } finally {
      profilesLoading = false;
      renderIfVisible();
    }
  }

  function profilesValid() {
    const valid = new Set(profiles.map((profile) => profile.id));
    return state.participants.every((participant) => participant.profileId && valid.has(participant.profileId));
  }

  async function reconcileCharacters({ announce = false } = {}) {
    const change = reconcileSpectatorParticipants(state, availableObserverIds());
    if (!change.removedIds.length) return change;
    if (state.status === 'active') {
      addSpectatorSystemMessage(state, `対戦参加またはキャラクター設定の変更により、観戦者${change.removedIds.length}名を観戦ルームから外しました。`);
      if (change.insufficientParticipants) addSpectatorSystemMessage(state, '観戦者が2人未満になったため観戦AI生成を停止しました。');
    }
    await persist();
    if (announce) ui.toast('観戦キャラクターを現在のゲームとキャラクター設定へ同期しました。', 'info', { key: 'spectator-reconcile' });
    renderIfVisible();
    return change;
  }

  function nextTurn() {
    return state.status === 'active' ? ensureSpectatorNextTurn(state) : null;
  }

  function render() {
    const groups = characterGroups();
    if (state.status === 'active') return renderSpectatorRoomLive({ state, groups, profiles, generating, autoDraining, nextTurn: nextTurn(), publicView: gameView() });
    return renderSpectatorRoomSetup({ state, groups, profiles, profileLoading: profilesLoading, excludedCharacterIds: excludedCharacterIds(), bulkProfileId, gameView: gameView() });
  }

  function afterRender() {
    if (state.status !== 'active') return;
    const log = ui.root?.querySelector('[data-spectator-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function readControl(field) {
    return ui.root?.querySelector(`[data-spectator-field="${CSS.escape(field)}"]`) ?? null;
  }

  function syncSettingsFromControls() {
    const startControl = readControl('start-log-number');
    updateSpectatorSettings(state, {
      observationMode: String(readControl('observation-mode')?.value ?? state.observationMode),
      autoComment: Boolean(readControl('auto-comment')?.checked ?? state.autoComment),
      reactionLevel: String(readControl('reaction-level')?.value ?? state.reactionLevel),
      playerName: String(readControl('player-name')?.value ?? state.playerName),
      startLogNumber: startControl ? String(startControl.value ?? '') : state.startLogNumber,
    });
  }

  function feedSignature(snapshot, { cutoffSequence = null } = {}) {
    const feed = buildSpectatorPublicFeed(snapshot, { afterSequence: 0, includeFullHistory: true });
    const godView = omniscientFeed(snapshot, cutoffSequence);
    return state.observationMode === 'omniscient'
      ? `${spectatorPublicFactSignature(feed)}
${spectatorOmniscientFactSignature(godView)}`
      : spectatorPublicFactSignature(feed);
  }

  function setAllObserverCursors({ publicRevision, eventSequence }) {
    state.participants.forEach((participant) => {
      setSpectatorObserverCursor(state, participant.characterId, { publicRevision, eventSequence });
    });
  }

  function ingestSnapshot(snapshot, { initial = false, force = false, eventSequence = null, followingLive = state.followingLive, cutoffSequence = null } = {}) {
    const previousSequence = initial ? 0 : state.playbackEventSequence;
    const feed = buildSpectatorPublicFeed(snapshot, {
      afterSequence: previousSequence,
      includeFullHistory: initial,
    });
    const godView = omniscientFeed(snapshot, cutoffSequence);
    const signature = state.observationMode === 'omniscient'
      ? `${spectatorPublicFactSignature(feed)}
${spectatorOmniscientFactSignature(godView)}`
      : spectatorPublicFactSignature(feed);
    const factsChanged = signature !== state.playbackFactSignature;
    const revisionAdvanced = snapshot.publicRevision > state.playbackPublicRevision;
    const resolvedEventSequence = eventSequence === null ? feed.latestEventSequence : Math.max(0, Number(eventSequence ?? 0) || 0);
    if (!force && !initial && !revisionAdvanced && !factsChanged && resolvedEventSequence === state.playbackEventSequence) return { changed: false, scheduled: 0 };
    if (feed.events.length || factsChanged || initial) {
      const summary = state.observationMode === 'omniscient' && !initial && !feed.events.length && factsChanged
        ? '神視点情報を再同期しました。真役職・現在陣営の状態に更新があります。'
        : summarizeSpectatorPublicUpdate(feed, { initial });
      addSpectatorPublicUpdate(state, summary, {
        publicRevision: feed.publicRevision,
        eventSequence: resolvedEventSequence,
      });
    }
    const count = resolveSpectatorReactionCount({
      feed,
      reactionLevel: state.reactionLevel,
      factsChanged,
      participantCount: state.participants.length,
      initial,
    });
    const scheduled = scheduleSpectatorReactionTurns(state, { count, sourcePublicRevision: feed.publicRevision });
    setSpectatorPlayback(state, {
      followingLive,
      publicRevision: feed.publicRevision,
      eventSequence: resolvedEventSequence,
      factSignature: signature,
    });
    return { changed: true, scheduled };
  }

  async function startRoom() {
    syncSettingsFromControls();
    const currentGame = gameState();
    if (currentGame.game.status === 'setup') throw new Error('人狼ゲームを開始してから観戦を開始してください。');
    await reconcileCharacters();
    if (state.participants.length < 2) throw new Error('対戦参加者以外から観戦キャラクターを2人以上選択してください。');
    if (!profilesValid()) throw new Error('観戦キャラクター全員に利用可能なAIプロファイルを設定してください。');
    const requestedLogNumber = state.startLogNumber ?? (latestHistoricalPublicSequence(currentGame) + 1);
    const replayStart = resolvePublicReplayStart(currentGame, requestedLogNumber);
    const temp = structuredClone(state);
    beginSpectatorRoom(temp, { sourceGameId: currentGame.game.id, sourceGameTitle: currentGame.game.title });
    temp.startLogNumber = requestedLogNumber;
    state = temp;
    addSpectatorSystemMessage(state, state.observationMode === 'omniscient'
      ? '観戦スタイルは神視点観戦です。真役職・その時点で確定済みの現在陣営を知る外部観客として、展開や認識のずれも含めてゲームを楽しみます。'
      : '観戦スタイルは推理観戦です。再生位置までの公開表示だけを見られる外部観客として、予想も交えながらゲームを楽しみます。');
    if (replayStart.followingLive) {
      const snapshot = livePublicSnapshot();
      ingestSnapshot(snapshot, { initial: true, force: true, eventSequence: replayStart.latestEventSequence, followingLive: true });
      addSpectatorSystemMessage(state, `指定した#${requestedLogNumber}は現在の公開ログより後のため、リアルタイム実況で開始しました。`);
    } else {
      const snapshot = buildPublicReplaySnapshot(currentGame, replayStart.playbackEventSequence, { includeConfidential: false });
      const signature = feedSignature(snapshot, { cutoffSequence: replayStart.playbackEventSequence });
      setSpectatorPlayback(state, {
        followingLive: false,
        publicRevision: snapshot.publicRevision,
        eventSequence: replayStart.playbackEventSequence,
        factSignature: signature,
      });
      setAllObserverCursors({ publicRevision: snapshot.publicRevision, eventSequence: replayStart.playbackEventSequence });
      addSpectatorSystemMessage(state, `追っかけ実況を#${replayStart.targetEventSequence}から開始します。［人狼卓を1手進める］で公開ログを1件ずつ再生します。`);
    }
    await persist();
    renderIfVisible();
    if (state.autoComment && state.followingLive) drainAutoComment();
  }

  async function requestAiCandidate({ speakerId, profileId, envelope, pendingMessageIds, requiredAnswerMessageId }) {
    const profile = profiles.find((item) => item.id === profileId) ?? null;
    const accepted = await ensureExternalDataNoticeForProfile(profile);
    if (!accepted) throw new Error('外部LLMへのデータ送信を開始しませんでした。');
    const participantIds = state.participants.map((item) => item.characterId);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      currentRequestId = `spectator-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const response = await bridge.generate({
        requestId: currentRequestId,
        profileId,
        promptEnvelope: envelope,
        taskType: 'spectator-room',
        requestPurpose: attempt === 0 ? 'normal' : 'regenerate',
        generationStage: 'direct',
        playerName: cardById(speakerId)?.name ?? speakerId,
        gameId: state.sourceGameId || state.id,
        retryIndex: attempt,
        publicHistoryMode: 'delta',
        isTaskCall: true,
        taskStart: attempt === 0,
        regeneratedTask: attempt > 0,
      });
      window.dispatchEvent(new CustomEvent('ai-werewolf-usage-updated'));
      if (response?.ok === false) throw new Error(providerErrorMessage(response));
      try {
        return parseSpectatorResponse(response?.text, {
          participantIds,
          speakerId,
          pendingMessageIds,
          fallbackMemory: getSpectatorMemory(state, speakerId),
          requiredAnswerMessageId,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('観戦AI応答を解析できませんでした。');
  }

  async function generateNext({ allowCreateManualTurn = true } = {}) {
    if (generating) return false;
    if (state.status !== 'active') throw new Error('観戦を開始してください。');
    if (state.participants.length < 2) throw new Error('観戦者を2人以上にしてください。');
    if (!profilesValid()) throw new Error('観戦者のAIプロファイル設定を確認してください。');
    let turn = ensureSpectatorNextTurn(state);
    if (!turn && allowCreateManualTurn) {
      const ids = state.participants.map((item) => item.characterId);
      const fallback = ids.find((id) => id !== state.lastSpeakerId) ?? ids[0];
      forceSpectatorSpeaker(state, fallback);
      turn = ensureSpectatorNextTurn(state);
    }
    if (!turn) return false;
    const speakerCard = cardById(turn.speakerId);
    const participant = state.participants.find((item) => item.characterId === turn.speakerId);
    if (!speakerCard || !participant?.profileId) throw new Error('次の観戦者またはAIプロファイルを読み込めません。');
    const pendingAll = pendingSpectatorQuestionsFor(state, turn.speakerId);
    const pending = turn.kind === 'answer' ? pendingAll.filter((item) => item.messageId === turn.questionMessageId) : pendingAll;
    if (turn.kind === 'answer' && pending.length !== 1) throw new Error('観戦質問回答ターンの元質問を読み込めません。');
    const snapshot = playbackSnapshot();
    if (gameState().game.id !== state.sourceGameId || gameState().game.status === 'setup') throw new Error('観戦対象ゲームが切り替わりました。');
    const source = captureGenerationSource(snapshot);
    const cursor = state.observerCursors?.[turn.speakerId] ?? { publicRevision: 0, eventSequence: 0 };
    const feed = buildSpectatorPublicFeed(snapshot, {
      afterSequence: cursor.eventSequence,
      includeFullHistory: cursor.publicRevision === 0,
    });
    const godView = omniscientFeed(snapshot, source.followingLive ? null : source.eventSequence);
    const cards = state.participants.map((item) => cardById(item.characterId)).filter(Boolean);
    const envelope = buildSpectatorPromptEnvelope({ state, speakerCard, participantCards: cards, publicFeed: feed, omniscientFeed: godView, pendingQuestions: pending, turn });
    const requestStateRevision = state.revision;
    const pendingMessageIds = pending.map((item) => item.messageId);
    const requiredAnswerMessageId = turn.kind === 'answer' ? turn.questionMessageId : '';
    let retryAfterStaleSource = false;
    generating = true;
    renderIfVisible();
    try {
      const result = await requestAiCandidate({ speakerId: turn.speakerId, profileId: participant.profileId, envelope, pendingMessageIds, requiredAnswerMessageId });
      if (!generationSourceIsCurrent(source)) {
        retryAfterStaleSource = state.status === 'active';
        ui.toast('観戦中の公開状態が更新されたため、古いAI応答を破棄して最新状態から生成し直します。', 'info', { key: 'spectator-stale-source' });
        return false;
      }
      if (state.revision !== requestStateRevision) {
        const currentTurn = ensureSpectatorNextTurn(state);
        if (!currentTurn || currentTurn.kind !== turn.kind || currentTurn.speakerId !== turn.speakerId || String(currentTurn.questionMessageId ?? '') !== String(turn.questionMessageId ?? '')) {
          ui.toast('観戦ルームの発言順が変更されたため、古いAI応答を破棄しました。', 'info', { key: 'spectator-stale-turn' });
          return false;
        }
      }
      const consumed = consumeSpectatorNextTurn(state);
      if (!consumed || consumed.kind !== turn.kind || consumed.speakerId !== turn.speakerId || String(consumed.questionMessageId ?? '') !== String(turn.questionMessageId ?? '')) throw new Error('観戦発言順が更新されたためAI応答を登録できませんでした。');
      setSpectatorMemory(state, turn.speakerId, result.memory);
      addSpectatorAiMessage(state, {
        speakerId: turn.speakerId,
        speakerName: speakerCard.name,
        text: result.chatMessage,
        questionTargetIds: result.questionTargetIds,
        answersMessageIds: result.answersMessageIds,
        sourcePublicRevision: source.publicRevision,
        sourceEventSequence: source.eventSequence,
      });
      setSpectatorObserverCursor(state, turn.speakerId, { publicRevision: source.publicRevision, eventSequence: source.eventSequence });
      await persist();
      return true;
    } finally {
      generating = false;
      currentRequestId = null;
      renderIfVisible();
      if (retryAfterStaleSource) {
        setTimeout(() => {
          if (state.status !== 'active') return;
          if (state.autoComment) {
            drainAutoComment();
            return;
          }
          generateNext({ allowCreateManualTurn: false }).catch((error) => ui.toast(`観戦AIの再生成に失敗しました: ${error.message}`, 'error', { key: 'spectator-stale-retry-error' }));
        }, 0);
      }
    }
  }

  function drainAutoComment() {
    if (!state.autoComment || state.status !== 'active' || autoDraining) return;
    autoDraining = true;
    const token = ++drainToken;
    queueMicrotask(async () => {
      try {
        for (let index = 0; index < MAX_AUTO_COMMENT_GENERATIONS && token === drainToken && state.autoComment; index += 1) {
          if (!ensureSpectatorNextTurn(state)) break;
          const generated = await generateNext({ allowCreateManualTurn: false });
          if (!generated) break;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        ui.toast(`観戦コメント自動生成を停止しました: ${error.message}`, 'error', { key: 'spectator-auto-error' });
      } finally {
        if (token === drainToken) autoDraining = false;
        renderIfVisible();
      }
    });
  }

  async function reconcileSourceGame({ startup = false } = {}) {
    const current = gameState();
    const sourceInvalid = state.status === 'active' && state.sourceGameId
      && (current.game.id !== state.sourceGameId || current.game.status === 'setup');
    if (!sourceInvalid) return false;
    if (currentRequestId) bridge?.cancelRequest?.(currentRequestId).catch(() => {});
    drainToken += 1;
    autoDraining = false;
    generating = false;
    currentRequestId = null;
    state = resetSpectatorForNewGame(state);
    await persist();
    ui.toast(startup
      ? '保存済み観戦セッションの対象ゲームが現在のゲームと一致しないため、旧ゲームの観戦を終了しました。'
      : '観戦対象が新しいゲームへ切り替わったため、旧ゲームの観戦を終了しました。', 'info', { key: 'spectator-game-changed' });
    renderIfVisible();
    return true;
  }

  function handleGameStateChange() {
    reconcilePromise = reconcilePromise.then(async () => {
      if (await reconcileSourceGame()) return;
      const current = gameState();
      await reconcileCharacters();
      if (state.status !== 'active') return;
      if (!state.followingLive) {
        renderIfVisible();
        return;
      }
      const snapshot = buildPublicSnapshot(current, { includeConfidential: false });
      const ingestion = ingestSnapshot(snapshot, {
        eventSequence: latestHistoricalPublicSequence(current),
        followingLive: true,
      });
      if (!ingestion.changed) return;
      await persist();
      renderIfVisible();
      if (state.autoComment) drainAutoComment();
    }).catch((error) => ui.toast(`観戦公開情報の同期に失敗しました: ${error.message}`, 'error', { key: 'spectator-sync-error' }));
    return reconcilePromise;
  }

  async function jumpToLive() {
    if (state.status !== 'active') return;
    const current = gameState();
    if (current.game.id !== state.sourceGameId) throw new Error('観戦対象ゲームが切り替わっています。');
    const snapshot = buildPublicSnapshot(current, { includeConfidential: false });
    const head = latestHistoricalPublicSequence(current);
    const signature = feedSignature(snapshot);
    setSpectatorPlayback(state, {
      followingLive: true,
      publicRevision: snapshot.publicRevision,
      eventSequence: head,
      factSignature: signature,
    });
    setAllObserverCursors({ publicRevision: snapshot.publicRevision, eventSequence: head });
    addSpectatorSystemMessage(state, '最新の公開状態へ移動し、リアルタイム実況に合流しました。');
    await persist();
    renderIfVisible();
  }

  async function syncPublicNow() {
    if (state.status !== 'active') return;
    if (!state.followingLive) return jumpToLive();
    const current = gameState();
    if (current.game.id !== state.sourceGameId) throw new Error('観戦対象ゲームが切り替わっています。');
    const snapshot = buildPublicSnapshot(current, { includeConfidential: false });
    ingestSnapshot(snapshot, { force: true, eventSequence: latestHistoricalPublicSequence(current), followingLive: true });
    await persist();
    renderIfVisible();
    if (state.autoComment) drainAutoComment();
  }

  async function advanceHumanTableOne() {
    if (state.status !== 'active') throw new Error('観戦を開始してください。');
    if (generating || autoDraining) throw new Error('観戦AI生成の完了後に人狼卓を進めてください。');
    const current = gameState();
    if (current.game.id !== state.sourceGameId) throw new Error('観戦対象ゲームが切り替わっています。');
    if (!state.followingLive) {
      const nextEvent = nextHistoricalPublicEvent(current, state.playbackEventSequence);
      if (!nextEvent) return jumpToLive();
      const nextSequence = Math.max(0, Number(nextEvent.sequence ?? 0) || 0);
      const latestSequence = latestHistoricalPublicSequence(current);
      const joinsLive = nextSequence >= latestSequence;
      const snapshot = buildPublicReplaySnapshot(current, nextSequence, { includeConfidential: false });
      ingestSnapshot(snapshot, {
        force: true,
        eventSequence: nextSequence,
        followingLive: joinsLive,
        cutoffSequence: nextSequence,
      });
      if (joinsLive) addSpectatorSystemMessage(state, '最新の公開ログまで追いついたため、リアルタイム実況に合流しました。');
      await persist();
      renderIfVisible();
      if (state.autoComment) drainAutoComment();
      return;
    }
    const runSingleGameStep = window.AiWerewolfDesktopAutomation?.runSingleGameStep;
    if (typeof runSingleGameStep !== 'function') throw new Error('人狼卓の1手進行機能を読み込めませんでした。');
    await runSingleGameStep();
    await handleGameStateChange();
  }

  async function stopAll() {
    drainToken += 1;
    autoDraining = false;
    if (currentRequestId) {
      const requestId = currentRequestId;
      currentRequestId = null;
      await bridge?.cancelRequest?.(requestId).catch(() => {});
    }
  }

  async function newRoom() {
    await stopAll();
    const previous = state;
    state = createSpectatorRoomState({ participants: previous.participants });
    state.observationMode = previous.observationMode === 'omniscient' ? 'omniscient' : 'deduction';
    state.autoComment = previous.autoComment;
    state.reactionLevel = previous.reactionLevel;
    state.playerName = previous.playerName;
    state.startLogNumber = previous.startLogNumber;
    await reconcileCharacters();
    await persist();
    renderIfVisible();
  }

  async function forceSpeaker(characterId) {
    if (!forceSpectatorSpeaker(state, characterId)) throw new Error('対象観戦者を次の発言へ指定できません。');
    await persist();
    renderIfVisible();
    if (state.autoComment) drainAutoComment();
  }

  async function sendHuman() {
    if (state.status !== 'active') throw new Error('観戦を開始してください。');
    if (generating) throw new Error('観戦AI生成の完了後に送信してください。');
    const textarea = readControl('human-message');
    const targetSelect = readControl('human-target');
    const text = String(textarea?.value ?? '').trim();
    if (!text) throw new Error('発言内容を入力してください。');
    const targetId = String(targetSelect?.value ?? '');
    const targetCard = targetId ? cardById(targetId) : null;
    if (targetId && !targetCard) throw new Error('発言先の観戦者を読み込めません。');
    addSpectatorHumanMessage(state, {
      text,
      targetId: targetCard?.id ?? null,
      targetName: targetCard?.name ?? '',
      speakerName: state.playerName,
    });
    if (!targetCard) {
      const ids = state.participants.map((item) => item.characterId);
      const fallback = ids.find((id) => id !== state.lastSpeakerId) ?? ids[0];
      if (fallback) forceSpectatorSpeaker(state, fallback);
    }
    await persist();
    renderIfVisible();
    if (state.autoComment) drainAutoComment();
  }

  async function applyBulkProfile() {
    const profileId = String(readControl('bulk-profile')?.value ?? bulkProfileId).trim();
    if (!profiles.some((profile) => profile.id === profileId)) throw new Error('一括設定するAIプロファイルを選択してください。');
    if (!state.participants.length) throw new Error('観戦キャラクターを選択してください。');
    bulkProfileId = profileId;
    state.participants.forEach((participant) => { participant.profileId = profileId; });
    await persist();
    renderIfVisible();
  }

  async function handleChange(event) {
    if (ui.getActiveTab?.() !== 'chat-room') return false;
    const field = event.target.closest('[data-spectator-field]');
    if (!field) return false;
    if (field.dataset.spectatorField === 'participant' && state.status === 'setup') {
      const id = String(field.dataset.characterId ?? '');
      const next = structuredClone(state.participants);
      const index = next.findIndex((item) => item.characterId === id);
      if (field.checked && index < 0) next.push({ characterId: id, profileId: profiles[0]?.id ?? '' });
      if (!field.checked && index >= 0) next.splice(index, 1);
      replaceSpectatorParticipants(state, next);
      await persist();
      renderIfVisible();
      return true;
    }
    if (field.dataset.spectatorField === 'participant-profile' && state.status === 'setup') {
      const participant = state.participants.find((item) => item.characterId === field.dataset.characterId);
      if (participant) participant.profileId = String(field.value ?? '');
      await persist();
      renderIfVisible();
      return true;
    }
    if (field.dataset.spectatorField === 'bulk-profile') {
      bulkProfileId = String(field.value ?? '');
      return true;
    }
    if (['observation-mode', 'start-log-number'].includes(field.dataset.spectatorField) && state.status === 'setup') {
      syncSettingsFromControls();
      await persist();
      renderIfVisible();
      return true;
    }
    if (['auto-comment', 'reaction-level', 'player-name'].includes(field.dataset.spectatorField)) {
      syncSettingsFromControls();
      await persist();
      renderIfVisible();
      if (state.autoComment && field.dataset.spectatorField !== 'player-name') drainAutoComment();
      return true;
    }
    return true;
  }

  function handleClick(button) {
    const action = String(button?.dataset?.spectatorAction ?? '');
    const run = async () => {
      if (action === 'start') return startRoom();
      if (action === 'next-ai') return generateNext();
      if (action === 'force-speaker') return forceSpeaker(button.dataset.characterId);
      if (action === 'bulk-assign-profile') return applyBulkProfile();
      if (action === 'advance-game-one') return advanceHumanTableOne();
      if (action === 'sync-public') return syncPublicNow();
      if (action === 'new-room') return newRoom();
      if (action === 'send-human') return sendHuman();
      return undefined;
    };
    run().catch((error) => ui.toast(error.message, 'error'));
    return true;
  }

  refreshProfiles();
  reconcilePromise = reconcilePromise.then(async () => {
    await reconcileSourceGame({ startup: true });
    await reconcileCharacters();
  }).catch((error) => ui.toast(`観戦セッションの起動同期に失敗しました: ${error.message}`, 'error', { key: 'spectator-reconcile' }));

  return Object.freeze({
    render,
    afterRender,
    handleChange,
    handleClick,
    handleGameStateChange,
    reconcileCharacters,
    setAiProfiles,
    stopAll,
  });
}
