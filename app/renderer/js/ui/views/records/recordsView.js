/**
 * 責務: 訂正・復元と、リアルタイム／日終了履歴を切り替えられるプレイヤー相関図、イベント、発言番号付きAI監査、操作通知履歴、心の声、内部メモ、共有会話、公開内容の訂正、進行結果の復元再進行、復元ポイントの管理画面を描画する。
 * 変更ルール: 状態更新やゲームデータ出力処理を行わず、機密情報は表示許可時だけDOMへ生成する。AI応答の発言番号はaiTurn.committedEntityIdsと公開イベントsequenceの対応から描画時に導出し、監査stateへ重複保存しない。記録・管理ヘッダーには現在ゲームの保存導線としてゲームデータ出力だけを置き、読込はゲーム準備へ集約する。操作通知履歴はUI層から受け取った現行セッション分だけを表示し、ゲーム状態へ混在させない。復元・進行結果訂正・公開内容訂正は単一ワークスペース内のタブで分離し、一覧は選択、詳細ペインは影響確認と実行だけを担当する。利用者向けの訂正モード開始操作は置かず、訂正・復元時の自動開始と明示終了だけを表示する。共有会話と監査情報は補助領域として折りたたみ、状態由来の識別子をHTML属性へ出力する場合は必ずエスケープする。
 */

import { AUDIENCE_LABELS, EVENT_TYPE_LABELS, PHASE_LABELS, ROLE_DEFINITIONS, TASK_LABELS } from '../../../config/constants.js';
import { escapeHtml, formatDateTime } from '../../../shared/utils.js';
import { formatInternalMemoryText } from '../../../domain/memory/memoryLedger.js';
import { recommendRestorePointForProgressionEvent, summarizeRestoreImpact } from '../../../domain/correction/restoreCorrectionService.js';
import { renderPlayerRelationshipView } from './playerRelationshipView.js';


function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function correctionStructuredFields(state) {
  const roleOptions = [
    option('none', '指定なし'),
    ...Object.values(ROLE_DEFINITIONS).map((role) => option(role.id, role.name)),
  ].join('');
  const playerOptions = [option('none', '指定なし'), ...state.players.map((player) => option(player.id, player.name))].join('');
  const questionTargetOptions = [
    option('preserve', '元の質問先を維持'),
    option('none', '質問先なし'),
    ...state.players.filter((player) => player.alive).map((player) => option(player.id, player.name)),
  ].join('');
  return `<details class="optional-box"><summary>公開発言に含まれる情報</summary><p class="help">質問先を変更すると、その相手への回答予定にも影響します。通常は元の値を維持し、質問先自体が誤っていた場合だけ変更してください。</p><label class="field"><span>質問先</span><select data-draft="correction-question-target">${questionTargetOptions}</select></label><label class="field"><span>CO・能力結果</span><select data-draft="correction-structured-mode">${option('preserve','元のCO・能力結果を維持')}${option('replace','以下のCO・能力結果へ置換')}</select></label><div class="form-grid compact"><label class="field"><span>CO操作</span><select data-draft="correction-co-action">${option('none','変更しない')}${option('declare','新しくCO')}${option('change','CO役職を変更')}${option('withdraw','COを撤回')}</select></label><label class="field"><span>COする役職</span><select data-draft="correction-co-role">${roleOptions}</select></label><label class="field"><span>能力結果の操作</span><select data-draft="correction-ability-action">${option('none','公開しない')}${option('publish','能力結果を公開')}</select></label><label class="field"><span>能力の種類</span><select data-draft="correction-ability-role">${option('none','指定なし')}${option('seer','占い')}${option('medium','霊能')}${option('guard','護衛')}</select></label><label class="field"><span>能力を実行・成立したDay</span><input type="number" min="0" data-draft="correction-ability-day" value="0"></label><label class="field"><span>能力対象</span><select data-draft="correction-ability-target">${playerOptions}</select></label><label class="field"><span>結果</span><select data-draft="correction-ability-result">${option('none','指定なし')}${option('wolf','人狼')}${option('not-wolf','人狼ではない')}${option('unknown','不明（狩人）')}</select></label><label class="field"><span>対象選択根拠</span><select data-draft="correction-ability-basis">${option('no-public-information','公開根拠なし')}${option('public-evidence','公開履歴を根拠に選択')}${option('rule-forced','処刑履歴で対象固定')}</select></label><label class="field"><span>根拠とする公開ログ番号</span><input data-draft="correction-ability-evidence" placeholder="#15,#18 または空欄"></label><label class="field"><span>当時の対象選択理由</span><input data-draft="correction-ability-reason" placeholder="公開履歴を根拠に選択した場合だけ入力"></label></div><p class="help">能力結果を置換すると、登録済みの能力結果は1件に置き換わります。複数の能力結果を残したい場合は元の内容を維持してください。質問への専用回答として登録された発言では質問先を変更できません。進行そのものをやり直す必要がある訂正は、復元ポイントから再進行してください。</p></details>`;
}


