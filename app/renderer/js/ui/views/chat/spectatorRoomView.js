/**
 * 責務: 人狼観戦ルームの準備・観戦中画面を、観戦専用StateとControllerが権限制御済みの表示モデルだけから描画し、任意ログからの追っかけ開始、追っかけ/リアルタイム状態、共通の人狼卓1手ボタン、推理観戦/神視点観戦、真役職一覧、プレイヤー観戦発言UIを提供する。
 * 変更ルール: Game State・AI通信・秘密情報の抽出・ログ再生判定を行わない。追っかけ/リアルタイムはControllerから渡された表示モデルだけを描画し、モード切替selectorは作らない。観戦者内部メモは表示しない。観戦を楽しむ用途に統一し、プレイヤー入力はdata-spectator-*契約だけを持つ。
 */

import { escapeHtml } from '../../../shared/utils.js';

function profileOptions(profiles, selectedId = '') {
  return profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selectedId ? ' selected' : ''}>${escapeHtml(profile.label || profile.model || profile.id)}</option>`).join('');
}

function invalidProfileCount(participants, profiles) {
  const valid = new Set(profiles.map((profile) => profile.id));
  return participants.filter((participant) => !participant.profileId || !valid.has(participant.profileId)).length;
}

function observerRows({ groups, participants, profiles, excludedCharacterIds }) {
  const selected = new Map(participants.map((participant) => [participant.characterId, participant]));
  const excluded = new Set(excludedCharacterIds);
  return groups.filter((group) => group.enabled !== false).map((group) => {
    const rows = group.characters.filter((card) => card.enabled !== false && !excluded.has(card.id)).map((card) => {
      const participant = selected.get(card.id);
      return `<label class="chat-character-row spectator-character-row${participant ? ' selected' : ''}">
        <span class="chat-character-enabled"><input data-spectator-field="participant" data-character-id="${escapeHtml(card.id)}" type="checkbox"${participant ? ' checked' : ''}><span>観戦</span></span>
        <span class="chat-character-main"><strong>${escapeHtml(card.name)}</strong></span>
        <span class="chat-character-profile"><select data-spectator-field="participant-profile" data-character-id="${escapeHtml(card.id)}" aria-label="${escapeHtml(card.name)}のAIプロファイル"${participant ? '' : ' disabled'}><option value="">AIプロファイルを選択</option>${profileOptions(profiles, participant?.profileId ?? '')}</select></span>
      </label>`;
    }).join('');
    if (!rows) return '';
    return `<section class="chat-character-group"><h4>${escapeHtml(group.name)}</h4><div class="chat-character-list">${rows}</div></section>`;
  }).join('');
}

export function renderSpectatorRoomSetup({ state, groups, profiles, profileLoading = false, excludedCharacterIds = [], bulkProfileId = '', gameView = {} }) {
  const participantCount = state.participants.length;
  const missingProfiles = invalidProfileCount(state.participants, profiles);
  const gameReady = gameView.status && gameView.status !== 'setup';
  const ready = participantCount >= 2 && missingProfiles === 0 && !profileLoading && gameReady;
  const omniscient = state.observationMode === 'omniscient';
  const latestLogNumber = Math.max(0, Number(gameView.latestEventSequence ?? 0) || 0);
  const startLogNumber = state.startLogNumber ?? (latestLogNumber + 1);
  return `<section class="page chat-room-page spectator-room-page">
    <div class="page-head">
      <div><span class="eyebrow">WEREWOLF SPECTATOR</span><h2>人狼観戦</h2><p>${omniscient ? '真役職を知る神視点で、展開や認識のずれも含めてキャラクター同士で観戦を楽しみます。' : '進行中の公開表示だけを読み、予想も交えながらキャラクター同士で観戦を楽しみます。'}</p></div>
      <div class="chat-room-status-pills"><span class="status-pill">${escapeHtml(gameView.title || 'ゲーム未開始')}</span><span class="status-pill">${gameReady ? `Day ${escapeHtml(String(gameView.day ?? 0))} · ${escapeHtml(gameView.phaseLabel ?? '')}` : '開始待ち'}</span></div>
    </div>
    <div class="chat-setup-layout">
      <section class="panel chat-room-settings-panel spectator-settings-panel">
        <div class="panel-head"><div><span class="eyebrow">SPECTATOR SETTINGS</span><h3>観戦設定</h3></div><small>${omniscient ? '真役職・現在陣営を開示' : '公開情報だけを使用'}</small></div>
        <div class="form-grid spectator-settings-form">
          <label class="field"><span>プレイヤー名</span><input data-spectator-field="player-name" type="text" maxlength="80" value="${escapeHtml(state.playerName || 'プレイヤー')}" placeholder="プレイヤー"></label>
          <label class="field"><span>観戦スタイル</span><select data-spectator-field="observation-mode"><option value="deduction"${!omniscient ? ' selected' : ''}>推理観戦</option><option value="omniscient"${omniscient ? ' selected' : ''}>神視点観戦</option></select><small>${omniscient ? '真役職・現在陣営を知った状態で展開を楽しみます。' : '公開情報だけを見ながら予想も交えて観戦します。'}</small></label>
          <label class="field"><span>実況開始ログ番号</span><input data-spectator-field="start-log-number" type="number" min="1" step="1" value="${escapeHtml(String(startLogNumber))}"><small>現在の最新ログ: #${escapeHtml(String(latestLogNumber))}。最新より後を指定するとリアルタイム実況を開始します。</small></label>
          <label class="field"><span>反応頻度</span><select data-spectator-field="reaction-level"><option value="quiet"${state.reactionLevel === 'quiet' ? ' selected' : ''}>静か</option><option value="standard"${state.reactionLevel === 'standard' ? ' selected' : ''}>標準</option><option value="lively"${state.reactionLevel === 'lively' ? ' selected' : ''}>活発</option></select></label>
          <label class="switch-field"><input data-spectator-field="auto-comment" type="checkbox"${state.autoComment ? ' checked' : ''}><span><strong>観戦コメントを自動生成</strong><small>表示した公開ログへの観戦AI反応を自動生成します。追っかけ中のログ送り自体は手動です。</small></span></label>
        </div>
        <div class="validation ${ready ? 'success' : 'warning'}">${profileLoading ? 'AIプロファイルを読み込んでいます。' : !gameReady ? '人狼ゲームを開始すると観戦を開始できます。' : participantCount < 2 ? '対戦参加者以外から観戦キャラクターを2人以上選択してください。' : missingProfiles ? `AIプロファイル未設定または利用不可の観戦者が${missingProfiles}人います。` : omniscient ? '神視点観戦を開始できます。指定ログから追っかける場合も、その時点の公開盤面と確定済み陣営だけを使用します。' : '推理観戦を開始できます。指定ログから1件ずつ追っかけ、最新到達後はリアルタイムへ合流します。'}</div>
        <div class="panel-actions"><button class="button primary" data-spectator-action="start" type="button"${ready ? '' : ' disabled'}>${omniscient ? '神視点観戦開始' : '推理観戦開始'}</button></div>
      </section>
      <section class="panel chat-participant-picker">
        <div class="panel-head"><div><span class="eyebrow">OBSERVERS</span><h3>観戦キャラクター</h3></div><small>現在の対戦参加キャラクターは自動除外</small></div>
        <div class="ai-bulk-assignment chat-ai-bulk-assignment">
          <span class="ai-bulk-assignment-label">AIプロファイル一括適用</span>
          <div class="ai-bulk-assignment-controls"><select data-spectator-field="bulk-profile" aria-label="観戦者へ一括設定するAIプロファイル"${profiles.length ? '' : ' disabled'}><option value="">プロファイルを選択</option>${profileOptions(profiles, bulkProfileId)}</select><button class="button ghost" data-spectator-action="bulk-assign-profile" type="button"${participantCount && profiles.length && !profileLoading ? '' : ' disabled'}>観戦者へ適用</button></div>
        </div>
        ${observerRows({ groups, participants: state.participants, profiles, excludedCharacterIds }) || '<p class="empty-state">観戦に利用できる非参加キャラクターがありません。</p>'}
      </section>
    </div>
  </section>`;
}

function spectatorMessageHtml(message) {
  if (message.kind === 'system') return `<div class="chat-system-message"><span>#${message.sequence}</span>${escapeHtml(message.text)}</div>`;
  if (message.kind === 'public') return `<div class="spectator-public-update"><span>PUBLIC · #${message.sequence}</span><p>${escapeHtml(message.text)}</p></div>`;
  const target = message.kind === 'human' && message.targetName ? `<span class="chat-message-target">→ ${escapeHtml(message.targetName)}</span>` : '';
  const meta = message.kind === 'human' ? 'PLAYER' : 'AI';
  const classes = message.kind === 'human' ? 'chat-message human spectator-human-message' : 'chat-message ai spectator-ai-message';
  return `<article class="${classes}"><header><div><strong>${escapeHtml(message.speakerName || (message.kind === 'human' ? 'プレイヤー' : '観戦者'))}</strong>${target}</div><span>#${message.sequence} · ${meta}</span></header><p>${escapeHtml(message.text).replaceAll('\n', '<br>')}</p></article>`;
}

