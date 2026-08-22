/**
 * 責務: 自動API実行方式の進行卓で、手動進行卓と同じ3パネル骨格を保ちながら中央パネルへ公開ログだけを表示し、表示更新とスクロール位置を管理する。
 * 変更ルール: 進行卓の通常表示方式はexecutionModeを正本とし、automatic選択時は実行開始前・一時停止中も自動実行用進行卓を表示する。人間操作待ちは通常進行卓へ遷移させず公開ログ末尾へHuman Task Cardを差し込み、役職通知だけ共通ダイアログへ委譲する。自動実行ステータスと実行操作は共通ヘッダーへ委譲し、中央パネルへ重複表示しない。機密情報非表示中の夜フェーズでは現在行動者をプレイヤー状態へ強調表示せず、処理順から役職を推測できないようにする。投票済表示は現在日の投票・決選投票フェーズだけに限定し、保持中の過去voteSessionを表示根拠にしない。ゲーム状態を直接変更しない。
 */

export function createLiveProgressController(context) {
  const {
    PHASE_LABELS,
    activeTab,
    controller,
    currentGameState,
    delay,
    escapeHtml,
    runtime,
  } = context;

  function publishedPublicEvents(state) {
      return (state?.events ?? [])
        .filter((event) => event.status === 'published' && event.audience?.type === 'public')
        .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
    }

  function publicEventText(state, event) {
      const payload = event.payload ?? {};
      if (payload.text) return String(payload.text);
      if (event.type === 'vote-finalized') {
        const name = (id) => state.players?.find((player) => player.id === id)?.name ?? '不明';
        return (payload.tally ?? []).map((item) => `${name(item.targetId)} ${item.count}票`).join('、') || '投票結果を確定しました。';
      }
      const labels = {
        execution: '処刑結果を公開しました。',
        dawn: '夜明けの結果を公開しました。',
        'game-result': 'ゲーム結果を公開しました。',
        correction: '公開記録を訂正しました。',
        system: 'ゲームを進行しました。',
      };
      return labels[event.type] ?? String(event.type ?? '公開更新');
    }

  function pendingHumanTask(state) {
      if (!controller.waitingHuman || !controller.pendingHumanTask) return null;
      const current = runtime().getCurrentWorkbenchTask() ?? {};
      const pending = controller.pendingHumanTask;
      return {
        ...current,
        type: pending.taskType || current.type,
        playerId: pending.playerId || current.playerId,
        slotId: pending.slotId || current.slotId || '',
        questionEventId: pending.questionEventId || current.questionEventId || current.slotId || '',
        conversationId: pending.conversationId || current.conversationId || '',
      };
    }

  function phaseSteps(state) {
      const phase = state?.game?.phase;
      const sequence = phase === 'night'
        ? [
          ...(state?.night?.plan?.graveyardConversationRequired ? ['墓場会話'] : []),
          ...(state?.night?.plan?.masonConversationRequired ? ['共有者共有会話'] : []),
          ...(state?.night?.plan?.wolfConversationRequired ? ['人狼共有会話'] : []),
          '襲撃', '個人夜行動', '夜行動解決', '夜明け公開',
        ]
        : ['役職通知', '昼議論', '投票', '処刑', '夜', '結果公開・感想'];
      const active = (label) => (
        (phase === 'briefing' && label === '役職通知')
        || (phase === 'discussion' && label === '昼議論')
        || ((phase === 'vote' || phase === 'runoff') && label === '投票')
        || (phase === 'execution' && label === '処刑')
        || (phase === 'night' && ['墓場会話', '共有者共有会話', '人狼共有会話', '襲撃', '個人夜行動', '夜行動解決'].includes(label))
        || (phase === 'dawn' && label === '夜明け公開')
        || ((phase === 'result' || phase === 'ended') && label === '結果公開・感想')
      );
      return `<ol class="step-list">${sequence.map((label) => `<li class="${active(label) ? 'active' : ''}"><span>${active(label) ? '▶' : '・'}</span>${label}</li>`).join('')}</ol>`;
    }

  function ruleStrip(state) {
      const rules = state?.game?.rules;
      if (!rules) return '';
      return [
        rules.vote.visibilityDuringInput === 'secret' ? '秘密投票' : '公開投票',
        rules.vote.selfVoteAllowed ? '自己投票可' : '自己投票不可',
        rules.vote.abstentionAllowed ? '棄権可' : '棄権不可',
        `決選${rules.vote.runoffLimit}回・${rules.vote.tieResolution === 'random-execution' ? 'ランダム吊り' : '吊りなし'}`,
        rules.guard.consecutiveGuardAllowed ? '連続護衛可' : '連続護衛不可',
        rules.testament?.enabled ? '遺言あり' : '遺言なし',
        rules.graveyardCommunication?.enabled ? `墓場会話・各${rules.graveyardCommunication.speechCountPerNight}回` : '墓場会話なし',
        rules.masonCommunication.enabled ? `共有者会話・各${rules.masonCommunication.speechCountPerNight}回` : '共有者会話なし',
        rules.wolfCommunication.enabled
          ? `${rules.wolfCommunication.participantMode === 'wolves-and-madman' ? '人狼＋狂人会話' : '人狼会話'}・各${rules.wolfCommunication.speechCountPerNight}回`
          : '人狼会話なし',
      ].map((item) => `<span>${escapeHtml(item)}</span>`).join('');
    }

  function playerStatusList(state) {
      const currentTask = runtime().getCurrentWorkbenchTask();
      const hideNightActorMarker = state?.game?.phase === 'night' && !controller.showConfidential;
      return `<div class="status-list">${(state?.players ?? []).map((player) => {
        const active = !hideNightActorMarker && currentTask?.playerId === player.id;
        const remaining = state?.discussion?.remainingByPlayer?.[player.id];
        const voteDone = ['vote', 'runoff'].includes(state?.game?.phase)
          && state?.voteSession?.day === state?.game?.day
          && Boolean(state?.voteSession?.votes && player.id in state.voteSession.votes);
        const claim = (state?.claims ?? []).find((item) => item.actorId === player.id && item.status === 'active');
        const frozen = runtime().isWorkbenchPlayerFrozen(player.id);
        return `<button class="status-row ${active ? 'active' : ''} ${player.alive ? '' : 'dead'} ${frozen ? 'frozen' : ''}" data-action="inspect-player" data-player-id="${escapeHtml(player.id)}" type="button"><span class="status-symbol">${active ? '▶' : player.alive ? '○' : '×'}</span><span class="status-main"><strong>${escapeHtml(player.name)}</strong><small>${player.controller === 'ai' ? 'AI' : '人間'}${frozen ? '・凍結中' : ''}${remaining !== undefined && remaining !== null ? `・残${remaining}` : ''}${voteDone ? '・投票済' : ''}${claim ? `・${escapeHtml(runtime().getRoleDisplayName(claim.roleId))}CO` : ''}</small></span>${controller.showConfidential ? `<span class="secret-role">${escapeHtml(runtime().getRoleDisplayName(player.roleId))}</span>` : ''}</button>`;
      }).join('')}</div>`;
    }

  function renderLiveView(state) {
      const snapshot = runtime().getPublicSnapshot({ includeConfidential: Boolean(controller.showConfidential) });
      const events = snapshot.events;
      const currentTask = runtime().getCurrentWorkbenchTask();
      const humanTask = pendingHumanTask(state);
      const humanTaskCard = humanTask
        ? String(globalThis.AiWerewolfHumanTaskView?.renderHumanTaskCard?.(state, humanTask) ?? '')
        : '';
      const messages = events.map((event) => {
        const isSpeech = ['public-speech', 'result-impression'].includes(event.type) && Boolean(event.actorId);
        const speakerName = isSpeech ? snapshot.players.find((player) => player.id === event.actorId)?.name ?? '不明' : 'ゲーム進行';
        const roleId = String(event.confidential?.roleId ?? '').trim();
        const roleName = roleId ? runtime().getRoleDisplayName(roleId) : '';
        const speaker = `<strong class="public-speaker-name">${escapeHtml(speakerName)}</strong>${roleName ? `<span class="public-speaker-role">（${escapeHtml(roleName)}）</span>` : ''}`;
        const heartVoiceSource = String(event.confidential?.heartVoice ?? '').trim();
        const heartVoiceText = heartVoiceSource.replace(/^\(([\s\S]*)\)$/u, '$1').trim();
        const heartVoice = isSpeech && heartVoiceText ? `<p class="public-heart-voice">(${escapeHtml(heartVoiceText)})</p>` : '';
        const sequence = Number(event.sequence);
        const eventNumber = Number.isInteger(sequence) && sequence > 0 ? `#${sequence}` : '#-';
        return `<article class="automation-chat-message ${isSpeech ? '' : 'is-system'}" data-live-event-id="${escapeHtml(event.id)}">
          <div class="automation-chat-meta"><span>${speaker}</span><small>Day ${Number(event.day ?? 0)}・${eventNumber}</small></div>
          <div class="automation-chat-body">${escapeHtml(publicEventText(state, event))}</div>
          ${heartVoice}
        </article>`;
      }).join('');
      const error = controller.statusType === 'error' ? `<div class="automation-live-error"><strong>自動実行を停止しました。</strong><div>${escapeHtml(controller.statusMessage)}</div></div>` : '';
      return `<section id="automation-live-view" class="automation-live-view" aria-live="polite">
        <section class="page workbench-page automation-live-page">
          <div class="page-head">
            <div><span class="eyebrow">GM進行卓</span><h2>Day ${Number(state.game?.day ?? 0)}・${escapeHtml(PHASE_LABELS[state.game?.phase] ?? state.game?.phase ?? '')}</h2><p>${escapeHtml(currentTask?.label || '自動実行の公開ログ')}</p></div>
            <div class="rule-strip">${ruleStrip(state)}</div>
          </div>
          ${state.game?.correctionMode?.enabled ? `<div class="alert danger-alert"><strong>訂正モード中</strong><span>${escapeHtml(state.game.correctionMode.reason)}</span><button class="button" data-action="exit-correction" type="button">訂正モード終了</button></div>` : ''}
          ${error}
          <div class="workbench-grid automation-live-grid">
            <aside class="progress-panel panel"><h3>進行手順</h3>${phaseSteps(state)}</aside>
            <main class="task-panel panel automation-task-panel">
              <section class="automation-log-section"><div class="automation-section-head"><h3>公開ログ</h3><span>${events.length}件</span></div><div class="automation-chat" id="automation-chat-log">${messages || (!humanTaskCard ? '<div class="automation-chat-empty"></div>' : '')}${humanTaskCard}</div></section>
            </main>
            <aside class="players-panel panel"><div class="panel-title-row"><h3>プレイヤー状態</h3><div class="panel-title-actions"><span>${state.players.filter((player) => player.alive).length}/${state.players.length} 生存</span><button class="button ghost small" data-action="open-player-relationship-dialog" type="button">相関図</button></div></div>${playerStatusList(state)}</aside>
          </div>
          <div class="action-history"><span>最後の操作: ${escapeHtml(state.lastActionLabel || 'なし')}</span></div>
        </section>
      </section>`;
    }

  function resolveLiveScrollTop({ hadExistingView, eventCountChanged, previousScrollTop, scrollHeight, clientHeight }) {
      const maximumScrollTop = Math.max(0, Number(scrollHeight ?? 0) - Number(clientHeight ?? 0));
      if (!hadExistingView || eventCountChanged) return maximumScrollTop;
      return Math.max(0, Math.min(Number(previousScrollTop ?? 0), maximumScrollTop));
    }

  function refreshLiveView() {
      const existing = document.querySelector('#automation-live-view');
      if (!controller.liveView || activeTab() !== 'workbench') {
        existing?.remove();
        return;
      }
      const state = currentGameState();
      if (!state) return;
      const previousChat = existing?.querySelector('#automation-chat-log');
      const previousScrollTop = previousChat?.scrollTop ?? 0;
      const html = renderLiveView(state);
      if (existing) existing.outerHTML = html;
      else document.body.insertAdjacentHTML('beforeend', html);
      updateButtons();
      const count = publishedPublicEvents(state).length;
      const nextLiveView = document.querySelector('#automation-live-view');
      const nextChat = nextLiveView?.querySelector('#automation-chat-log');
      if (nextChat) {
        nextChat.scrollTop = controller.waitingHuman
          ? Math.max(0, nextChat.scrollHeight - nextChat.clientHeight)
          : resolveLiveScrollTop({
            hadExistingView: Boolean(existing),
            eventCountChanged: count !== controller.lastLiveEventCount,
            previousScrollTop,
            scrollHeight: nextChat.scrollHeight,
            clientHeight: nextChat.clientHeight,
          });
      }
      controller.lastLiveEventCount = count;
    }

  function enableLiveView() {
      controller.liveView = true;
      refreshLiveView();
    }

  function syncExecutionModeWorkbenchView({ refresh = true } = {}) {
      controller.liveView = controller.settings.executionMode === 'automatic';
      if (!controller.liveView) document.querySelector('#automation-live-view')?.remove();
      else if (refresh) refreshLiveView();
      return controller.liveView;
    }

  function hideLiveView() {
      controller.liveView = false;
      document.querySelector('#automation-live-view')?.remove();
    }

  async function prepareLiveWorkbench() {
      controller.liveView = true;
      runtime().setTab('workbench');
      await delay(0);
      refreshLiveView();
    }

  function updateButtons() {
      const activeSession = ['running', 'waiting-human', 'waiting-manual-ai'].includes(controller.automationMode);
      const paused = controller.automationMode === 'paused';
      document.querySelectorAll('[data-ai-action="toggle-run"]').forEach((runButton) => {
        runButton.textContent = activeSession ? '自動実行を停止' : paused ? '自動実行を再開' : '全自動開始';
        runButton.classList.toggle('danger', activeSession);
        runButton.classList.toggle('primary', !activeSession);
        runButton.disabled = controller.settings.executionMode !== 'automatic' && !activeSession;
      });
      document.querySelectorAll('[data-ai-action="step"]').forEach((stepButton) => {
        stepButton.disabled = activeSession || controller.stepping || controller.settings.executionMode !== 'automatic';
      });
    }

  return Object.freeze({
    publishedPublicEvents,
    publicEventText,
    pendingHumanTask,
    renderLiveView,
    resolveLiveScrollTop,
    refreshLiveView,
    enableLiveView,
    syncExecutionModeWorkbenchView,
    hideLiveView,
    prepareLiveWorkbench,
    updateButtons,
  });
}
