/**
 * 責務: チャットルーム画面の状態、準備/参加者編集で表示するキャラクターグループ選択UI状態、プレイヤー名、キャラクター個別内部メモ、専用永続化、キャラクターカタログ整合、会話中の参加者差し替え、参加者ごとのAIプロファイル割当と一括適用、通常巡回/質問回答ターンのAI生成、会話きっかけ選択、自動会話を調停する。
 * 変更ルール: 人狼ゲームStateとdiscussionRuntimeを変更しない。キャラクターグループ選択はRenderer内だけのUI状態として扱い、チャットStateやMain保存へ混在させない。AI通信はdesktopWerewolf.generateを使用し、外部LLMはprivacy/dataTransmissionNotice.jsの初回確認完了後だけ要求する。会話順・優先ターン・revision・内部メモ・参加者差し替え/孤立参照除去はdomain/chat配下、プロンプト本文はprompts/chat/chatRoomPrompt.js、会話きっかけの候補/重み選択はprompts/chat/chatRoomConversationCuePolicy.jsを正本とする。会話中の参加者変更ではメッセージ履歴・お題・プレイヤー名を消さず、通常巡回だけ新構成へ切り替える。外部で削除・無効化された参加キャラクターは履歴を残して除外し、2人未満ならAI生成だけを停止して参加者変更を可能にする。AI生成開始時にはターンを消費せずrevisionを固定し、生成中にプレイヤー発言・お題・発言順が変わった場合は古い応答を破棄する。質問専用回答ターンでは対象質問だけを必須回答として渡し、通常巡回枠を消費しない。内部メモは発言者本人の完成版だけを置換し共有しない。会話のきっかけは回答ターンへ渡さず、初回はお題なしの場合だけ、通常会話中は低確率だけ選ぶ。無効になったAIプロファイルは暗黙に別プロファイルへ差し替えず明示再設定を要求する。AIプロファイル一括適用はチャット参加者だけを対象とし、人狼側のassignmentsを変更しない。自動会話停止時は新規要求を開始せず、明示停止では実行中要求もキャンセル可能にする。保存失敗は呼び出し元へ伝播し、成功通知を出さない。
 */

import { getCharacterGroups } from '../../characters/catalog/characterCatalog.js';
import { downloadJson } from '../../shared/utils.js';
import { ensureExternalDataNoticeForProfile } from '../../privacy/dataTransmissionNotice.js';
import {
  addAiMessage,
  addHumanMessage,
  addSystemMessage,
  beginChatRoom,
  consumeNextTurn,
  createChatRoomState,
  ensureNextTurn,
  forceNextSpeaker,
  getCharacterMemory,
  normalizeChatRoomState,
  pendingQuestionsFor,
  rememberConversationCue,
  reconcileChatRoomCharacters,
  replaceChatRoomParticipants,
  setCharacterMemory,
  setChatTopic,
} from '../../domain/chat/chatRoomState.js';
import { buildChatRoomPromptEnvelope, parseChatRoomResponse } from '../../prompts/chat/chatRoomPrompt.js';
import { selectOpeningConversationCue, selectOptionalConversationCue } from '../../prompts/chat/chatRoomConversationCuePolicy.js';
import { renderChatRoomLive, renderChatRoomParticipantEdit, renderChatRoomSetup } from '../views/chat/chatRoomView.js';

function enabledProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).filter((profile) => profile?.enabled !== false && profile?.id);
}

function providerErrorMessage(response) {
  return String(response?.error?.message ?? response?.message ?? 'AI生成に失敗しました。');
}

