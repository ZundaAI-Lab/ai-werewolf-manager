/**
 * 責務: チャットルームの準備画面・参加者編集画面・会話画面をHTMLへ描画する。準備画面と参加者編集画面のキャラクター選択は、左の有効グループ一覧と右の選択グループ内キャラクター一覧へ分離し、参加者は1人1行で表示する。参加者行は名前と幅を制限したAIプロファイル選択だけを表示し、プロフィール本文は表示しない。会話画面では次ターンが通常巡回か質問回答かを表示する。
 * 変更ルール: 会話順、優先ターン生成、AI通信、保存、選択グループ状態の保持を実行しない。data-chat-*属性だけをControllerとの操作契約とし、人狼進行用data-actionへチャット操作を混在させない。AIプロファイルは現在利用可能なIDとの一致で有効性を表示判定し、削除・無効化済みIDを選択済みとして扱わない。キャラクター選択では有効グループ・有効キャラクターだけを表示し、グループ選択状態はControllerから受け取る。会話中の参加者編集は履歴を消す操作と混同せず、AIプロファイル一括適用を含む表示契約だけを持ち、適用処理はControllerへ委譲する。
 */

import { escapeHtml, formatDateTime } from '../../../shared/utils.js';

function profileOptions(profiles, selectedId) {
  const enabled = profiles.filter((profile) => profile.enabled !== false);
  if (!enabled.length) return '<option value="">利用可能なAIプロファイルなし</option>';
  return enabled.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selectedId ? ' selected' : ''}>${escapeHtml(profile.label)} / ${escapeHtml(profile.model || profile.provider)}</option>`).join('');
}

function invalidProfileCount(participants, profiles) {
  const validIds = new Set(profiles.filter((profile) => profile.enabled !== false).map((profile) => profile.id));
  return participants.filter((participant) => !participant.profileId || !validIds.has(participant.profileId)).length;
}

function selectableGroups(groups) {
  return groups.filter((group) => group.enabled !== false && group.characters.some((card) => card.enabled !== false));
}

function selectedGroup(groups, selectedGroupId) {
  const available = selectableGroups(groups);
  return available.find((group) => group.id === selectedGroupId) ?? available[0] ?? null;
}

function participantGroupList({ groups, participants, selectedGroupId }) {
  const selectedIds = new Set(participants.map((participant) => participant.characterId));
  return selectableGroups(groups).map((group) => {
    const cards = group.characters.filter((card) => card.enabled !== false);
    const selectedCount = cards.filter((card) => selectedIds.has(card.id)).length;
    const active = group.id === selectedGroupId;
    return `<button class="chat-character-group-list-item${active ? ' is-selected' : ''}" data-chat-action="select-character-group" data-group-id="${escapeHtml(group.id)}" type="button" aria-pressed="${active ? 'true' : 'false'}">
      <span class="chat-character-group-list-copy"><strong>${escapeHtml(group.name)}</strong><small>${selectedCount}/${cards.length}人参加</small></span>
    </button>`;
  }).join('');
}

function participantCharacterRows({ group, participants, profiles }) {
  if (!group) return '<p class="empty-state">利用できるキャラクターがありません。</p>';
  const selected = new Map(participants.map((item) => [item.characterId, item.profileId]));
  const cards = group.characters.filter((card) => card.enabled !== false);
  if (!cards.length) return '<p class="empty-state">このグループに利用できるキャラクターがありません。</p>';
  return `<div class="chat-character-list">
    ${cards.map((card) => {
      const isChecked = selected.has(card.id);
      const profileId = selected.get(card.id) ?? '';
      return `<div class="chat-character-row${isChecked ? ' selected' : ''}">
        <label class="chat-character-enabled" title="このキャラクターをチャットへ参加させます">
          <input type="checkbox" data-chat-field="participant" data-character-id="${escapeHtml(card.id)}"${isChecked ? ' checked' : ''}>
          <span>参加</span>
        </label>
        <div class="chat-character-main"><strong title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</strong></div>
        <label class="chat-character-profile"><select data-chat-field="participant-profile" data-character-id="${escapeHtml(card.id)}" aria-label="${escapeHtml(card.name)}のAIプロファイル"${isChecked ? '' : ' disabled'}>
          <option value="">AIプロファイルを選択</option>
          ${profileOptions(profiles, profileId)}
        </select></label>
      </div>`;
    }).join('')}
  </div>`;
}

function participantPickerWorkspace({ groups, participants, profiles, selectedGroupId }) {
  const group = selectedGroup(groups, selectedGroupId);
  if (!group) return '<p class="empty-state">利用できるキャラクターがありません。</p>';
  const activeGroupId = group.id;
  const availableCards = group.characters.filter((card) => card.enabled !== false);
  const selectedIds = new Set(participants.map((participant) => participant.characterId));
  const selectedCount = availableCards.filter((card) => selectedIds.has(card.id)).length;
  return `<div class="chat-character-picker-workspace">
    <aside class="chat-character-picker-sidebar" aria-label="キャラクターグループ一覧">
      <div class="chat-character-group-list">${participantGroupList({ groups, participants, selectedGroupId: activeGroupId })}</div>
    </aside>
    <section class="chat-character-group-panel">
      <header class="chat-character-group-panel-head">
        <div><span class="eyebrow">GROUP</span><h4>${escapeHtml(group.name)}</h4></div>
        <small>${selectedCount}/${availableCards.length}人参加</small>
      </header>
      <div class="chat-character-group-panel-body">${participantCharacterRows({ group, participants, profiles })}</div>
    </section>
  </div>`;
}

export function renderChatRoomSetup({ state, groups, profiles, profileLoading = false, bulkProfileId = '', selectedGroupId = '' }) {
  const participantCount = state.participants.length;
  const missingProfiles = invalidProfileCount(state.participants, profiles);
  return `<section class="page chat-room-page">
    <div class="page-head">
      <div><span class="eyebrow">自由会話</span><h2>チャットルーム</h2><p>登録済みキャラクター同士で、人狼とは無関係の会話を行います。</p></div>
      <div class="chat-room-status-pills"><span class="status-pill">参加 ${participantCount}人</span><span class="status-pill">質問優先 ${state.questionPriority ? 'ON' : 'OFF'}</span></div>
    </div>
    <div class="chat-setup-layout">
      <section class="panel chat-room-settings-panel">
        <div class="panel-head"><div><span class="eyebrow">ROOM SETUP</span><h3>会話設定</h3></div></div>
        <div class="form-grid two-columns">
          <label class="field"><span>プレイヤー名</span><input data-chat-field="player-name" type="text" maxlength="80" value="${escapeHtml(state.playerName)}" placeholder="プレイヤー"></label>
          <label class="field"><span>発言順</span><select data-chat-field="speaker-mode"><option value="random"${state.speakerMode === 'random' ? ' selected' : ''}>巡回ごとにランダム</option><option value="fixed"${state.speakerMode === 'fixed' ? ' selected' : ''}>選択順で固定</option></select></label>
          <label class="field full"><span>お題 <small>任意</small></span><input data-chat-field="topic" type="text" maxlength="240" value="${escapeHtml(state.topic)}" placeholder="例：夏休みにやりたいこと"></label>
          <label class="field"><span>自動会話の一区切り</span><input data-chat-field="auto-batch-size" type="number" min="1" max="100" value="${state.autoBatchSize}"></label>
          <label class="switch-field full"><input data-chat-field="question-priority" type="checkbox"${state.questionPriority ? ' checked' : ''}><span><strong>AI質問への専用回答を優先</strong><small>AI同士の明示的な質問は質問1件ごとに回答ターンを追加し、通常巡回の発言枠は残します。プレイヤーの特定キャラ指定はこの設定に関係なく回答ターンを追加します。</small></span></label>
        </div>
        <div class="validation ${participantCount >= 2 && missingProfiles === 0 ? 'success' : 'warning'}">
          ${profileLoading ? 'AIプロファイルを読み込んでいます。' : participantCount < 2 ? '2人以上のキャラクターを選択してください。' : missingProfiles ? `AIプロファイル未設定または利用不可の参加者が${missingProfiles}人います。` : state.topic ? '開始できます。設定したお題から自由に会話を始めます。' : '開始できます。お題なしで自由に会話します。'}
        </div>
        <div class="panel-actions"><button class="button primary" data-chat-action="start" type="button"${participantCount >= 2 && missingProfiles === 0 && !profileLoading ? '' : ' disabled'}>チャットを開始</button></div>
      </section>
      <section class="panel chat-participant-picker">
        <div class="panel-head"><div><span class="eyebrow">CHARACTERS</span><h3>参加キャラクター</h3></div><small>キャラクター管理で有効なデータを使用</small></div>
        <div class="ai-bulk-assignment chat-ai-bulk-assignment">
          <span class="ai-bulk-assignment-label">AIプロファイル一括適用</span>
          <div class="ai-bulk-assignment-controls"><select data-chat-field="bulk-profile" aria-label="参加キャラクターへ一括設定するAIプロファイル"${profiles.length ? '' : ' disabled'}><option value="">プロファイルを選択</option>${profileOptions(profiles, bulkProfileId)}</select><button class="button ghost" data-chat-action="bulk-assign-profile" type="button"${participantCount && profiles.length && !profileLoading ? '' : ' disabled'}>参加キャラクターへ適用</button></div>
          <p class="ai-bulk-assignment-note">選択中の参加キャラクター${participantCount}名の個別AIプロファイルを、選択したプロファイルで上書きします。</p>
        </div>
        ${participantPickerWorkspace({ groups, participants: state.participants, profiles, selectedGroupId })}
      </section>
    </div>
  </section>`;
}

export function renderChatRoomParticipantEdit({ state, participants, groups, profiles, profileLoading = false, bulkProfileId = '', selectedGroupId = '' }) {
  const participantCount = participants.length;
  const missingProfiles = invalidProfileCount(participants, profiles);
  const ready = participantCount >= 2 && missingProfiles === 0 && !profileLoading;
  return `<section class="page chat-room-page chat-participant-edit-page">
    <div class="page-head">
      <div><span class="eyebrow">CHAT SESSION</span><h2>参加者を変更</h2><p>現在の会話履歴・お題・プレイヤー名を維持したまま参加キャラクターを変更します。</p></div>
      <div class="page-head-actions"><button class="button ghost" data-chat-action="cancel-participant-edit" type="button">キャンセル</button><button class="button primary" data-chat-action="apply-participant-edit" type="button"${ready ? '' : ' disabled'}>変更を適用</button></div>
    </div>
    <section class="panel chat-participant-picker">
      <div class="panel-head"><div><span class="eyebrow">CHARACTERS</span><h3>参加キャラクター</h3></div><small>過去ログは削除されません</small></div>
      <div class="ai-bulk-assignment chat-ai-bulk-assignment">
        <span class="ai-bulk-assignment-label">AIプロファイル一括適用</span>
        <div class="ai-bulk-assignment-controls"><select data-chat-field="bulk-profile" aria-label="参加キャラクターへ一括設定するAIプロファイル"${profiles.length ? '' : ' disabled'}><option value="">プロファイルを選択</option>${profileOptions(profiles, bulkProfileId)}</select><button class="button ghost" data-chat-action="bulk-assign-profile" type="button"${participantCount && profiles.length && !profileLoading ? '' : ' disabled'}>参加キャラクターへ適用</button></div>
        <p class="ai-bulk-assignment-note">選択中の参加キャラクター${participantCount}名の個別AIプロファイルを、選択したプロファイルで上書きします。</p>
      </div>
      <div class="validation ${ready ? 'success' : 'warning'}">${profileLoading ? 'AIプロファイルを読み込んでいます。' : participantCount < 2 ? '会話を続けるには2人以上のキャラクターを選択してください。' : missingProfiles ? `AIプロファイル未設定または利用不可の参加者が${missingProfiles}人います。` : `現在の履歴${state.messages.length}件を保持したまま変更できます。`}</div>
      ${participantPickerWorkspace({ groups, participants, profiles, selectedGroupId })}
    </section>
  </section>`;
}

function messageHtml(message, cardById) {
  if (message.kind === 'system') return `<div class="chat-system-message"><span>#${message.sequence}</span>${escapeHtml(message.text)}</div>`;
  const card = cardById.get(message.speakerId);
  const target = message.targetName ? `<span class="chat-message-target">→ ${escapeHtml(message.targetName)}</span>` : '';
  const meta = message.kind === 'human' ? 'PLAYER' : 'AI';
  return `<article class="chat-message ${message.kind}">
    <header><div><strong>${escapeHtml(message.speakerName || card?.name || '不明')}</strong>${target}</div><span>#${message.sequence} · ${meta} · ${escapeHtml(formatDateTime(message.createdAt))}</span></header>
    <p>${escapeHtml(message.text).replaceAll('\n', '<br>')}</p>
  </article>`;
}