function formatAuditData(turn) {
  const data = {
    parsedDecisionUpdate: turn.parsedDecisionUpdate ?? null,
    resolvedDecisionUpdate: turn.resolvedDecisionUpdate ?? null,
    parsedAbilityClaims: turn.parsedAbilityClaims ?? null,
    resolvedAbilityClaims: turn.resolvedAbilityClaims ?? [],
  };
  if (Object.values(data).every((value) => value === null)) return '';
  return `<details class="optional-box"><summary>応答データの詳細</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
}

function aiTurnPublicSpeechSequenceLabel(state, turn) {
  const committedIds = new Set((turn?.committedEntityIds ?? []).map(String));
  if (!committedIds.size) return '';
  const sequences = (state?.events ?? [])
    .filter((event) => committedIds.has(String(event?.id ?? ''))
      && event?.status === 'published'
      && event?.audience?.type === 'public'
      && ['public-speech', 'result-impression'].includes(event?.type))
    .map((event) => Number(event.sequence))
    .filter((sequence) => Number.isInteger(sequence) && sequence > 0)
    .sort((left, right) => left - right);
  return sequences.length ? sequences.map((sequence) => `#${sequence}`).join('・') : '';
}

const POSTGAME_INFLUENCE_LABELS = Object.freeze({ high: '高', medium: '中', low: '低' });

function renderPostgameAnalysis(turn, analysis = null) {
  if (!analysis) return '';
  const exchanges = analysis.exchanges ?? [];
  const unavailableReason = String(analysis.unavailableReason ?? '');
  if (!analysis.available && !exchanges.length && !unavailableReason) return '';
  const history = exchanges.length
    ? `<div class="postgame-analysis-history">${exchanges.map((exchange, index) => {
      const attributions = exchange.attributions?.length
        ? `<ul>${exchange.attributions.map((item) => `<li><strong>影響度 ${escapeHtml(POSTGAME_INFLUENCE_LABELS[item.influence] ?? item.influence)} / ${escapeHtml(item.source)}</strong>${item.excerpt ? `<p>該当箇所: ${escapeHtml(item.excerpt)}</p>` : ''}<p>${escapeHtml(item.reason)}</p></li>`).join('')}</ul>`
        : '<p>具体的な影響箇所は特定されませんでした。</p>';
      return `<details class="optional-box" ${index === exchanges.length - 1 ? 'open' : ''}><summary>GM質問 ${index + 1}: ${escapeHtml(compactText(exchange.question, 72))}</summary><p><strong>回答</strong></p><p>${escapeHtml(exchange.answer)}</p><p><strong>影響箇所</strong></p>${attributions}${exchange.otherFactors ? `<p><strong>その他の要因</strong></p><p>${escapeHtml(exchange.otherFactors)}</p>` : ''}${exchange.promptImprovement ? `<p><strong>プロンプト改善案</strong></p><p>${escapeHtml(exchange.promptImprovement)}</p>` : ''}${exchange.uncertainty ? `<p class="help">${escapeHtml(exchange.uncertainty)}</p>` : ''}</details>`;
    }).join('')}</div>`
    : '';
  const error = analysis.error ? `<div class="alert error-alert"><strong>分析失敗</strong><span>${escapeHtml(analysis.error)}</span></div>` : '';
  const unavailable = unavailableReason ? `<p class="help">${escapeHtml(unavailableReason)}</p>` : '';
  const form = analysis.available
    ? `<label class="field"><span>GMからの質問</span><textarea data-draft="postgame-analysis-question:${escapeHtml(turn.id)}" placeholder="例: この発言は生成時プロンプトのどの部分に強く引っ張られた可能性がありますか？">${escapeHtml(analysis.draftQuestion ?? '')}</textarea></label><div class="button-row"><button class="button primary" data-action="postgame-analysis-ask" data-turn-id="${escapeHtml(turn.id)}" type="button" ${analysis.pending ? 'disabled' : ''}>${analysis.pending ? '分析中…' : 'GMから質問する'}</button>${exchanges.length ? `<button class="button ghost" data-action="postgame-analysis-clear" data-turn-id="${escapeHtml(turn.id)}" type="button" ${analysis.pending ? 'disabled' : ''}>質問履歴を消去</button>` : ''}</div>`
    : '';
  return `<details class="optional-box postgame-analysis-box" data-postgame-analysis-turn-id="${escapeHtml(turn.id)}"><summary>ゲーム終了後のGM向けAI分析</summary><p class="help">保存済みのAI生成記録をもとに分析します。分析内容はゲーム進行には影響しません。AIの内部思考を表示する機能ではありません。</p>${history}${error}${unavailable}${form}</details>`;
}


const GENERATION_STAGE_LABELS = Object.freeze({
  direct: '直接生成',
  draft: '構造草案',
  render: '発言化',
  proofread: '校正',
});