export function createChatRoomController({ ui }) {
  if (!ui) throw new TypeError('AppUIがありません。');
  const bridge = window.desktopWerewolf;
  let state = normalizeChatRoomState(bridge?.loadChatRoomSync?.() ?? null);
  let profiles = [];
  let profilesLoading = true;
  let generating = false;
  let autoRunning = false;
  let currentRequestId = null;
  let autoRunToken = 0;
  let bulkProfileId = '';
  let selectedCharacterGroupId = '';
  let participantEditing = false;
  let participantDraft = [];

  async function refreshProfiles() {
    profilesLoading = true;
    try {
      const settings = await bridge?.getSettings?.();
      if (settings?.profiles) setAiProfiles(settings.profiles);
    } catch (error) {
      ui.toast(`AIプロファイルを読み込めませんでした: ${error.message}`, 'error');
    } finally {
      profilesLoading = false;
      if (ui.getActiveTab?.() === 'chat-room') ui.render();
    }
  }

  function setAiProfiles(nextProfiles) {
    profiles = structuredClone(enabledProfiles(nextProfiles));
    const validIds = new Set(profiles.map((profile) => profile.id));
    const fallback = profiles[0]?.id ?? '';
    if (!validIds.has(bulkProfileId)) bulkProfileId = fallback;
  }

  function characterCards() {
    return getCharacterGroups().flatMap((group) => group.characters);
  }

  function cardById(characterId) {
    return characterCards().find((card) => card.id === characterId) ?? null;
  }

  function availableCharacterIds() {
    return getCharacterGroups()
      .filter((group) => group.enabled !== false)
      .flatMap((group) => group.characters.filter((card) => card.enabled !== false).map((card) => card.id));
  }

  function syncSelectedCharacterGroup(groups = getCharacterGroups()) {
    const availableGroups = groups.filter((group) => group.enabled !== false && group.characters.some((card) => card.enabled !== false));
    if (!availableGroups.some((group) => group.id === selectedCharacterGroupId)) selectedCharacterGroupId = availableGroups[0]?.id ?? '';
    return selectedCharacterGroupId;
  }

  async function reconcileCharacters({ announce = true } = {}) {
    const change = reconcileChatRoomCharacters(state, availableCharacterIds());
    if (!change.removedIds.length) return change;
    if (participantEditing) {
      const available = new Set(availableCharacterIds());
      participantDraft = participantDraft.filter((participant) => available.has(participant.characterId));
    }
    if (!state.opening.consumed && state.opening.speakerId) {
      state.opening.seed = state.topic ? null : selectOpeningConversationCue({ state, speakerCard: cardById(state.opening.speakerId) });
    }
    addSystemMessage(state, `キャラクター管理の変更により、利用できなくなった参加キャラクター${change.removedIds.length}名を退出させました。`);
    if (change.insufficientParticipants) {
      addSystemMessage(state, '参加者が2人未満になったためAI発言を一時停止しました。参加者を変更してください。');
    }
    await persist();
    if (announce) ui.toast('チャットルームの参加者を現在のキャラクター設定へ同期しました。', 'info', { key: 'chat-character-reconcile' });
    if (ui.getActiveTab?.() === 'chat-room') ui.render();
    return change;
  }

  async function persist() {
    state.updatedAt = new Date().toISOString();
    await bridge?.saveChatRoom?.(state);
  }

  function readControl(field) {
    return ui.root?.querySelector(`[data-chat-field="${CSS.escape(field)}"]`) ?? null;
  }

  function editableParticipants() {
    return participantEditing ? participantDraft : state.participants;
  }

  function participantProfilesValid(participants = editableParticipants()) {
    const validProfileIds = new Set(profiles.map((profile) => profile.id));
    return participants.every((participant) => participant.profileId && validProfileIds.has(participant.profileId));
  }

  function syncSetupControls() {
    state.topic = String(readControl('topic')?.value ?? state.topic).trim();
    state.playerName = String(readControl('player-name')?.value ?? state.playerName).trim().slice(0, 80) || 'プレイヤー';
    state.speakerMode = readControl('speaker-mode')?.value === 'fixed' ? 'fixed' : 'random';
    state.questionPriority = Boolean(readControl('question-priority')?.checked);
    state.autoBatchSize = Math.min(100, Math.max(1, Number(readControl('auto-batch-size')?.value ?? state.autoBatchSize) || 10));
  }

  function normalizeParticipantProfiles() {
    return participantProfilesValid(state.participants);
  }

  function participantCards() {
    return state.participants.map((participant) => cardById(participant.characterId)).filter(Boolean);
  }

  function nextTurn() {
    return state.status === 'active' ? ensureNextTurn(state) : null;
  }

  function render() {
    const groups = getCharacterGroups();
    const selectedGroupId = syncSelectedCharacterGroup(groups);
    if (participantEditing) return renderChatRoomParticipantEdit({ state, participants: participantDraft, groups, profiles, profileLoading: profilesLoading, bulkProfileId, selectedGroupId });
    if (state.status === 'active') return renderChatRoomLive({ state, groups, profiles, generating, autoRunning, nextTurn: nextTurn() });
    return renderChatRoomSetup({ state, groups, profiles, profileLoading: profilesLoading, bulkProfileId, selectedGroupId });
  }

  function afterRender() {
    if (state.status !== 'active') return;
    const log = ui.root?.querySelector('[data-chat-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }

  async function startRoom() {
    syncSetupControls();
    if (state.participants.length < 2) throw new Error('2人以上のキャラクターを選択してください。');
    if (!normalizeParticipantProfiles()) throw new Error('参加キャラクター全員に利用可能なAIプロファイルを設定してください。');
    const temp = structuredClone(state);
    temp.queue = [];
    temp.spokenThisRound = [];
    temp.priorityTurns = [];
    temp.round = 0;
    temp.lastSpeakerId = null;
    temp.status = 'active';
    const provisional = beginChatRoom(temp, { openingSeed: null });
    const openingCard = cardById(provisional.opening.speakerId);
    provisional.opening.seed = provisional.topic ? null : selectOpeningConversationCue({ state: provisional, speakerCard: openingCard });
    state = provisional;
    if (state.topic) addSystemMessage(state, `お題：「${state.topic}」`);
    await persist();
    ui.render();
  }

  async function requestAiCandidate({ speakerId, profileId, envelope, pendingMessageIds = [], requiredAnswerMessageId = '' }) {
    const profile = profiles.find((item) => item.id === profileId) ?? null;
    const dataNoticeAccepted = await ensureExternalDataNoticeForProfile(profile);
    if (!dataNoticeAccepted) throw new Error('外部LLMへのデータ送信を開始しませんでした。');
    const participantIds = state.participants.map((item) => item.characterId);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      currentRequestId = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const response = await bridge.generate({
        requestId: currentRequestId,
        profileId,
        promptEnvelope: envelope,
        taskType: 'chat-room',
        requestPurpose: attempt === 0 ? 'normal' : 'regenerate',
        generationStage: 'direct',
        playerName: cardById(speakerId)?.name ?? speakerId,
        gameId: state.id,
        retryIndex: attempt,
        publicHistoryMode: 'full',
        isTaskCall: true,
        taskStart: attempt === 0,
        regeneratedTask: attempt > 0,
      });
      window.dispatchEvent(new CustomEvent('ai-werewolf-usage-updated'));
      if (!autoRunning && currentRequestId === null) throw new Error('AI生成を停止しました。');
      if (response?.ok === false) throw new Error(providerErrorMessage(response));
      try {
        return parseChatRoomResponse(response?.text, {
          participantIds,
          speakerId,
          pendingMessageIds,
          fallbackMemory: getCharacterMemory(state, speakerId),
          requiredAnswerMessageId,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('AI応答を解析できませんでした。');
  }

  async function generateNext() {
    if (generating) return false;
    if (state.status !== 'active') throw new Error('チャットルームを開始してください。');
    if (state.participants.length < 2) throw new Error('AI発言を続けるには参加キャラクターを2人以上にしてください。');
    if (!normalizeParticipantProfiles()) throw new Error('AIプロファイル設定が変わりました。参加者のAI割り当てを確認してください。');
    const turn = ensureNextTurn(state);
    const speakerId = turn?.speakerId ?? null;
    const speakerCard = cardById(speakerId);
    if (!turn || !speakerCard) throw new Error('次の発言キャラクターを読み込めません。');
    const participant = state.participants.find((item) => item.characterId === speakerId);
    if (!participant?.profileId) throw new Error(`${speakerCard.name}のAIプロファイルが設定されていません。`);
    const cards = participantCards();
    const allPending = pendingQuestionsFor(state, speakerId);
    const pending = turn.kind === 'answer'
      ? allPending.filter((item) => item.messageId === turn.questionMessageId)
      : allPending;
    if (turn.kind === 'answer' && pending.length !== 1) throw new Error('質問回答ターンの対象質問を読み込めません。');
    const openingPending = turn.kind !== 'answer' && !state.opening.consumed && state.opening.speakerId === speakerId && state.opening.seed;
    const conversationCue = openingPending ? null : selectOptionalConversationCue({ state, speakerCard, turnKind: turn.kind });
    const envelope = buildChatRoomPromptEnvelope({ state, speakerCard, participantCards: cards, pendingQuestions: pending, turn, conversationCue });
    const pendingMessageIds = pending.map((item) => item.messageId);
    const requiredAnswerMessageId = turn.kind === 'answer' ? turn.questionMessageId : '';
    const requestRevision = state.revision;
    generating = true;
    ui.render();
    try {
      const result = await requestAiCandidate({
        speakerId,
        profileId: participant.profileId,
        envelope,
        pendingMessageIds,
        requiredAnswerMessageId,
      });
      if (state.revision !== requestRevision) {
        ui.toast('生成中に会話状態が更新されたため、古いAI応答を破棄しました。', 'info', { key: 'chat-stale-response' });
        return false;
      }
      const consumedTurn = consumeNextTurn(state);
      if (!consumedTurn
        || consumedTurn.kind !== turn.kind
        || consumedTurn.speakerId !== turn.speakerId
        || String(consumedTurn.questionMessageId ?? '') !== String(turn.questionMessageId ?? '')) {
        throw new Error('発言順が更新されたためAI応答を登録できませんでした。');
      }
      const openingCueId = openingPending ? String(state.opening.seed?.id ?? '') : '';
      setCharacterMemory(state, speakerId, result.memory);
      addAiMessage(state, {
        speakerId,
        speakerName: speakerCard.name,
        text: result.chatMessage,
        questionTargetIds: result.questionTargetIds,
        answersMessageIds: result.answersMessageIds,
        consumeOpening: turn.kind !== 'answer',
      });
      if (openingCueId) rememberConversationCue(state, openingCueId);
      if (conversationCue?.id) rememberConversationCue(state, conversationCue.id);
      await persist();
      return true;
    } finally {
      generating = false;
      currentRequestId = null;
      ui.render();
    }
  }

  async function startAuto() {
    if (autoRunning || generating) return;
    autoRunning = true;
    const token = ++autoRunToken;
    ui.render();
    try {
      for (let completed = 0; completed < state.autoBatchSize && autoRunning && token === autoRunToken;) {
        const generated = await generateNext();
        if (generated) completed += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (autoRunning && token === autoRunToken) ui.toast(`${state.autoBatchSize}発言の自動会話が完了しました。`, 'success', { key: 'chat-auto-complete' });
    } catch (error) {
      ui.toast(`自動会話を停止しました: ${error.message}`, 'error');
    } finally {
      if (token === autoRunToken) autoRunning = false;
      ui.render();
    }
  }

  async function stopAuto() {
    autoRunning = false;
    autoRunToken += 1;
    if (currentRequestId) {
      const requestId = currentRequestId;
      currentRequestId = null;
      await bridge?.cancelRequest?.(requestId).catch(() => {});
    }
    ui.render();
  }

  async function sendHuman() {
    const textarea = readControl('human-message');
    const targetSelect = readControl('human-target');
    const text = String(textarea?.value ?? '').trim();
    if (!text) throw new Error('発言内容を入力してください。');
    const targetId = String(targetSelect?.value ?? '');
    const targetCard = targetId ? cardById(targetId) : null;
    addHumanMessage(state, { text, targetId: targetCard?.id ?? null, targetName: targetCard?.name ?? '', speakerName: state.playerName });
    await persist();
    ui.render();
  }

  async function changeTopic() {
    const topic = String(readControl('live-topic')?.value ?? '').trim();
    if (!setChatTopic(state, topic)) return;
    await persist();
    ui.render();
  }

  async function forceSpeaker(characterId) {
    if (!forceNextSpeaker(state, characterId)) throw new Error('対象キャラクターを発言順へ追加できません。');
    await persist();
    ui.render();
  }

  function startParticipantEdit() {
    if (state.status !== 'active') return;
    if (generating || autoRunning) throw new Error('AI生成を停止してから参加者を変更してください。');
    participantDraft = structuredClone(state.participants);
    participantEditing = true;
    ui.render();
  }

  function cancelParticipantEdit() {
    participantEditing = false;
    participantDraft = [];
    ui.render();
  }

  async function applyParticipantEdit() {
    if (!participantEditing || state.status !== 'active') return;
    if (participantDraft.length < 2) throw new Error('会話を続けるには2人以上のキャラクターを選択してください。');
    if (!participantProfilesValid(participantDraft)) throw new Error('参加キャラクター全員に利用可能なAIプロファイルを設定してください。');

    const beforeCards = new Map(state.participants.map((participant) => [participant.characterId, cardById(participant.characterId)]));
    const nextCards = new Map(participantDraft.map((participant) => [participant.characterId, cardById(participant.characterId)]));
    const change = replaceChatRoomParticipants(state, participantDraft);
    const participantSetChanged = change.addedIds.length > 0 || change.removedIds.length > 0 || change.orderChanged;
    if (participantSetChanged && !state.opening.consumed && state.opening.speakerId) {
      state.opening.seed = state.topic ? null : selectOpeningConversationCue({ state, speakerCard: cardById(state.opening.speakerId) });
    }
    if (change.addedIds.length || change.removedIds.length) {
      const added = change.addedIds.map((id) => nextCards.get(id)?.name ?? id);
      const removed = change.removedIds.map((id) => beforeCards.get(id)?.name ?? id);
      const parts = [];
      if (added.length) parts.push(`参加: ${added.join('、')}`);
      if (removed.length) parts.push(`退出: ${removed.join('、')}`);
      addSystemMessage(state, `参加キャラクターを変更しました。${parts.join(' / ')}`);
    }
    participantEditing = false;
    participantDraft = [];
    await persist();
    ui.render();
    ui.toast('会話履歴を保持したまま参加キャラクターを更新しました。', 'success', { key: 'chat-participant-edit' });
  }

  async function applyBulkProfile() {
    if (state.status !== 'setup' && !participantEditing) return;
    const profileId = String(readControl('bulk-profile')?.value ?? bulkProfileId).trim();
    if (!profileId || !profiles.some((profile) => profile.id === profileId)) throw new Error('一括設定するAIプロファイルを選択してください。');
    const targets = editableParticipants();
    if (!targets.length) throw new Error('AIプロファイルを適用する参加キャラクターを選択してください。');
    bulkProfileId = profileId;
    targets.forEach((participant) => { participant.profileId = profileId; });
    if (!participantEditing) await persist();
    ui.render();
    ui.toast(`参加キャラクター${targets.length}名へAIプロファイルを適用しました。`, 'success', { key: 'chat-bulk-profile' });
  }

  function confirmNewRoom() {
    const dialog = ui.modal;
    if (!dialog || dialog.open) return Promise.resolve(false);
    dialog.returnValue = 'cancel';
    dialog.innerHTML = `<form method="dialog"><div class="modal-header"><h3>新しいチャット</h3></div><div class="modal-body"><p>現在の会話履歴を終了し、参加キャラクターとAI割り当てを残して準備画面へ戻ります。</p></div><div class="modal-footer"><button class="button ghost" value="cancel" type="submit">キャンセル</button><button class="button danger" value="confirm" type="submit">新しいチャット</button></div></form>`;
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.innerHTML = ''; resolve(accepted); }, { once: true });
      dialog.showModal();
    });
  }

  async function newRoom() {
    if (!(await confirmNewRoom())) return;
    await stopAuto();
    participantEditing = false;
    participantDraft = [];
    const previous = state;
    state = createChatRoomState({ participants: previous.participants });
    state.playerName = previous.playerName;
    state.speakerMode = previous.speakerMode;
    state.questionPriority = previous.questionPriority;
    state.autoBatchSize = previous.autoBatchSize;
    await persist();
    ui.render();
  }

  function exportHistory() {
    downloadJson(`chat-room-${state.id}.json`, state);
  }

  async function handleChange(event) {
    if (ui.getActiveTab?.() !== 'chat-room' || (state.status !== 'setup' && !participantEditing)) return false;
    const field = event.target.closest('[data-chat-field]');
    if (!field) return false;
    const participants = editableParticipants();
    if (field.dataset.chatField === 'participant') {
      const characterId = field.dataset.characterId;
      if (field.checked) {
        if (!participants.some((item) => item.characterId === characterId)) participants.push({ characterId, profileId: profiles[0]?.id ?? '' });
      } else {
        const next = participants.filter((item) => item.characterId !== characterId);
        if (participantEditing) participantDraft = next;
        else state.participants = next;
      }
      if (!participantEditing) {
        syncSetupControls();
        await persist();
      }
      ui.render();
      return true;
    }
    if (field.dataset.chatField === 'participant-profile') {
      const participant = participants.find((item) => item.characterId === field.dataset.characterId);
      if (participant) participant.profileId = String(field.value ?? '');
      if (!participantEditing) {
        syncSetupControls();
        await persist();
      }
      ui.render();
      return true;
    }
    if (field.dataset.chatField === 'bulk-profile') {
      bulkProfileId = String(field.value ?? '');
      return true;
    }
    if (participantEditing) return true;
    syncSetupControls();
    await persist();
    return true;
  }

  function handleClick(button) {
    const action = String(button?.dataset?.chatAction ?? '');
    const run = async () => {
      if (action === 'start') return startRoom();
      if (action === 'next-ai') return generateNext();
      if (action === 'start-auto') return startAuto();
      if (action === 'stop-auto') return stopAuto();
      if (action === 'send-human') return sendHuman();
      if (action === 'change-topic') return changeTopic();
      if (action === 'force-speaker') return forceSpeaker(button.dataset.characterId);
      if (action === 'edit-participants') return startParticipantEdit();
      if (action === 'cancel-participant-edit') return cancelParticipantEdit();
      if (action === 'apply-participant-edit') return applyParticipantEdit();
      if (action === 'bulk-assign-profile') return applyBulkProfile();
      if (action === 'select-character-group') {
        const groupId = String(button.dataset.groupId ?? '');
        const available = getCharacterGroups().some((group) => group.id === groupId && group.enabled !== false && group.characters.some((card) => card.enabled !== false));
        if (available && groupId !== selectedCharacterGroupId) {
          selectedCharacterGroupId = groupId;
          ui.render();
        }
        return undefined;
      }
      if (action === 'new-room') return newRoom();
      if (action === 'export') return exportHistory();
      return undefined;
    };
    run().catch((error) => ui.toast(error.message, 'error'));
    return true;
  }

  refreshProfiles();
  reconcileCharacters({ announce: false }).catch((error) => ui.toast(`チャットルームの参加者同期に失敗しました: ${error.message}`, 'error', { key: 'chat-character-reconcile' }));

  return Object.freeze({
    render,
    afterRender,
    handleChange,
    handleClick,
    setAiProfiles,
    reconcileCharacters,
    stopAuto,
  });
}