function observerParticipantRows({ state, cards, profiles, nextSpeakerId }) {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return state.participants.map((participant) => {
    const card = cardById.get(participant.characterId);
    if (!card) return '';
    const pending = state.unresolvedQuestions.filter((item) => item.targetId === participant.characterId).length;
    const profile = profileById.get(participant.profileId);
    return `<div class="chat-participant-row${participant.characterId === nextSpeakerId ? ' next' : ''}"><div><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(profile?.label ?? 'AI未設定')}${pending ? ` · 未回答${pending}` : ''}</small></div><button class="button ghost small" data-spectator-action="force-speaker" data-character-id="${escapeHtml(card.id)}" type="button">次に話す</button></div>`;
  }).join('');
}

function revealedRoleRows(publicView = {}) {
  const rows = Array.isArray(publicView.revealedRoles) ? publicView.revealedRoles : [];
  if (!rows.length) return '<p class="empty-state">真役職情報はありません。</p>';
  return `<div class="spectator-role-reveal-list">${rows.map((player) => `<div class="spectator-role-reveal-row"><span>${escapeHtml(player.name)}</span><strong>${escapeHtml(player.roleName)} · ${escapeHtml(player.teamName)}</strong></div>`).join('')}</div>`;
}

export function renderSpectatorRoomLive({ state, groups, profiles, generating = false, autoDraining = false, nextTurn = null, publicView = {} }) {
  const omniscient = state.observationMode === 'omniscient';
  const cards = groups.flatMap((group) => group.characters);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const nextCard = nextTurn?.speakerId ? cardById.get(nextTurn.speakerId) : null;
  const nextLabel = nextTurn?.kind === 'answer' ? '質問回答' : nextTurn?.kind === 'manual' ? '手動指定' : '公開反応';
  const pendingTurns = state.priorityTurns.length + state.reactionTurns.length;
  const invalidProfiles = invalidProfileCount(state.participants, profiles);
  const generationIssue = state.participants.length < 2 ? '観戦を続けるには観戦キャラクターを2人以上にしてください。' : invalidProfiles ? `AIプロファイル未設定または利用不可の観戦者が${invalidProfiles}人います。` : '';
  const followingLive = publicView.followingLive !== false;
  const latestEventSequence = Math.max(0, Number(publicView.latestEventSequence ?? 0) || 0);
  const nextEventSequence = publicView.nextEventSequence === null || publicView.nextEventSequence === undefined ? null : Math.max(0, Number(publicView.nextEventSequence) || 0);
  const playbackStatus = followingLive ? '● リアルタイム' : `追っかけ · 次 #${nextEventSequence ?? '-'} / 最新 #${latestEventSequence}`;
  const syncLabel = followingLive ? '公開表示を再同期' : 'リアルタイムへ移動';
  const boardTitle = followingLive ? '現在の公開盤面' : '再生中の公開盤面';
  return `<section class="page chat-room-page chat-room-live spectator-room-page spectator-room-live">
    <div class="page-head">
      <div><span class="eyebrow">WEREWOLF SPECTATOR</span><h2>人狼観戦</h2><p>${escapeHtml(state.sourceGameTitle || publicView.title || 'AI人狼')} · ${omniscient ? '神視点観戦 · 真役職開示' : '推理観戦 · 公開情報のみ'}</p></div>
      <div class="page-head-actions"><button class="button primary" data-spectator-action="advance-game-one" type="button"${generating || autoDraining ? ' disabled' : ''}>人狼卓を1手進める</button><button class="button ghost" data-spectator-action="sync-public" type="button">${syncLabel}</button><button class="button danger-ghost" data-spectator-action="new-room" type="button">観戦を終了</button></div>
    </div>
    <div class="chat-live-layout">
      <section class="panel chat-log-panel">
        <div class="chat-log-head"><div><span class="status-pill">${omniscient ? '神視点' : '推理'}</span><span class="status-pill">${escapeHtml(playbackStatus)}</span><span class="status-pill">Day ${escapeHtml(String(publicView.day ?? 0))} · ${escapeHtml(publicView.phaseLabel ?? '')}</span><span class="status-pill">待機 ${pendingTurns}</span><span class="status-pill">次：${escapeHtml(nextCard?.name ?? '未定')} · ${escapeHtml(nextLabel)}</span></div><div>${generating ? '<span class="chat-generating">観戦AI生成中…</span>' : autoDraining ? '<span class="chat-generating">コメント自動生成中</span>' : ''}</div></div>
        <div class="chat-log" data-spectator-log>${state.messages.length ? state.messages.map(spectatorMessageHtml).join('') : '<div class="empty-state">まだ観戦コメントはありません。</div>'}</div>
        <div class="chat-controls"><button class="button primary" data-spectator-action="next-ai" type="button"${generating || autoDraining || generationIssue ? ' disabled' : ''}>次の観戦コメント</button>${state.autoComment ? '<span class="spectator-follow-note">観戦コメント自動生成ON</span>' : '<span class="spectator-follow-note muted">観戦コメント自動生成OFF</span>'}</div>
        ${generationIssue ? `<div class="validation warning">${escapeHtml(generationIssue)}</div>` : ''}
        <div class="chat-player-box spectator-player-box">
          <div class="chat-player-identity">${escapeHtml(state.playerName || 'プレイヤー')}として観戦チャットへ発言</div>
          <div class="chat-player-row"><label><span>発言先</span><select data-spectator-field="human-target"><option value="">全員</option>${state.participants.map((participant) => { const card = cardById.get(participant.characterId); return card ? `<option value="${escapeHtml(card.id)}">${escapeHtml(card.name)}</option>` : ''; }).join('')}</select></label></div>
          <div class="spectator-player-compose"><textarea data-spectator-field="human-message" rows="2" maxlength="2000" placeholder="観戦者として感想・予想・質問などを書けます。特定の観戦者を選ぶと、そのキャラクターの専用回答ターンを追加します。"></textarea><button class="button primary spectator-send-button" data-spectator-action="send-human" type="button"${generating ? ' disabled' : ''}>送信</button></div>
        </div>
      </section>
      <aside class="chat-side-column spectator-side-column">
        <section class="panel spectator-observers-panel"><div class="panel-head"><div><span class="eyebrow">OBSERVERS</span><h3>観戦者</h3></div></div><div class="chat-participant-list">${observerParticipantRows({ state, cards, profiles, nextSpeakerId: nextTurn?.speakerId ?? null })}</div></section>
        <section class="panel spectator-public-board"><div class="panel-head"><div><span class="eyebrow">PUBLIC BOARD</span><h3>${escapeHtml(boardTitle)}</h3></div></div><div class="spectator-public-board-scroll"><dl><div><dt>局面</dt><dd>Day ${escapeHtml(String(publicView.day ?? 0))} · ${escapeHtml(publicView.phaseLabel ?? '')}</dd></div><div><dt>生存</dt><dd>${escapeHtml(String(publicView.aliveCount ?? 0))}人</dd></div><div><dt>死亡</dt><dd>${escapeHtml(String(publicView.deadCount ?? 0))}人</dd></div><div><dt>CO</dt><dd>${escapeHtml(String(publicView.claimCount ?? 0))}件</dd></div><div><dt>能力結果</dt><dd>${escapeHtml(String(publicView.abilityClaimCount ?? 0))}件</dd></div></dl>${omniscient ? `<div class="spectator-role-reveal"><div class="spectator-role-reveal-head"><span>GOD VIEW</span><strong>真役職・現在陣営</strong></div>${revealedRoleRows(publicView)}</div>` : ''}</div><div class="spectator-live-settings"><label class="switch-field spectator-live-switch"><input data-spectator-field="auto-comment" type="checkbox"${state.autoComment ? ' checked' : ''}><span><strong>観戦コメントを自動生成</strong><small>表示した公開ログへの反応だけを自動生成</small></span></label><label class="field"><span>反応頻度</span><select data-spectator-field="reaction-level"><option value="quiet"${state.reactionLevel === 'quiet' ? ' selected' : ''}>静か</option><option value="standard"${state.reactionLevel === 'standard' ? ' selected' : ''}>標準</option><option value="lively"${state.reactionLevel === 'lively' ? ' selected' : ''}>活発</option></select></label></div></section>
      </aside>
    </div>
  </section>`;
}