export function formatGenerationRun(run, getAiProfileLabel = () => null) {
  if (!run) return '';
  const manual = run.executionMode === 'manual';
  const callSummary = manual
    ? '手動方式 / API呼び出し数不明'
    : `最大通常${Number(run.normalCallCount ?? 0)}回 / 実呼び出し${Number(run.totalCallCount ?? 0)}回`;
  const stages = (run.stages ?? []).map((stage) => {
    const label = GENERATION_STAGE_LABELS[stage.stageId] ?? stage.stageId;
    const executor = manual
      ? '手動貼り付け'
      : stage.executorProfileId
        ? (getAiProfileLabel(stage.executorProfileId) ?? `不明なプロファイル（${stage.executorProfileId}）`)
        : 'このプロファイル';
    if (stage.status === 'skipped') {
      return `<li><strong>${escapeHtml(label)}</strong>: 対象文章なし / API呼び出しなし</li>`;
    }
    const fields = stage.targetTextFields?.length ? ` / ${escapeHtml(stage.targetTextFields.join(', '))}` : '';
    const calls = manual ? '' : ` / ${Number(stage.attemptCount ?? 0)}回`;
    const fallback = stage.fallbackUsed ? ' / 前工程候補を採用' : '';
    const issues = stage.issues?.length
      ? `<ul>${stage.issues.map((issue) => `<li>${escapeHtml(issue.code)}: ${escapeHtml(issue.message)}</li>`).join('')}</ul>`
      : '';
    return `<li><strong>${escapeHtml(label)}</strong>: ${escapeHtml(executor)} / ${escapeHtml(stage.status)}${calls}${fields}${fallback}${issues}</li>`;
  }).join('');
  return `<details class="optional-box"><summary>生成工程の詳細</summary><p>生成深度: ${Number(run.depth ?? 1)}（${escapeHtml(callSummary)}）</p><ul>${stages}</ul><p>最終採用: ${escapeHtml(GENERATION_STAGE_LABELS[run.finalStageId] ?? run.finalStageId)}</p></details>`;
}

function formatRecordEventText(event) {
  if (event.type === 'priority-answer-resolution') return `回答スキップ: ${event.payload?.reason ?? ''}`;
  return event.payload?.text || event.payload?.content || event.payload?.actionType || '';
}

function formatWolfSharedStrategy(strategy = {}) {
  const rows = [
    ['通常時の潜伏・騙り', strategy.claimPlan],
    ['黒結果時の対応分岐', strategy.blackReceivedPlan],
    ['仲間処刑圏での必要票判断', strategy.partnerExecutionPlan],
    ['主張崩壊後の縮小世界', strategy.collapsePlan],
    ['質問・説得対象・票移動', strategy.discussionPlan],
    ['襲撃方針', strategy.attackPlan],
  ].filter(([, value]) => String(value ?? '').trim());
  return rows.length
    ? rows.map(([label, value]) => `${label}: ${value}`).join('\n')
    : '未登録';
}

function wolfPurposeLabel(purpose) {
  if (purpose === 'opening-strategy') return '初日作戦';
  if (purpose === 'opening-strategy-and-attack') return '初日作戦＋襲撃';
  return '襲撃計画';
}

function canEditPrivateEvent(state, event) {
  if (!event || !['draft', 'confirmed'].includes(event.status) || event.audience?.type === 'public') return false;
  if (event.type === 'vote-cast') {
    return Boolean(state.voteSession
      && state.voteSession.id === event.payload?.voteSessionId
      && ['vote', 'runoff'].includes(state.game.phase)
      && ['input', 'ready', 'finalized'].includes(state.voteSession.status));
  }
  if (event.type === 'night-action') {
    return state.game.phase === 'night' && state.night?.status !== 'resolved';
  }
  if (event.type === 'wolf-conversation') {
    return state.game.phase === 'night' && state.night?.wolfAttack?.status !== 'confirmed';
  }
  if (event.type === 'mason-conversation') {
    const session = state.masonConversations.find((item) => item.id === event.payload?.conversationId);
    return state.game.phase === 'night' && session?.status === 'open';
  }
  if (event.type === 'graveyard-conversation') {
    const session = state.graveyardConversations.find((item) => item.id === event.payload?.conversationId);
    return state.game.phase === 'night' && session?.status === 'open';
  }
  return false;
}


const CORRECTION_WORKSPACE_MODES = Object.freeze(['restore', 'progression', 'public']);

const PROGRESSION_TYPE_LABELS = Object.freeze({
  'vote-finalized': '投票結果',
  execution: '処刑',
  dawn: '夜明け',
  'game-result': 'ゲーム結果',
});

const PROGRESSION_BADGE_CLASSES = Object.freeze({
  'vote-finalized': 'vote',
  execution: 'execution',
  dawn: 'dawn',
  'game-result': 'result',
});

function normalizeCorrectionWorkspaceMode(mode) {
  return CORRECTION_WORKSPACE_MODES.includes(mode) ? mode : 'restore';
}

function compactText(value, maxLength = 118) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function progressionEventSummary(event, getPlayerName) {
  if (event.type === 'vote-finalized') {
    const result = event.payload?.result ?? {};
    if (result.type === 'runoff') return '同票のため決選投票へ進みました。';
    if (result.type === 'execution' && result.targetId) return `${getPlayerName(result.targetId)}が処刑候補になりました。`;
    if (result.type === 'no-execution') return 'この日の処刑者はいませんでした。';
  }
  if (event.type === 'execution') {
    const targetId = event.payload?.targetId ?? event.targetIds?.[0] ?? null;
    if (targetId) return `${getPlayerName(targetId)}が処刑されました。`;
  }
  if (event.type === 'dawn') {
    const deadIds = event.payload?.deadPlayerIds ?? event.targetIds ?? [];
    if (deadIds.length) return `${deadIds.map((id) => getPlayerName(id)).join('、')}が死亡しました。`;
    return '死亡者なしで夜が明けました。';
  }
  if (event.type === 'game-result') return compactText(event.payload?.text || event.payload?.reason || 'ゲーム結果が公開されました。');
  return compactText(formatRecordEventText(event));
}

