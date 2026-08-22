/**
 * 責務: 自動実行の一時状態、全画面共通ステータス表示、実行中の競合操作ロック状態を所有する。
 * 変更ルール: 表示中タブと自動実行状態を結合しない。自動API実行方式が選択されている間はidleを含め共通ヘッダーステータスを常時表示し、idle時はそこから全自動開始できる導線を提供する。人間操作待ちはエラーと区別した介入待ち表示として、対象プレイヤー・操作種別・入力導線をヘッダーへ明示し、待機へ遷移した瞬間だけ注意喚起アニメーションを行う。手動プロンプト方式のidle時だけ非表示にする。ゲーム状態を直接変更せず、running / waiting-human / waiting-manual-ai の間だけ競合する設定・復元操作をロックする。AI生成リソースを使う診断操作はrunning中だけロックし、一時停止・各待機・エラー停止では再び許可する。
 */

const AUTOMATION_MODES = Object.freeze(['idle', 'running', 'paused', 'waiting-human', 'waiting-manual-ai', 'error']);
const LOCKED_MODES = new Set(['running', 'waiting-human', 'waiting-manual-ai']);
const HUMAN_TASK_LABELS = Object.freeze({
  speech: '公開発言',
  'speech-designated': '公開発言',
  'speech-free': '公開発言',
  'priority-answer': '質問への回答',
  testament: '遺言',
  'result-impression': 'ゲーム終了後の感想',
  'discussion-opening-preference': '発言順希望',
  vote: '投票',
  briefing: '役職通知',
  'private-notification': '本人限定結果確認',
  'wolf-conversation': '人狼共有会話',
  'mason-conversation': '共有者共有会話',
  'graveyard-conversation': '墓場会話',
  'memo-consolidate': '内部メモ整理',
  'wolf-attack': '襲撃先選択',
  inspect: '占い先選択',
  guard: '護衛先選択',
  visit: '訪問先選択',
  freeze: '凍結対象選択',
  'choose-owner': '家主選択',
});

export function createAutomationStatusController(context) {
  const {
    controller,
    currentGameState,
    refreshLiveView,
    runtime,
  } = context;

  function normalizeMode(mode) {
    return AUTOMATION_MODES.includes(mode) ? mode : 'idle';
  }

  function isAutomationMutationLocked() {
    return LOCKED_MODES.has(controller.automationMode);
  }

  function isAutomationAiRequestLocked() {
    return controller.automationMode === 'running';
  }

  function maskAutomaticNightActorNames(message, state = currentGameState(), active = controller.settings.executionMode === 'automatic' && (controller.running || controller.stepping || controller.automationMode === 'running')) {
    const text = String(message ?? '');
    if (!active || state?.game?.phase !== 'night') return text;
    return [...(state?.players ?? [])]
      .map((player) => String(player?.name ?? '').trim())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .reduce((masked, name) => masked.split(name).join('夜行動担当'), text);
  }

  function humanWaitingDetail() {
    const pending = controller.pendingHumanTask ?? controller.automationDetail ?? {};
    const playerId = String(pending.playerId ?? '');
    const state = currentGameState();
    const player = (state?.players ?? []).find((item) => String(item.id) === playerId);
    const playerLabel = String(player?.name ?? '').trim() || '人間プレイヤー';
    const taskType = String(pending.taskType ?? '');
    const taskLabel = HUMAN_TASK_LABELS[taskType] ?? (pending.kind === 'human-public' ? '公開入力' : '操作');
    return `${playerLabel} の${taskLabel}待ち`;
  }

  function headerPresentation() {
    const mode = controller.automationMode;
    const definitions = {
      idle: { label: '自動API実行', status: 'idle', primary: ['toggle-run', '全自動開始'] },
      running: { label: '自動実行中', status: 'working', primary: ['pause-automatic', '一時停止'] },
      paused: { label: '一時停止中', status: 'idle', primary: ['resume-automatic', '再開'] },
      'waiting-human': { label: '人間操作が必要です', detail: humanWaitingDetail(), status: 'attention', primary: ['open-pending-task', '入力する'] },
      'waiting-manual-ai': { label: '手動AI生成待ち', status: 'idle', primary: ['open-pending-task', '進行卓へ'] },
      error: { label: 'エラー停止', status: 'error', primary: ['open-management', 'AI管理へ'] },
    };
    if (mode === 'idle' && controller.settings.executionMode !== 'automatic') return null;
    return definitions[mode] ?? null;
  }

  function configureHeaderButton(button, spec) {
    if (!button) return;
    if (!spec) {
      button.hidden = true;
      button.removeAttribute('data-ai-action');
      return;
    }
    const [action, label] = spec;
    button.hidden = false;
    button.dataset.aiAction = action;
    button.textContent = label;
  }

  function refreshAutomationStatus() {
    const mode = normalizeMode(controller.automationMode);
    controller.automationMode = mode;
    const presentation = headerPresentation();
    const panel = document.querySelector('#automation-global-status');
    if (panel) {
      panel.hidden = !presentation;
      panel.dataset.mode = mode;
      const label = panel.querySelector('[data-automation-global-label]');
      const detail = panel.querySelector('[data-automation-global-detail]');
      const indicator = panel.querySelector('[data-automation-global-indicator]');
      if (label) label.textContent = presentation?.label ?? '';
      if (detail) detail.textContent = presentation?.detail ?? controller.statusMessage ?? '';
      if (indicator) indicator.dataset.status = presentation?.status ?? 'idle';
      configureHeaderButton(panel.querySelector('[data-automation-global-primary]'), presentation?.primary ?? null);
      configureHeaderButton(panel.querySelector('[data-automation-global-secondary]'), presentation?.secondary ?? null);
    }
    document.body.classList.toggle('automation-session-locked', isAutomationMutationLocked());
    runtime().setAutomationUiState({
      mode,
      mutationLocked: isAutomationMutationLocked(),
    });
  }

  function setAutomationMode(mode, detail = null) {
    const previousMode = controller.automationMode;
    controller.automationMode = normalizeMode(mode);
    controller.automationDetail = detail && typeof detail === 'object' ? { ...detail } : null;
    refreshAutomationStatus();
    if (controller.automationMode === 'waiting-human' && previousMode !== 'waiting-human') {
      const panel = document.querySelector('#automation-global-status');
      if (panel) {
        panel.classList.remove('automation-human-wait-enter');
        void panel.offsetWidth;
        panel.classList.add('automation-human-wait-enter');
        window.setTimeout(() => panel.classList.remove('automation-human-wait-enter'), 1500);
      }
    }
  }

  function setStatus(message, type = 'idle') {
    controller.statusMessage = maskAutomaticNightActorNames(message);
    controller.statusType = type;
    document.querySelectorAll('[data-automation-status]').forEach((status) => {
      status.dataset.status = type;
      status.textContent = controller.statusMessage;
    });
    document.querySelectorAll('[data-automation-indicator]').forEach((indicator) => {
      indicator.dataset.status = type;
    });
    refreshAutomationStatus();
    refreshLiveView();
  }

  return Object.freeze({
    isAutomationAiRequestLocked,
    isAutomationMutationLocked,
    maskAutomaticNightActorNames,
    refreshAutomationStatus,
    setAutomationMode,
    setStatus,
  });
}