function participantRows({ state, cardById, profiles, nextSpeakerId }) {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return state.participants.map((participant) => {
    const card = cardById.get(participant.characterId);
    if (!card) return '';
    const profile = profileById.get(participant.profileId);
    const pending = state.unresolvedQuestions.filter((item) => item.targetId === participant.characterId).length;
    const queueIndex = state.queue.indexOf(participant.characterId);
    return `<div class="chat-participant-row${participant.characterId === nextSpeakerId ? ' next' : ''}">
      <div><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(profile?.label ?? 'AI未設定')}${pending ? ` · 未回答${pending}` : ''}${queueIndex >= 0 ? ` · 待機${queueIndex + 1}` : ''}</small></div>
      <button class="button ghost small" data-chat-action="force-speaker" data-character-id="${escapeHtml(card.id)}" type="button">次に話す</button>
    </div>`;
  }).join('');
}

export function renderChatRoomLive({ state, groups, profiles, generating = false, autoRunning = false, nextTurn = null }) {
  const cards = groups.flatMap((group) => group.characters);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const nextSpeakerId = nextTurn?.speakerId ?? null;
  const nextCard = nextSpeakerId ? cardById.get(nextSpeakerId) : null;
  const nextTurnLabel = nextTurn?.kind === 'answer' ? '質問回答' : nextTurn?.kind === 'manual' ? '手動指定' : '通常巡回';
  const invalidProfiles = invalidProfileCount(state.participants, profiles);
  const generationIssue = state.participants.length < 2
    ? 'AI発言を続けるには参加キャラクターを2人以上にしてください。'
    : invalidProfiles ? `AIプロファイル未設定または利用不可の参加者が${invalidProfiles}人います。参加者を変更してください。` : '';
  return `<section class="page chat-room-page chat-room-live">
    <div class="page-head">
      <div><span class="eyebrow">CHAT SESSION</span><h2>チャットルーム</h2><p>${state.topic ? `お題：${escapeHtml(state.topic)}` : 'お題なし・自由会話'}</p></div>
      <div class="page-head-actions"><button class="button ghost" data-chat-action="export" type="button">履歴JSON出力</button><button class="button danger-ghost" data-chat-action="new-room" type="button">新しいチャット</button></div>
    </div>
    <div class="chat-live-layout">
      <section class="panel chat-log-panel">
        <div class="chat-log-head"><div><span class="status-pill">第${state.round}巡</span><span class="status-pill">次：${escapeHtml(nextCard?.name ?? '未定')} · ${escapeHtml(nextTurnLabel)}</span></div><div>${generating ? '<span class="chat-generating">AI生成中…</span>' : autoRunning ? '<span class="chat-generating">自動会話中</span>' : ''}</div></div>
        <div class="chat-log" data-chat-log>${state.messages.length ? state.messages.map((message) => messageHtml(message, cardById)).join('') : '<div class="empty-state">まだ発言はありません。</div>'}</div>
        <div class="chat-controls">
          <button class="button primary" data-chat-action="next-ai" type="button"${generating || autoRunning || generationIssue ? ' disabled' : ''}>次のAI発言</button>
          ${autoRunning ? '<button class="button danger" data-chat-action="stop-auto" type="button">自動会話を停止</button>' : `<button class="button ghost" data-chat-action="start-auto" type="button"${generating || generationIssue ? ' disabled' : ''}>▶ 自動会話 ${state.autoBatchSize}発言</button>`}
        </div>
        ${generationIssue ? `<div class="validation warning">${escapeHtml(generationIssue)}</div>` : ''}
        <div class="chat-player-box">
          <div class="chat-player-identity">${escapeHtml(state.playerName || 'プレイヤー')}として発言</div>
          <div class="chat-player-row"><label><span>発言先</span><select data-chat-field="human-target"><option value="">全員</option>${state.participants.map((participant) => { const card = cardById.get(participant.characterId); return card ? `<option value="${escapeHtml(card.id)}">${escapeHtml(card.name)}</option>` : ''; }).join('')}</select></label></div>
          <textarea data-chat-field="human-message" rows="3" maxlength="2000" placeholder="プレイヤーとして自由に発言できます。特定キャラを選ぶと、その発言への専用回答ターンを追加します。"></textarea>
          <div class="panel-actions"><button class="button primary" data-chat-action="send-human" type="button">送信</button></div>
        </div>
      </section>
      <aside class="chat-side-column">
        <section class="panel"><div class="panel-head"><div><span class="eyebrow">PARTICIPANTS</span><h3>参加者・発言順</h3></div><button class="button ghost small" data-chat-action="edit-participants" type="button"${generating || autoRunning ? ' disabled' : ''}>参加者を変更</button></div><div class="chat-participant-list">${participantRows({ state, cardById, profiles, nextSpeakerId })}</div></section>
        <section class="panel"><div class="panel-head"><div><span class="eyebrow">TOPIC</span><h3>お題を変更</h3></div></div><label class="field"><input data-chat-field="live-topic" type="text" maxlength="240" value="${escapeHtml(state.topic)}" placeholder="空欄でお題なし"></label><div class="panel-actions"><button class="button ghost" data-chat-action="change-topic" type="button">お題を反映</button></div></section>
      </aside>
    </div>
  </section>`;
}