function publicCorrectionSummary(event, getPlayerName) {
  const actorName = event.actorId ? getPlayerName(event.actorId) : '';
  const body = compactText(formatRecordEventText(event), 104);
  return actorName ? `${actorName}: ${body}` : body;
}

function renderWorkspaceTabs(mode, counts) {
  const tabs = [
    { id: 'restore', label: '復元', count: counts.restore },
    { id: 'progression', label: '進行結果の訂正', count: counts.progression },
    { id: 'public', label: '公開済み情報の訂正', count: counts.public },
  ];
  return `<div class="records-mode-tabs" role="tablist" aria-label="訂正・復元の操作種別">${tabs.map((tab) => `<button class="records-mode-tab ${mode === tab.id ? 'active' : ''}" data-action="records-correction-mode" data-mode="${tab.id}" role="tab" aria-selected="${mode === tab.id}" type="button"><span>${escapeHtml(tab.label)}</span><strong>${tab.count}</strong></button>`).join('')}</div>`;
}

function renderCompactEmpty(title, message) {
  return `<div class="records-compact-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
}

function renderRestoreList(points, selectedId) {
  if (!points.length) return renderCompactEmpty('利用可能な復元ポイントはありません', '重要操作の直前に自動作成されます。');
  return `<div class="correction-item-list">${points.map((point) => {
    const day = Number(point.state?.game?.day ?? 0);
    const phase = PHASE_LABELS[point.state?.game?.phase] ?? point.state?.game?.phase ?? '不明';
    return `<button class="correction-item ${point.id === selectedId ? 'active' : ''}" data-action="records-correction-select" data-mode="restore" data-item-id="${escapeHtml(point.id)}" type="button"><span class="correction-item-badge restore">復元</span><span class="correction-item-copy"><strong>${escapeHtml(point.label)}</strong><small>Day ${day}・${escapeHtml(phase)} / ${escapeHtml(formatDateTime(point.createdAt))}</small></span><span class="correction-item-arrow">›</span></button>`;
  }).join('')}</div>`;
}

function renderRestoreDetail(state, point) {
  if (!point) return renderCompactEmpty('復元ポイントを選択してください', '左の一覧から戻りたい地点を選択します。');
  const impact = summarizeRestoreImpact(state, point.id);
  const day = Number(point.state?.game?.day ?? 0);
  const phase = PHASE_LABELS[point.state?.game?.phase] ?? point.state?.game?.phase ?? '不明';
  return `<div class="correction-detail-card"><div class="correction-detail-head"><div><span class="correction-item-badge restore">復元</span><h3>${escapeHtml(point.label)}</h3><p>Day ${day}・${escapeHtml(phase)}へ戻します。</p></div></div><dl class="correction-meta-grid"><div><dt>保存日時</dt><dd>${escapeHtml(formatDateTime(point.createdAt))}</dd></div><div><dt>復元後</dt><dd>Day ${day}・${escapeHtml(phase)}</dd></div><div><dt>外れるイベント</dt><dd>${impact?.supersededEventCount ?? 0}件</dd></div><div><dt>外れるAIターン</dt><dd>${impact?.aiTurnCount ?? 0}件</dd></div></dl><div class="records-impact-note"><strong>影響範囲</strong><span>公開イベント ${impact?.publicEventCount ?? 0}件を含む後続履歴は、訂正前の監査情報として保存されます。</span></div><label class="field"><span>復元理由</span><textarea data-draft="records-restore-reason" placeholder="誤った操作と、ここからやり直す理由を入力してください。"></textarea></label><button class="button danger correction-primary-action" data-action="restore-selected-point" data-point-id="${escapeHtml(point.id)}" type="button">この地点へ復元</button></div>`;
}

function renderProgressionList(events, selectedId, getPlayerName) {
  if (!events.length) return renderCompactEmpty('訂正対象の進行結果はありません', '投票・処刑・夜明け・勝敗が公開されると表示されます。');
  return `<div class="correction-item-list">${events.map((event) => {
    const badgeClass = PROGRESSION_BADGE_CLASSES[event.type] ?? 'public';
    return `<button class="correction-item ${event.id === selectedId ? 'active' : ''}" data-action="records-correction-select" data-mode="progression" data-item-id="${escapeHtml(event.id)}" type="button"><span class="correction-item-badge ${badgeClass}">${escapeHtml(PROGRESSION_TYPE_LABELS[event.type] ?? EVENT_TYPE_LABELS[event.type] ?? event.type)}</span><span class="correction-item-copy"><strong>Day ${event.day} / #${event.sequence}</strong><small>${escapeHtml(progressionEventSummary(event, getPlayerName))}</small></span><span class="correction-item-arrow">›</span></button>`;
  }).join('')}</div>`;
}

function renderProgressionDetail(state, event, getPlayerName) {
  if (!event) return renderCompactEmpty('進行結果を選択してください', '左の一覧から訂正したい結果を選択します。');
  const recommendation = recommendRestorePointForProgressionEvent(state, event.id);
  const badgeClass = PROGRESSION_BADGE_CLASSES[event.type] ?? 'public';
  if (!recommendation) {
    return `<div class="correction-detail-card"><div class="correction-detail-head"><div><span class="correction-item-badge ${badgeClass}">${escapeHtml(PROGRESSION_TYPE_LABELS[event.type] ?? event.type)}</span><h3>Day ${event.day} / #${event.sequence}</h3><p>${escapeHtml(progressionEventSummary(event, getPlayerName))}</p></div></div><div class="records-impact-note warning"><strong>対応する復元ポイントがありません</strong><span>保存済みデータまたは別の復元ポイントを確認してください。</span></div></div>`;
  }
  const pointDay = Number(recommendation.point.state?.game?.day ?? 0);
  const pointPhase = PHASE_LABELS[recommendation.point.state?.game?.phase] ?? recommendation.point.state?.game?.phase ?? '不明';
  return `<div class="correction-detail-card"><div class="correction-detail-head"><div><span class="correction-item-badge ${badgeClass}">${escapeHtml(PROGRESSION_TYPE_LABELS[event.type] ?? event.type)}</span><h3>Day ${event.day} / #${event.sequence}</h3><p>${escapeHtml(progressionEventSummary(event, getPlayerName))}</p></div></div><dl class="correction-meta-grid"><div><dt>自動選択する復元先</dt><dd>${escapeHtml(recommendation.point.label)}</dd></div><div><dt>再進行開始地点</dt><dd>Day ${pointDay}・${escapeHtml(pointPhase)}</dd></div><div><dt>外れるイベント</dt><dd>${recommendation.impact?.supersededEventCount ?? 0}件</dd></div><div><dt>外れるAIターン</dt><dd>${recommendation.impact?.aiTurnCount ?? 0}件</dd></div></dl><div class="records-impact-note"><strong>訂正方法</strong><span>公開前の地点へ戻り、正しい内容で同じ進行をやり直します。訂正前の履歴はGM監査へ保存されます。</span></div><label class="field"><span>訂正理由</span><textarea data-draft="records-progression-reason" placeholder="どの結果が誤っており、どう再進行するかを入力してください。"></textarea></label><button class="button danger correction-primary-action" data-action="restore-selected-progression" data-event-id="${escapeHtml(event.id)}" type="button">再進行で訂正</button></div>`;
}

function renderPublicCorrectionList(events, selectedId, getPlayerName) {
  if (!events.length) return renderCompactEmpty('訂正対象の公開情報はありません', '公開発言・CO・能力結果などが公開されると表示されます。');
  return `<div class="correction-item-list">${events.map((event) => `<button class="correction-item ${event.id === selectedId ? 'active' : ''}" data-action="records-correction-select" data-mode="public" data-item-id="${escapeHtml(event.id)}" type="button"><span class="correction-item-badge public">${escapeHtml(EVENT_TYPE_LABELS[event.type] ?? event.type)}</span><span class="correction-item-copy"><strong>Day ${event.day} / #${event.sequence}</strong><small>${escapeHtml(publicCorrectionSummary(event, getPlayerName))}</small></span><span class="correction-item-arrow">›</span></button>`).join('')}</div>`;
}

function renderPublicCorrectionDetail(state, event, getPlayerName) {
  if (!event) return renderCompactEmpty('公開情報を選択してください', '左の一覧から内容を差し替えたい公開情報を選択します。');
  return `<div class="correction-detail-card public-correction-form"><div class="correction-detail-head"><div><span class="correction-item-badge public">${escapeHtml(EVENT_TYPE_LABELS[event.type] ?? event.type)}</span><h3>Day ${event.day} / #${event.sequence}</h3><p>${escapeHtml(publicCorrectionSummary(event, getPlayerName))}</p></div></div><input type="hidden" data-draft="correction-event" value="${escapeHtml(event.id)}"><label class="field"><span>現在の公開内容</span><textarea readonly>${escapeHtml(formatRecordEventText(event))}</textarea></label><label class="field"><span>訂正理由</span><input data-draft="correction-reason" placeholder="入力ミス、COタグ誤りなど"></label><label class="field"><span>訂正後の公開文</span><textarea data-draft="correction-text" placeholder="訂正後に公開する全文を入力してください。"></textarea></label>${correctionStructuredFields(state)}<button class="button danger correction-primary-action" data-action="correct-public-event" type="button">内容を訂正</button></div>`;
}

function renderCorrectionWorkspace({ state, mode, selectedId, progressionEvents, publicCorrectionEvents, getPlayerName }) {
  const points = [...state.restorePoints].reverse();
  const selectedPointId = points.some((point) => point.id === selectedId) ? selectedId : (points[0]?.id ?? '');
  const selectedProgressionId = progressionEvents.some((event) => event.id === selectedId) ? selectedId : (progressionEvents[0]?.id ?? '');
  const selectedPublicId = publicCorrectionEvents.some((event) => event.id === selectedId) ? selectedId : (publicCorrectionEvents[0]?.id ?? '');
  const selectedPoint = points.find((point) => point.id === selectedPointId) ?? null;
  const selectedProgression = progressionEvents.find((event) => event.id === selectedProgressionId) ?? null;
  const selectedPublic = publicCorrectionEvents.find((event) => event.id === selectedPublicId) ?? null;
  const counts = { restore: points.length, progression: progressionEvents.length, public: publicCorrectionEvents.length };
  const activeCount = counts[mode];
  const list = mode === 'restore'
    ? renderRestoreList(points, selectedPointId)
    : mode === 'progression'
      ? renderProgressionList(progressionEvents, selectedProgressionId, getPlayerName)
      : renderPublicCorrectionList(publicCorrectionEvents, selectedPublicId, getPlayerName);
  const detail = mode === 'restore'
    ? renderRestoreDetail(state, selectedPoint)
    : mode === 'progression'
      ? renderProgressionDetail(state, selectedProgression, getPlayerName)
      : renderPublicCorrectionDetail(state, selectedPublic, getPlayerName);
  const emptyWorkspace = mode === 'restore'
    ? renderCompactEmpty('利用可能な復元ポイントはありません', '重要操作の直前に自動作成されます。ほかの訂正方法は上のタブから選べます。')
    : mode === 'progression'
      ? renderCompactEmpty('訂正対象の進行結果はありません', '投票・処刑・夜明け・勝敗が公開されると表示されます。')
      : renderCompactEmpty('訂正対象の公開情報はありません', '公開発言・CO・能力結果などが公開されると表示されます。');
  return `<section class="records-correction-workspace panel ${activeCount ? '' : 'is-empty'}"><div class="records-workspace-head"><div><span class="eyebrow">安全な進行修正</span><h3>訂正・復元</h3><p>操作の種類を選び、一覧から対象を確認して実行します。</p></div>${renderWorkspaceTabs(mode, counts)}</div>${activeCount ? `<div class="records-correction-layout"><div class="records-list-pane">${list}</div><div class="records-detail-pane">${detail}</div></div>` : `<div class="records-workspace-empty">${emptyWorkspace}</div>`}</section>`;
}

function renderSharedConversationSupport(state, showConfidential, getPlayerName) {
  const wolfContent = state.wolfConversations.length
    ? state.wolfConversations.map((session) => `<details><summary>Day ${session.day} / ${escapeHtml(wolfPurposeLabel(session.purpose))} / ${session.messages.length}件</summary>${showConfidential ? `<pre>${escapeHtml(formatWolfSharedStrategy(session.sharedStrategy))}</pre>${session.messages.map((message) => `<p><strong>${escapeHtml(getPlayerName(message.speakerId))}</strong>: ${escapeHtml(message.content)}</p>`).join('')}` : '<p>機密情報非表示中</p>'}</details>`).join('')
    : '<div class="records-compact-empty"><strong>人狼共有会話はありません</strong><span>会話が記録されるとここへ表示されます。</span></div>';
  const masonContent = state.masonConversations.length
    ? state.masonConversations.map((session) => `<details><summary>Day ${session.day} / ${session.messages.length}件</summary>${showConfidential ? session.messages.map((message) => `<p><strong>${escapeHtml(getPlayerName(message.speakerId))}</strong>: ${escapeHtml(message.content)}</p>`).join('') : '<p>機密情報非表示中</p>'}</details>`).join('')
    : '<div class="records-compact-empty"><strong>共有者共有会話はありません</strong><span>会話が記録されるとここへ表示されます。</span></div>';
  const graveyardContent = state.graveyardConversations.length
    ? state.graveyardConversations.map((session) => `<details><summary>Day ${session.day} / ${session.messages.length}件</summary>${showConfidential ? session.messages.map((message) => `<p><strong>${escapeHtml(getPlayerName(message.speakerId))}</strong>: ${escapeHtml(message.content)}</p>`).join('') : '<p>機密情報非表示中</p>'}</details>`).join('')
    : '<div class="records-compact-empty"><strong>墓場会話はありません</strong><span>死亡者が2人以上いる夜に会話が記録されるとここへ表示されます。</span></div>';
  return `<details class="records-support-section" id="records-shared-support"><summary><span><strong>共有会話</strong><small>人狼 ${state.wolfConversations.length}件 / 共有者 ${state.masonConversations.length}件 / 墓場 ${state.graveyardConversations.length}件</small></span><span class="records-support-chevron">›</span></summary><div class="records-support-body records-support-grid"><section><h3>人狼共有会話</h3>${wolfContent}</section><section><h3>共有者共有会話</h3>${masonContent}</section><section><h3>墓場会話</h3>${graveyardContent}</section></div></details>`;
}

function renderAuditSupport({
  state,
  showConfidential,
  getPlayerName,
  getRoleName,
  getAiProfileLabel,
  memoToolsByPlayerId,
  manualMemoDraftsByPlayerId,
  notifications,
  events,
  postgameAnalysis,
}) {
  return `<details class="records-support-section" id="records-audit-support"><summary><span><strong>詳細・補助情報</strong><small>イベント ${state.events.length}件 / AIターン ${state.aiTurns.length}件 / 通知 ${notifications.length}件</small></span><span class="records-support-chevron">›</span></summary><div class="records-support-body"><div class="records-grid">
      <div class="panel records-inner-panel"><h3>イベント</h3><div class="timeline">${events.length ? events.map((event) => `<div class="timeline-row ${event.audience?.type === 'public' ? '' : 'private-event'} ${event.status === 'voided' ? 'voided-event' : ''}"><span class="timeline-seq">#${event.sequence}</span><div><strong>${escapeHtml(EVENT_TYPE_LABELS[event.type] ?? event.type)}</strong><small>Day ${event.day} / ${escapeHtml(AUDIENCE_LABELS[event.audience?.type] ?? event.audience?.type)} / ${escapeHtml(event.status)}</small><p>${escapeHtml(formatRecordEventText(event))}</p>${canEditPrivateEvent(state, event) ? `<button class="button small ghost" data-action="edit-private-event" data-event-id="${escapeHtml(event.id)}" type="button">登録内容だけ修正</button>` : ''}</div></div>`).join('') : '<div class="empty-inline">イベントはまだありません。</div>'}</div></div>
      <div class="panel records-inner-panel"><h3>AI応答の詳細</h3><div class="audit-list">${state.aiTurns.length ? [...state.aiTurns].reverse().map((turn) => {
        const speechSequence = aiTurnPublicSpeechSequenceLabel(state, turn);
        return `<details data-ai-turn-id="${escapeHtml(turn.id)}"><summary>Day ${turn.day}${speechSequence ? ` / ${escapeHtml(speechSequence)}` : ''} ${escapeHtml(getPlayerName(turn.playerId))} / ${escapeHtml(TASK_LABELS[turn.taskType] ?? turn.taskType)}</summary><p>時刻: ${escapeHtml(formatDateTime(turn.timestamp))}</p>${turn.warnings?.length ? `<ul>${turn.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}${formatGenerationRun(turn.generationRun, getAiProfileLabel)}${formatAuditData(turn)}<textarea readonly>${escapeHtml(turn.rawResponse)}</textarea>${renderPostgameAnalysis(turn, postgameAnalysis?.byTurnId?.[turn.id] ?? null)}</details>`;
      }).join('') : '<div class="empty-inline">AI応答履歴はありません。</div>'}</div></div>
      <div class="panel records-inner-panel"><h3>操作通知履歴</h3><div class="notification-history">${notifications.length ? notifications.map((item) => `<div class="notification-history-row ${escapeHtml(item.type)}"><div><strong>${escapeHtml(item.message)}</strong><small>${escapeHtml(formatDateTime(item.timestamp))} / ${item.displayed ? '画面表示' : '履歴のみ'}</small></div></div>`).join('') : '<div class="empty-inline">操作通知はまだありません。</div>'}</div></div>
      <div class="panel records-inner-panel"><h3>心の声・記憶</h3>${state.players.map((player) => {
        const ledger = player.memoryLedger ?? {};
        const ledgerRows = [
          ['秘密の確定情報', ledger.privateFacts ?? []],
          ['自分が公開済みの立場・行動', ledger.publicCommitments ?? []],
          ['結果判明前の行動理由', ledger.selectionRationales ?? []],
          ['次に区別したい情報', ledger.pendingDiscriminators ?? []],
        ].map(([label, items]) => `<h5>${escapeHtml(label)}</h5>${items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item.text || item.rationale || '')}</li>`).join('')}</ul>` : '<p>なし</p>'}`).join('');
        const freeMemo = formatInternalMemoryText(player) || 'なし';
        const recommendation = player.internalMemory?.consolidationRecommended
          ? '<div class="alert warning-alert"><strong>整理推奨</strong><span>追記件数または文字数が基準を超えています。</span></div>'
          : '';
        return `<details><summary>${escapeHtml(player.name)}${showConfidential ? ` / ${escapeHtml(getRoleName(player.roleId))}` : ''}</summary>${showConfidential ? `<h4>心の声</h4><p class="heart-voice-text">${escapeHtml(player.heartVoice || 'なし')}</p><h4>システム管理記憶</h4>${ledgerRows}<h4>自由内部メモ</h4>${recommendation}<pre>${escapeHtml(freeMemo)}</pre>${memoToolsByPlayerId[player.id] ? `<details class="optional-box"><summary>AIで自由内部メモを整理</summary>${memoToolsByPlayerId[player.id]}</details>` : ''}<details class="optional-box"><summary>GMが手動で自由内部メモを整理</summary><p class="help">確定情報はシステム管理記憶へ残るため、今後必要な読み・迷い・方針だけを自由文で整理します。</p><label class="field"><span>整理後の自由内部メモ</span><textarea data-draft="manual-memo-summary:${escapeHtml(player.id)}">${escapeHtml(manualMemoDraftsByPlayerId[player.id] ?? '')}</textarea></label><button class="button ghost wide" data-action="consolidate-memo-manual" data-player-id="${escapeHtml(player.id)}" type="button">手動整理を登録</button></details>` : '機密情報非表示中'}</details>`;
      }).join('')}</div>
    </div></div></details>`;
}

function normalizeRecordsViewMode(mode) {
  return mode === 'relationship' ? 'relationship' : 'correction';
}

function renderRecordsPrimaryTabs(mode) {
  return `<div class="records-primary-tabs" role="tablist" aria-label="記録・管理の表示"><button class="records-primary-tab ${mode === 'correction' ? 'active' : ''}" data-action="records-view-mode" data-view-mode="correction" role="tab" aria-selected="${mode === 'correction'}" type="button">訂正・復元</button><button class="records-primary-tab ${mode === 'relationship' ? 'active' : ''}" data-action="records-view-mode" data-view-mode="relationship" role="tab" aria-selected="${mode === 'relationship'}" type="button">プレイヤー相関図</button></div>`;
}

export function renderRecordsView({
  state,
  showConfidential,
  getPlayerName,
  getRoleName,
  getAiProfileLabel = () => null,
  memoToolsByPlayerId = {},
  manualMemoDraftsByPlayerId = {},
  notificationHistory = [],
  recordsViewMode = 'correction',
  relationshipSelectedPlayerId = '',
  relationshipSnapshotId = '',
  relationshipVisibleRelationTypes = ['suspicion', 'ability'],
  correctionWorkspaceMode = 'restore',
  correctionWorkspaceSelectionId = '',
  postgameAnalysis = null,
}) {
  const viewMode = normalizeRecordsViewMode(recordsViewMode);
  const events = [...state.events].reverse();
  const notifications = [...notificationHistory].reverse();
  const directCorrectionTypes = new Set(['public-speech', 'correction', 'system']);
  const publicCorrectionEvents = [...state.events]
    .filter((event) => event.status === 'published' && event.audience?.type === 'public' && directCorrectionTypes.has(event.type))
    .reverse();
  const progressionCorrectionEvents = [...state.events]
    .filter((event) => event.status === 'published'
      && event.audience?.type === 'public'
      && ['vote-finalized', 'execution', 'dawn', 'game-result'].includes(event.type))
    .reverse();
  const mode = normalizeCorrectionWorkspaceMode(correctionWorkspaceMode);
  const phase = PHASE_LABELS[state.game.phase] ?? state.game.phase;
  const currentStatus = `Day ${Number(state.game.day ?? 0)}・${phase}`;
  const correctionStatus = state.game.correctionMode.enabled
    ? `<span class="records-status-chip danger">訂正モード中</span>`
    : '<span class="records-status-chip">通常進行</span>';
  const pageTitle = viewMode === 'relationship' ? 'プレイヤー相関図' : '訂正・復元';
  const pageDescription = viewMode === 'relationship'
    ? '公開CO、疑い関係、公開能力結果、公開投票を確認します。真の役職などの機密情報だけが機密表示設定に従います。'
    : '復元、進行結果の再実行、公開内容の差し替えを安全に行います。';
  const correctionModeExitButton = state.game.correctionMode.enabled
    ? '<button class="button danger" data-action="exit-correction" type="button">訂正モード終了</button>'
    : '';
  const pageActions = viewMode === 'relationship'
    ? '<div class="page-head-actions records-page-actions"><button class="button primary" data-action="open-player-relationship-window" type="button">別ウィンドウで開く</button><button class="button ghost" data-action="game-data-export" type="button">ゲームデータ出力</button></div>'
    : `<div class="page-head-actions records-page-actions"><button class="button ghost" data-action="game-data-export" type="button">ゲームデータ出力</button><button class="button ghost" data-action="show-records-shared" type="button">共有会話</button><button class="button ghost" data-action="show-records-audit" type="button">詳細情報</button>${correctionModeExitButton}<button class="button danger-ghost" data-action="manual-finish" type="button">手動勝敗判定</button></div>`;

  const body = viewMode === 'relationship'
    ? renderPlayerRelationshipView({
      state,
      showConfidential,
      selectedPlayerId: relationshipSelectedPlayerId,
      selectedSnapshotId: relationshipSnapshotId,
      visibleRelationTypes: relationshipVisibleRelationTypes,
      getRoleName,
    })
    : `<div class="records-command-bar"><div><span>現在の状態</span><strong>${escapeHtml(currentStatus)}</strong></div>${correctionStatus}${state.game.correctionMode.enabled ? `<p>${escapeHtml(state.game.correctionMode.reason)}</p>` : '<p>公開前の入力は通常修正し、公開訂正・復元では必要に応じて自動で訂正モードへ入ります。</p>'}</div>
    ${renderCorrectionWorkspace({
      state,
      mode,
      selectedId: correctionWorkspaceSelectionId,
      progressionEvents: progressionCorrectionEvents,
      publicCorrectionEvents,
      getPlayerName,
    })}
    <div class="records-support-stack">
      ${renderSharedConversationSupport(state, showConfidential, getPlayerName)}
      ${renderAuditSupport({
        state,
        showConfidential,
        getPlayerName,
        getRoleName,
        getAiProfileLabel,
        memoToolsByPlayerId,
        manualMemoDraftsByPlayerId,
        notifications,
        events,
        postgameAnalysis,
      })}
    </div>`;

  return `<section class="page records-page"><div class="page-head records-page-head"><div><span class="eyebrow">記録・管理</span><h2>${escapeHtml(pageTitle)}</h2><p>${escapeHtml(pageDescription)}</p></div>${pageActions}</div>${renderRecordsPrimaryTabs(viewMode)}${body}</section>`;
}
