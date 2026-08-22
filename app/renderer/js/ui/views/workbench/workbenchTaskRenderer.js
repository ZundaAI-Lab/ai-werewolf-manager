/**
 * 責務: 進行卓のフェーズ表示、現在タスク、参加者状態、人間入力フォーム、夜・投票・結果操作のHTMLを生成する。
 * 変更ルール: 状態を更新せず、候補・進行規則はドメインSelectorとAppUIから渡されたAI描画関数を使用する。機密会話の既定話者は各会話ポリシーのround-robinを使用し、GMが別参加者を選んだ場合も連続発言禁止を満たす選択だけを保持する。公開CO・能力結果入力の役職候補はroleComposition.jsの公開配役構成を使用し、役職欠け後の実配役を公開入力へ漏らさない。機密表示はhostの明示状態に従う。内部メモ整理は通常フェーズとは別の本人限定AIタスクとして描画する。投票済表示は現在日の投票・決選投票フェーズだけに限定し、保持中の過去voteSessionを表示根拠にしない。
 */

import { isNormalSpeechTask } from '../../../config/discussionAiTaskTypes.js';
import { TEAM_LABELS } from '../../../config/constants.js';
import { buildClaimRolePolicy } from '../../../domain/claims/claimRolePolicy.js';
import { getPublicRoleComposition } from '../../../domain/roles/roleComposition.js';
import {
  getPublicAbilityClaimDefinition,
  publicAbilityResultLabel,
} from '../../../domain/policies/publicAbilityClaimPolicy.js';
import {
  canGraveyardConversationSpeakerTakeTurn,
  getGraveyardConversationEligibleSpeakerIds,
  getGraveyardConversationNextSpeakerId,
  getGraveyardConversationRemaining,
} from '../../../domain/night/graveyardConversationPolicy.js';
import {
  canWolfConversationSpeakerTakeTurn,
  getWolfConversationEligibleSpeakerIds,
  getWolfConversationNextSpeakerId,
  getWolfConversationRemaining,
} from '../../../domain/night/wolfConversationPolicy.js';
import {
  canMasonConversationSpeakerTakeTurn,
  getMasonConversationEligibleSpeakerIds,
  getMasonConversationNextSpeakerId,
  getMasonConversationRemaining,
} from '../../../domain/night/masonConversationPolicy.js';
import {
  getAlivePlayers,
  getAttackCandidates,
  getNightActionCandidates,
  getPlayer,
  getVoteCandidates,
} from '../../../domain/game/standardRules.js';
import {
  getActiveGraveyardConversation,
  getActiveMasonConversation,
  getActiveWolfConversation,
  getPlayerName,
  getRoleName,
} from '../../../state/selectors.js';
import { canSpeakDuringDay } from '../../../domain/game/playerStatus.js';
import { getCurrentNormalSpeechAnswerTasks } from '../../../domain/discussion/priorityAnswerPolicy.js';
import { getCurrentGmTask } from '../../../domain/game/workflow.js';
import { escapeHtml } from '../../../shared/utils.js';
import {
  option,
  playerOptions,
} from '../../components/components.js';

import { renderWorkbenchShell } from './workbenchView.js';
import { renderHumanTaskCard } from '../human/humanTaskView.js';

export const HUMAN_SPEECH_DRAFT_FIELDS = Object.freeze({
  speech: 'human-speech',
  questionTarget: 'human-question-target',
  coAction: 'human-co-action',
  coRole: 'human-co-role',
  nextSpeaker: 'human-next-speaker',
  discussionPreference: 'human-discussion-preference',
  openingPreference: 'human-discussion-opening-preference',
});


import {
  shouldHighlightFrozenPlayerPanel,
  isPersonalNightAction,
  nightActionLabel,
  nightActionTargetLabel,
  deathCauseLabel,
} from '../../controllers/uiStateFormatters.js';

export class WorkbenchTaskRenderer {
  constructor(host) { this.host = host; }

  renderWorkbench(state) {
    if (state.game.phase === 'setup') {
      return `<section class="page"><div class="hero-card"><span class="eyebrow">ゲーム開始前</span><h2>ゲーム準備を完了してください</h2><p>参加人数、プレイヤー、配役、ルールを確認してから開始します。</p><button class="button primary" data-action="go-setup" type="button">ゲーム準備を開く</button></div></section>`;
    }
    const task = getCurrentGmTask(state);
    return renderWorkbenchShell({
      state,
      task,
      executionMode: this.host.executionMode(),
      automationMode: this.host.automationMode(),
      phaseSteps: this.phaseSteps(state),
      ruleStrip: this.ruleStrip(state),
      playerStatusList: this.playerStatusList(state),
      taskHtml: this.renderTask(state, task),
    });
  }

  phaseSteps(state) {
    const phase = state.game.phase;
    const sequence = phase === 'night'
      ? [
        ...(state.night?.plan?.graveyardConversationRequired ? ['墓場会話'] : []),
        ...(state.night?.plan?.masonConversationRequired ? ['共有者共有会話'] : []),
        ...(state.night?.plan?.wolfConversationRequired ? ['人狼共有会話'] : []),
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

  ruleStrip(state) {
    const r = state.game.rules;
    return [
      r.vote.visibilityDuringInput === 'secret' ? '秘密投票' : '公開投票',
      r.vote.selfVoteAllowed ? '自己投票可' : '自己投票不可',
      r.vote.abstentionAllowed ? '棄権可' : '棄権不可',
      `決選${r.vote.runoffLimit}回・${r.vote.tieResolution === 'random-execution' ? 'ランダム吊り' : '吊りなし'}`,
      r.guard.consecutiveGuardAllowed ? '連続護衛可' : '連続護衛不可',
      r.testament?.enabled ? '遺言あり' : '遺言なし',
      r.graveyardCommunication?.enabled ? `墓場会話・各${r.graveyardCommunication.speechCountPerNight}回` : '墓場会話なし',
      r.masonCommunication.enabled ? `共有者会話・各${r.masonCommunication.speechCountPerNight}回` : '共有者会話なし',
      r.wolfCommunication.enabled
        ? `${r.wolfCommunication.participantMode === 'wolves-and-madman' ? '人狼＋狂人会話' : '人狼会話'}・各${r.wolfCommunication.speechCountPerNight}回`
        : '人狼会話なし',
    ].map((item) => `<span>${escapeHtml(item)}</span>`).join('');
  }

  playerStatusList(state) {
    const task = getCurrentGmTask(state);
    return `<div class="status-list">${state.players.map((player) => {
      const active = task.playerId === player.id;
      const remaining = state.discussion?.remainingByPlayer?.[player.id];
      const voteDone = ['vote', 'runoff'].includes(state.game.phase)
        && state.voteSession?.day === state.game.day
        && Boolean(state.voteSession?.votes && player.id in state.voteSession.votes);
      const claim = state.claims.find((item) => item.actorId === player.id && item.status === 'active');
      const frozen = shouldHighlightFrozenPlayerPanel(state, player.id);
      return `<button class="status-row ${active ? 'active' : ''} ${player.alive ? '' : 'dead'} ${frozen ? 'frozen' : ''}" data-action="inspect-player" data-player-id="${escapeHtml(player.id)}" type="button"><span class="status-symbol">${active ? '▶' : player.alive ? '○' : '×'}</span><span class="status-main"><strong>${escapeHtml(player.name)}</strong><small>${player.controller === 'ai' ? 'AI' : '人間'}${frozen ? '・凍結中' : ''}${remaining !== undefined && remaining !== null ? `・残${remaining}` : ''}${voteDone ? '・投票済' : ''}${claim ? `・${escapeHtml(getRoleName(claim.roleId))}CO` : ''}</small></span>${this.host.showConfidential() ? `<span class="secret-role">${escapeHtml(getRoleName(player.roleId))}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }

  renderTask(state, task) {
    if (task.type === 'correction') return '<div class="empty-state"><strong>訂正モード中です</strong><span>記録・管理画面で訂正を行うか、訂正モードを終了してください。</span><button class="button primary" data-action="go-records" type="button">記録・管理を開く</button></div>';
    if (task.type === 'briefing') return this.renderBriefingTask(state, task.playerId);
    if (task.type === 'briefing-complete') return '<div class="success-card"><h3>役職通知が完了しました</h3><p>初日設定に従い次のフェーズへ移動しました。</p></div>';
    if (task.type === 'memo-consolidate') return this.renderMemoConsolidationTask(state, task.playerId);
    if (task.type === 'private-notification') return this.renderPrivateNotificationTask(state, task.playerId);
    if (task.type === 'graveyard-conversation') return this.renderGraveyardConversationTask(state);
    if (task.type === 'mason-conversation') return this.renderMasonConversationTask(state);
    if (task.type === 'wolf-conversation') return this.renderWolfConversationTask(state);
    if (task.type === 'wolf-attack') return this.renderWolfAttackVoteTask(state, task.playerId);
    if (isPersonalNightAction(task.type)) return this.renderNightActionTask(state, task);
    if (task.type === 'resolve-night') return this.renderResolveNightTask(state);
    if (task.type === 'publish-dawn') return this.renderDawnTask(state);
    if (task.type === 'discussion-opening-preference') return this.renderDiscussionOpeningPreference(state, task.playerId);
    if (task.type === 'discussion-designate') return this.renderDiscussionDesignate(state);
    if (task.type === 'discussion-all-deferred') return this.renderAllDeferred(state);
    if (task.type === 'priority-answer') return this.renderPriorityAnswerTask(state, task);
    if (isNormalSpeechTask(task.type)) return this.renderSpeechTask(state, task.playerId, task.type);
    if (task.type === 'discussion-complete') return this.renderDiscussionComplete(state);
    if (task.type === 'vote') return this.renderVoteTask(state, task.playerId);
    if (task.type === 'finalize-vote') return this.renderFinalizeVote(state);
    if (task.type === 'publish-vote') return this.renderPublishVote(state);
    if (task.type === 'testament') return this.renderTestamentTask(state, task.playerId);
    if (task.type === 'resolve-execution' || task.type === 'publish-execution') return this.renderExecution(state, task.playerId);
    if (task.type === 'confirm-result') return this.renderResultConfirm(state);
    if (task.type === 'publish-result') return this.renderResultPublish(state);
    if (task.type === 'result-impression') return this.renderResultImpression(state, task.playerId);
    if (task.type === 'ended') return this.renderEnded(state);
    return '<div class="empty-state"><strong>次の操作を判定できません</strong><span>記録・管理から状態を確認してください。</span></div>';
  }

  renderBriefingTask(state, playerId) {
    const player = getPlayer(state, playerId);
    const status = state.briefing.noticeStatusByPlayerId[playerId];
    if (player.controller === 'human') {
      return renderHumanTaskCard(state, { type: 'briefing', playerId });
    }
    const { cache } = this.host.freshPromptState(state, playerId, 'briefing');
    return `<div class="task-head"><span class="task-count">AI役職通知</span><h3>${escapeHtml(player.name)}へ初期プロンプトを提示</h3></div>${this.host.renderAiPromptOnly(state, player, 'briefing', [])}<div class="status-card"><span>通知状態</span><strong>${escapeHtml(status)}</strong></div><button class="button primary wide" data-action="ack-ai-briefing" data-player-id="${escapeHtml(playerId)}" ${cache || status === 'shown' ? '' : 'disabled'} type="button">対象AIへ提示済みとして確定</button><details class="optional-box"><summary>GM強制完了</summary><label class="field"><span>理由</span><input data-draft="force-briefing:${escapeHtml(playerId)}"></label><button class="button ghost wide" data-action="force-briefing" data-player-id="${escapeHtml(playerId)}" type="button">理由を記録して強制完了</button></details>`;
  }

  renderMemoConsolidationTask(state, playerId) {
    const player = getPlayer(state, playerId);
    if (!player) return '<div class="empty-state"><strong>内部メモ整理対象を確認できません</strong><span>記録・管理から参加者状態を確認してください。</span></div>';
    return `<div class="task-head"><span class="task-count">本人限定・自動整理</span><h3>${escapeHtml(player.name)}の内部メモを整理</h3></div><p class="help">未整理メモが増えたため、通常フェーズを進める前に重複をまとめた短い要約へ更新します。内容は本人とGMだけが参照します。</p>${this.host.renderAiBox(state, player, 'memo-consolidate', [])}`;
  }

  renderPrivateNotificationTask(state, playerId) {
    const player = getPlayer(state, playerId);
    return player?.controller === 'human' ? renderHumanTaskCard(state, { type: 'private-notification', playerId }) : '';
  }


  renderDiscussionOpeningPreference(state, playerId) {
    const player = getPlayer(state, playerId);
    if (!player) return '<div class="empty-state"><strong>発言順希望の対象を確認できません</strong></div>';
    const header = `<div class="task-head"><span class="task-count">発言希望制・1巡目開始前</span><h3>${escapeHtml(player.name)}の発言順希望</h3></div><p class="help">CO・対抗COなど初動の都合だけを申告します。公開発言はまだ行いません。DONEは選択できません。</p>`;
    if (player.controller === 'ai') return `${header}${this.host.renderAiBox(state, player, 'discussion-opening-preference', [])}`;
    const key = `${HUMAN_SPEECH_DRAFT_FIELDS.openingPreference}:${playerId}`;
    const value = this.host.drafts().get(key) ?? 'NORMAL';
    return `${header}<label class="field"><span>1巡目の発言順希望</span><select data-draft="${escapeHtml(key)}">${option('EARLY', 'できるだけ早く発言したい', value)}${option('NORMAL', '特に希望なし', value)}${option('WAIT_CO', '他者のCOを待って発言したい', value)}</select></label><button class="button primary wide" data-action="commit-human-discussion-opening-preference" data-player-id="${escapeHtml(playerId)}" data-task-type="discussion-opening-preference" type="button">発言順希望を登録</button>`;
  }

  renderDiscussionDesignate(state) {
    const candidates = getAlivePlayers(state).filter((player) => canSpeakDuringDay(state, player.id) && (state.discussion.remainingByPlayer[player.id] ?? 0) > 0);
    return `<div class="task-head"><span class="task-count">${state.discussion.mode === 'free' ? '発言希望制' : '指名制'}</span><h3>次の発言者を指定</h3></div><label class="field"><span>発言者</span><select data-draft="discussion-speaker">${playerOptions(candidates)}</select></label><button class="button primary wide" data-action="designate-speaker" type="button">この人に発言を求める</button><button class="button ghost wide" data-action="finish-discussion" type="button">昼議論を終了</button>`;
  }

  renderAllDeferred(state) {
    const candidates = getAlivePlayers(state).filter((player) => canSpeakDuringDay(state, player.id) && (state.discussion.remainingByPlayer[player.id] ?? 0) > 0);
    return `<div class="task-head"><span class="task-count">GM判断</span><h3>発言可能者全員が後回しを選択しました</h3></div><div class="button-row"><button class="button ghost" data-action="resolve-deferred" data-deferred-action="reset" type="button">同じ巡を再開</button><button class="button primary" data-action="resolve-deferred" data-deferred-action="complete" type="button">昼議論を終了</button></div><label class="field"><span>発言者を指定して再開</span><select data-draft="deferred-speaker">${playerOptions(candidates)}</select></label><button class="button ghost wide" data-action="resolve-deferred" data-deferred-action="designate" type="button">指定した人から再開</button>`;
  }

  renderSpeechTask(state, playerId, taskType) {
    const player = getPlayer(state, playerId);
    const d = state.discussion;
    const remaining = d.remainingByPlayer[playerId];
    const header = `<div class="task-head"><span class="task-count">第${d.round}巡${d.mode === 'free' ? '・発言希望制' : ''}・残り${remaining}回</span><h3>現在の発言者: ${escapeHtml(player.name)}</h3></div>`;
    const normalSpeechAnswers = getCurrentNormalSpeechAnswerTasks(state, playerId);
    const answerNotice = normalSpeechAnswers.length
      ? `${normalSpeechAnswers.map((answer) => {
        const asker = getPlayer(state, answer.askerPlayerId);
        return `<div class="status-card"><span>通常発言内で回答・${escapeHtml(asker?.name ?? '質問者')} #${escapeHtml(String(answer.questionSequence))}</span><strong>${escapeHtml(answer.questionText)}</strong></div>`;
      }).join('')}<p class="help">次の発言順と回答者が同じため、独立した回答フェーズを省略し、この通常発言内で質問へ回答します。</p>`
      : '';
    const passControl = d.mode === 'free'
      ? ''
      : `<button class="button ghost" data-action="pass-speech" data-player-id="${escapeHtml(playerId)}" type="button">パス</button>`;
    const gmControls = `<section class="gm-progress-controls"><h4>GM進行操作</h4><div class="secondary-actions">${d.mode === 'ordered' ? `<button class="button ghost" data-action="defer-speech" data-player-id="${escapeHtml(playerId)}" type="button">後回し</button>` : ''}${passControl}${d.mode === 'free' ? '<button class="button ghost" data-action="finish-discussion" type="button">昼議論を終了</button>' : ''}</div></section>`;
    if (player.controller === 'ai') {
      return `${header}${answerNotice}${this.host.renderAiBox(state, player, taskType, [])}${gmControls}`;
    }
    const answerPriorityEnabled = state.game.rules.discussion.answerPriorityEnabled === true;
    const questionCandidates = getAlivePlayers(state).filter((candidate) => {
      if (candidate.id === playerId || !canSpeakDuringDay(state, candidate.id)) return false;
      if (answerPriorityEnabled) return true;
      const candidateRemaining = state.discussion.remainingByPlayer?.[candidate.id];
      return Number(candidateRemaining ?? 0) > 0;
    });
    const questionTarget = this.host.drafts().get(`${HUMAN_SPEECH_DRAFT_FIELDS.questionTarget}:${playerId}`) ?? '';
    const questionTargetField = `<label class="field"><span>個人質問先（任意）</span><select data-draft="${HUMAN_SPEECH_DRAFT_FIELDS.questionTarget}:${escapeHtml(playerId)}"><option value="">指定なし</option>${playerOptions(questionCandidates, questionTarget)}</select></label><p class="help">質問先が次の通常発言者の場合は、その発言内に回答を統合します。それ以外の場合は、直後に回答フェーズが入ります。</p>`;
    const modeControlField = d.mode === 'designated'
      ? (() => {
        const candidates = (d.queue ?? []).slice(Number(d.currentIndex ?? 0) + 1)
          .filter((id) => !(d.spokenInCurrentRound ?? []).includes(id))
          .map((id) => getPlayer(state, id))
          .filter(Boolean);
        const key = `${HUMAN_SPEECH_DRAFT_FIELDS.nextSpeaker}:${playerId}`;
        const value = this.host.drafts().get(key) ?? '';
        return `<label class="field"><span>次に前倒しする発言者（任意）</span><select data-draft="${escapeHtml(key)}"><option value="">指名なし</option>${playerOptions(candidates, value)}</select></label><p class="help">この巡で未発言の相手だけを前倒しします。発言権そのものは増えません。</p>`;
      })()
      : d.mode === 'free'
        ? (() => {
          const key = `${HUMAN_SPEECH_DRAFT_FIELDS.discussionPreference}:${playerId}`;
          const value = this.host.drafts().get(key) ?? 'NORMAL';
          return `<label class="field"><span>次巡の発言希望</span><select data-draft="${escapeHtml(key)}">${option('EARLY', 'できるだけ早く発言したい', value)}${option('NORMAL', '特に希望なし', value)}${option('WAIT_CO', '他者のCOを待って発言したい', value)}${option('DONE', 'この時点で話すべきことはすべて話し切った', value)}</select></label><p class="help">「話し切った」は材料不足ではなく、現時点で公開すべき推理・疑い・質問・CO・弁明などを今回までに十分発言済みの場合だけ選びます。選択後も個人質問への回答優先には応じます。</p>`;
        })()
        : '';
    return `${header}${answerNotice}<label class="field"><span>公開発言</span><textarea data-draft="${HUMAN_SPEECH_DRAFT_FIELDS.speech}:${escapeHtml(playerId)}" placeholder="発言内容を入力">${escapeHtml(this.host.drafts().get(`${HUMAN_SPEECH_DRAFT_FIELDS.speech}:${playerId}`) ?? '')}</textarea></label>${questionTargetField}${modeControlField}${this.humanCoForm(state, playerId)}<button class="button primary wide" data-action="commit-human-speech" data-player-id="${escapeHtml(playerId)}" data-task-type="${escapeHtml(taskType)}" type="button">発言を登録</button>${gmControls}`;
  }

  renderPriorityAnswerTask(state, task) {
    const player = getPlayer(state, task.playerId);
    const question = state.events.find((event) => event.id === task.questionEventId && event.type === 'public-speech' && event.status === 'published');
    if (!player || !question) return '<div class="empty-state"><strong>回答対象を確認できません</strong><span>記録・管理から公開履歴を確認してください。</span></div>';
    const asker = getPlayer(state, question.actorId);
    const questionRef = `#${question.sequence}`;
    const header = `<div class="task-head"><span class="task-count">回答優先・発言数消費なし</span><h3>${escapeHtml(player.name)}の回答フェーズ</h3></div>`;
    const questionBlock = `<div class="status-card"><span>${escapeHtml(asker?.name ?? '質問者')}の質問 ${escapeHtml(questionRef)}</span><strong>${escapeHtml(question.payload?.text ?? '')}</strong></div><p class="help">質問された内容への回答だけを促します。回答内容そのものの妥当性は検証しません。</p>`;
    const skipKey = `priority-answer-skip-reason:${task.questionEventId}`;
    const skipControls = `<details class="optional-box"><summary>GM判断で回答をスキップ</summary><p class="help">API障害、担当者不在、質問自体を無効と判断した場合に使用します。理由はGM限定記録へ保存されます。</p><label class="field"><span>スキップ理由</span><input data-draft="${escapeHtml(skipKey)}" value="${escapeHtml(this.host.drafts().get(skipKey) ?? '')}" placeholder="スキップ理由を入力"></label><button class="button danger wide" data-action="skip-priority-answer" data-question-event-id="${escapeHtml(task.questionEventId)}" type="button">回答をスキップ</button></details>`;
    if (player.controller === 'ai') return `${header}${questionBlock}${this.host.renderAiBox(state, player, 'priority-answer', [], task.questionEventId)}${skipControls}`;
    const key = `human-priority-answer:${task.questionEventId}`;
    const coForm = this.humanCoForm(state, player.id, task.questionEventId, '回答に伴うCO操作（任意）');
    const abilityForm = this.humanPriorityAbilityClaimsForm(state, player.id, task.questionEventId);
    return `${header}${questionBlock}<label class="field"><span>質問への回答</span><textarea data-draft="${escapeHtml(key)}" placeholder="質問された内容への回答を入力">${escapeHtml(this.host.drafts().get(key) ?? '')}</textarea></label>${coForm}${abilityForm}<p class="help">CO・能力結果は質問への回答に必要な場合だけ登録してください。新しい質問は登録できません。</p><button class="button primary wide" data-action="commit-human-priority-answer" data-player-id="${escapeHtml(player.id)}" data-question-event-id="${escapeHtml(task.questionEventId)}" type="button">回答を登録</button>${skipControls}`;
  }

  humanCoForm(state, playerId, draftScope = playerId, summary = '任意のCO操作') {
    const policy = buildClaimRolePolicy(getPublicRoleComposition(state));
    const actionKey = `${HUMAN_SPEECH_DRAFT_FIELDS.coAction}:${draftScope}`;
    const roleKey = `${HUMAN_SPEECH_DRAFT_FIELDS.coRole}:${draftScope}`;
    const actionValue = this.host.drafts().get(actionKey) ?? 'none';
    const roleValue = this.host.drafts().get(roleKey) ?? policy.coRoleIds.find((roleId) => roleId !== 'none') ?? 'none';
    const roleItems = policy.coRoleIds
      .filter((roleId) => roleId !== 'none')
      .map((roleId) => option(roleId, getRoleName(roleId), roleValue))
      .join('');
    if (draftScope === playerId) {
      return `<details class="optional-box"><summary>${escapeHtml(summary)}</summary><div class="form-grid compact"><label class="field"><span>CO操作</span><select data-draft="${HUMAN_SPEECH_DRAFT_FIELDS.coAction}:${escapeHtml(playerId)}">${option('none', 'COなし', actionValue)}${option('declare', '新規CO', actionValue)}${option('change', 'CO役職変更', actionValue)}${option('withdraw', 'CO撤回', actionValue)}</select></label><label class="field"><span>CO役職</span><select data-draft="${HUMAN_SPEECH_DRAFT_FIELDS.coRole}:${escapeHtml(playerId)}">${roleItems}</select></label></div><p class="help">現在の配役に存在する役職だけを表示します。COなし・撤回では役職選択を使用しません。</p></details>`;
    }
    return `<details class="optional-box"><summary>${escapeHtml(summary)}</summary><div class="form-grid compact"><label class="field"><span>CO操作</span><select data-draft="${actionKey}">${option('none', 'COなし', actionValue)}${option('declare', '新規CO', actionValue)}${option('change', 'CO役職変更', actionValue)}${option('withdraw', 'CO撤回', actionValue)}</select></label><label class="field"><span>CO役職</span><select data-draft="${roleKey}">${roleItems}</select></label></div><p class="help">現在の配役に存在する役職だけを表示します。COなし・撤回では役職選択を使用しません。</p></details>`;
  }

  humanPriorityAbilityClaimsForm(state, playerId, questionEventId) {
    const policy = buildClaimRolePolicy(getPublicRoleComposition(state));
    if (!policy.abilityClaimRoleIds.length) return '';
    const actionKey = `human-priority-ability-action:${questionEventId}`;
    const actionValue = this.host.drafts().get(actionKey) ?? 'none';
    const activeRoleId = state.claims.find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId ?? null;
    const defaultRoleId = policy.abilityClaimRoleIds.includes(activeRoleId)
      ? activeRoleId
      : policy.abilityClaimRoleIds[0];
    const rowCount = Math.max(1, Number(state.game.day ?? 1));
    const rows = Array.from({ length: rowCount }, (_, offset) => {
      const index = offset + 1;
      const prefix = `human-priority-ability:${questionEventId}:${index}`;
      const roleId = this.host.drafts().get(`${prefix}:role`) ?? defaultRoleId;
      const definition = getPublicAbilityClaimDefinition(roleId);
      const observedDay = this.host.drafts().get(`${prefix}:day`) ?? String(index);
      const targetId = this.host.drafts().get(`${prefix}:target`) ?? '';
      const result = this.host.drafts().get(`${prefix}:result`) ?? definition?.results?.[0] ?? 'unknown';
      const selectionBasis = this.host.drafts().get(`${prefix}:basis`) ?? 'no-public-information';
      const roleItems = policy.abilityClaimRoleIds.map((id) => option(id, getRoleName(id), roleId)).join('');
      const resultItems = (definition?.results ?? ['unknown'])
        .map((value) => option(value, publicAbilityResultLabel(value, roleId), result))
        .join('');
      return `<fieldset class="optional-box"><legend>能力結果 ${index}</legend><div class="form-grid compact"><label class="field"><span>主張役職</span><select data-draft="${prefix}:role">${roleItems}</select></label><label class="field"><span>結果Day</span><input type="number" min="1" max="${Math.max(1, Number(state.game.day ?? 1))}" data-draft="${prefix}:day" value="${escapeHtml(String(observedDay))}"></label><label class="field"><span>対象</span><select data-draft="${prefix}:target"><option value="">公開しない</option>${playerOptions(state.players, targetId)}</select></label><label class="field"><span>結果</span><select data-draft="${prefix}:result">${resultItems}</select></label><label class="field"><span>選定根拠</span><select data-draft="${prefix}:basis">${option('no-public-information', '公開根拠なし', selectionBasis)}${option('public-evidence', '公開根拠あり', selectionBasis)}${option('rule-forced', 'ルールで対象固定', selectionBasis)}</select></label><label class="field"><span>公開根拠番号</span><input data-draft="${prefix}:evidence" value="${escapeHtml(this.host.drafts().get(`${prefix}:evidence`) ?? '')}" placeholder="#12, #15"></label><label class="field full"><span>選定時点の理由（任意）</span><input data-draft="${prefix}:reason" value="${escapeHtml(this.host.drafts().get(`${prefix}:reason`) ?? '')}"></label></div></fieldset>`;
    }).join('');
    return `<details class="optional-box"${actionValue === 'publish' ? ' open' : ''}><summary>回答に伴う能力結果公開（任意）</summary><label class="field"><span>能力結果操作</span><select data-draft="${actionKey}">${option('none', '公開しない', actionValue)}${option('publish', '能力結果を公開する', actionValue)}</select></label>${actionValue === 'publish' ? rows : ''}<p class="help">対象を選択した行だけ登録します。公開する役職と、回答後に有効となるCO役職は一致させてください。</p></details>`;
  }


  humanTestamentAbilityClaimsForm(state, playerId) {
    const policy = buildClaimRolePolicy(getPublicRoleComposition(state));
    if (!policy.abilityClaimRoleIds.length) return '';
    const actionKey = `human-testament-ability-action:${playerId}`;
    const actionValue = this.host.drafts().get(actionKey) ?? 'none';
    const activeRoleId = state.claims.find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId ?? null;
    const defaultRoleId = policy.abilityClaimRoleIds.includes(activeRoleId) ? activeRoleId : policy.abilityClaimRoleIds[0];
    const rowCount = Math.max(1, Number(state.game.day ?? 1));
    const rows = Array.from({ length: rowCount }, (_, offset) => {
      const index = offset + 1;
      const prefix = `human-testament-ability:${playerId}:${index}`;
      const roleId = this.host.drafts().get(`${prefix}:role`) ?? defaultRoleId;
      const definition = getPublicAbilityClaimDefinition(roleId);
      const observedDay = this.host.drafts().get(`${prefix}:day`) ?? String(index);
      const targetId = this.host.drafts().get(`${prefix}:target`) ?? '';
      const result = this.host.drafts().get(`${prefix}:result`) ?? definition?.results?.[0] ?? 'unknown';
      const selectionBasis = this.host.drafts().get(`${prefix}:basis`) ?? 'no-public-information';
      const roleItems = policy.abilityClaimRoleIds.map((id) => option(id, getRoleName(id), roleId)).join('');
      const resultItems = (definition?.results ?? ['unknown']).map((value) => option(value, publicAbilityResultLabel(value, roleId), result)).join('');
      return `<fieldset class="optional-box"><legend>能力結果 ${index}</legend><div class="form-grid compact"><label class="field"><span>主張役職</span><select data-draft="${prefix}:role">${roleItems}</select></label><label class="field"><span>結果Day</span><input type="number" min="1" max="${Math.max(1, Number(state.game.day ?? 1))}" data-draft="${prefix}:day" value="${escapeHtml(String(observedDay))}"></label><label class="field"><span>対象</span><select data-draft="${prefix}:target"><option value="">公開しない</option>${playerOptions(state.players, targetId)}</select></label><label class="field"><span>結果</span><select data-draft="${prefix}:result">${resultItems}</select></label><label class="field"><span>選定根拠</span><select data-draft="${prefix}:basis">${option('no-public-information', '公開根拠なし', selectionBasis)}${option('public-evidence', '公開根拠あり', selectionBasis)}${option('rule-forced', 'ルールで対象固定', selectionBasis)}</select></label><label class="field"><span>公開根拠番号</span><input data-draft="${prefix}:evidence" value="${escapeHtml(this.host.drafts().get(`${prefix}:evidence`) ?? '')}" placeholder="#12, #15"></label><label class="field full"><span>選定時点の理由（任意）</span><input data-draft="${prefix}:reason" value="${escapeHtml(this.host.drafts().get(`${prefix}:reason`) ?? '')}"></label></div></fieldset>`;
    }).join('');
    return `<details class="optional-box"${actionValue === 'publish' ? ' open' : ''}><summary>遺言に伴う能力結果公開（任意）</summary><label class="field"><span>能力結果操作</span><select data-draft="${actionKey}">${option('none', '公開しない', actionValue)}${option('publish', '能力結果を公開する', actionValue)}</select></label>${actionValue === 'publish' ? rows : ''}<p class="help">対象を選択した行だけ構造化して登録します。遺言本文にも同じ内容を自然文で含めてください。</p></details>`;
  }

  renderDiscussionComplete(state) {
    const reconsideration = state.discussion?.reconsideration;
    if (reconsideration?.pending) {
      const reasons = (reconsideration.reasons ?? []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
      const affected = (reconsideration.affectedPlayerIds ?? []).map((id) => getPlayerName(state, id)).filter(Boolean).join('、');
      return `<div class="success-card"><h3>3巡目のCO後に追加発言が必要です</h3><p>CO発生時点で発言回数が0だった生存者へ、1回ずつ発言機会を与えます。COした本人は対象外です。</p><ul>${reasons || '<li>3巡目にCO状態が更新されました。</li>'}</ul><p class="help">再発言対象: ${escapeHtml(affected || '対象者なし')}</p><button class="button primary wide" data-action="targeted-reconsideration" type="button">対象者の追加発言を開始</button></div>`;
    }
    return `<div class="success-card"><h3>昼議論が完了しました</h3><p>3巡の発言が完了しました。投票へ進んでください。</p><button class="button primary wide" data-action="begin-vote" type="button">投票へ進む</button></div>`;
  }

  renderVoteTask(state, playerId) {
    const session = state.voteSession;
    if (session.inputMode === 'list') return this.renderVoteList(state);
    const player = getPlayer(state, playerId);
    const completed = Object.keys(session.votes).length;
    const progress = session.eligibleVoterIds.map((id) => {
      const done = id in session.votes;
      const publicTarget = state.game.rules.vote.visibilityDuringInput === 'public' && done
        ? ` → ${session.votes[id] === 'abstain' ? '棄権' : getPlayerName(state, session.votes[id])}` : '';
      return `<span class="vote-progress ${done ? 'done' : ''}">${escapeHtml(getPlayerName(state, id))}${escapeHtml(publicTarget)}</span>`;
    }).join('');
    const header = `<div class="task-head"><span class="task-count">${completed + 1}/${session.eligibleVoterIds.length}人目${session.type === 'runoff' ? '・決選投票' : ''}</span><h3>投票者: ${escapeHtml(player.name)}</h3><div class="mode-switch"><button class="button small primary" data-action="vote-mode" data-mode="sequential" type="button">順次入力</button><button class="button small ghost" data-action="vote-mode" data-mode="list" type="button">一覧入力</button></div></div><div class="vote-progress-list">${progress}</div>`;
    const candidates = getVoteCandidates(state, playerId, session.candidateIds);
    if (player.controller === 'ai') return `${header}${this.host.renderAiBox(state, player, 'vote', candidates.map((item) => item.id))}${this.renderProxyAction(state, player, 'vote', candidates)}${this.renderRandomAction(player, 'vote', '')}`;
    return `${header}${renderHumanTaskCard(state, { type: 'vote', playerId })}`;
  }

  renderVoteList(state) {
    const session = state.voteSession;
    return `<div class="task-head"><span class="task-count">一覧入力</span><h3>投票をまとめて入力</h3><div class="mode-switch"><button class="button small ghost" data-action="vote-mode" data-mode="sequential" type="button">順次入力</button><button class="button small primary" data-action="vote-mode" data-mode="list" type="button">一覧入力</button></div></div><p class="help">GMが紙・口頭で回収済みの投票を入力するための画面です。秘密入力を本人に行わせる場合は順次入力を使用してください。</p><div class="list-input">${session.eligibleVoterIds.map((voterId) => {
      const voter = getPlayer(state, voterId);
      const candidates = getVoteCandidates(state, voterId, session.candidateIds);
      const current = session.votes[voterId] ?? '';
      const locked = state.game.rules.vote.visibilityDuringInput === 'public' && current;
      return `<div class="list-input-row"><strong>${escapeHtml(voter.name)}</strong><select data-vote-list="${escapeHtml(voterId)}" ${locked ? 'disabled' : ''}>${playerOptions(candidates, current, '選択してください', { allowAbstain: state.game.rules.vote.abstentionAllowed })}</select><button class="button small" data-action="save-list-vote" data-player-id="${escapeHtml(voterId)}" ${locked ? 'disabled' : ''} type="button">保存</button></div>`;
    }).join('')}</div>`;
  }

  renderFinalizeVote() {
    return `<div class="success-card"><h3>全員の投票が揃いました</h3><p>確定前であれば投票入力へ戻って修正できます。</p><div class="button-row"><button class="button ghost" data-action="reopen-vote" type="button">投票を修正</button><button class="button primary" data-action="finalize-vote" type="button">投票を集計</button></div></div>`;
  }

  renderPublishVote(state) {
    const session = state.voteSession;
    const tally = session.tally.map((item) => `<li><strong>${escapeHtml(getPlayerName(state, item.targetId))}</strong><span>${item.count}票</span></li>`).join('');
    const ballots = Object.entries(session.votes).map(([voterId, targetId]) => `<li>${escapeHtml(getPlayerName(state, voterId))} → ${escapeHtml(targetId === 'abstain' ? '棄権' : getPlayerName(state, targetId))}</li>`).join('');
    const mode = state.game.rules.vote.publicationAfterFinalize;
    const resultLabel = session.result.type === 'execution'
      ? session.result.resolution === 'random-tie-break'
        ? `ランダム吊り: ${getPlayerName(state, session.result.targetId)}`
        : `処刑候補: ${getPlayerName(state, session.result.targetId)}`
      : session.result.type === 'runoff'
        ? `同票: ${session.result.tiedCandidateIds.map((id) => getPlayerName(state, id)).join('、')}`
        : session.result.resolution === 'tie-no-execution'
          ? '決選投票上限後も同票: 吊りなし'
          : '有効票なし: 吊りなし';
    return `<div class="task-head"><span class="task-count">公開前確認</span><h3>投票結果</h3></div>${mode !== 'execution-target-only' ? `<ul class="tally-list">${tally}</ul>` : ''}${mode === 'all-ballots' ? `<details class="optional-box" open><summary>全投票先</summary><ul>${ballots}</ul></details>` : ''}<div class="result-banner">${escapeHtml(resultLabel)}</div><div class="button-row"><button class="button ghost" data-action="reopen-vote" type="button">投票を修正</button><button class="button primary" data-action="publish-vote" type="button">投票結果を公開</button></div>`;
  }

  renderExecution(state, playerId) {
    const player = getPlayer(state, playerId);
    const resolution = state.executionResolution;
    if (!resolution) {
      return `<div class="task-head"><span class="task-count">処刑解決前</span><h3>処刑対象: ${escapeHtml(player.name)}</h3></div><p class="help">猫又の場合は道連れ対象をここで一度だけ抽選し、公開前に確定します。</p><button class="button danger wide" data-action="resolve-execution" type="button">処刑内容を解決</button>`;
    }
    const collateral = resolution.collateralPlayerId ? getPlayerName(state, resolution.collateralPlayerId) : '';
    return `<div class="task-head"><span class="task-count">処刑公開前</span><h3>処刑対象: ${escapeHtml(player.name)}</h3></div><div class="public-preview">${escapeHtml(resolution.publicAnnouncement)}${state.game.rules.vote.revealExecutedRole ? `<br>役職: ${escapeHtml(getRoleName(player.roleId))}` : ''}</div>${collateral ? `<div class="warning-card">猫又の道連れ: ${escapeHtml(collateral)}</div>` : ''}<button class="button danger wide" data-action="publish-execution" type="button">処刑結果を公開して次へ</button>`;
  }


  renderTestamentTask(state, playerId) {
    const player = getPlayer(state, playerId);
    if (!player) return '<div class="empty-state"><strong>遺言対象を確認できません</strong><span>記録・管理から処刑状態を確認してください。</span></div>';
    const header = `<div class="task-head"><span class="task-count">処刑確定・死亡処理前</span><h3>${escapeHtml(player.name)}の遺言</h3></div><p class="help">公開発言を1回だけ残せます。通常発言回数は消費せず、質問・回答・再議論は発生しません。</p>`;
    if (player.controller === 'ai') {
      return `${header}${this.host.renderAiBox(state, player, 'testament', [])}<div class="secondary-actions"><button class="button ghost" data-action="skip-testament" data-player-id="${escapeHtml(player.id)}" type="button">遺言なしで処刑へ進む</button></div>`;
    }
    const key = `human-testament:${playerId}`;
    return `${header}<label class="field"><span>公開する遺言</span><textarea data-draft="${escapeHtml(key)}" placeholder="最後に残す発言を入力">${escapeHtml(this.host.drafts().get(key) ?? '')}</textarea></label>${this.humanCoForm(state, playerId, `testament:${playerId}`, '遺言に伴うCO操作（任意）')}${this.humanTestamentAbilityClaimsForm(state, playerId)}<div class="button-row"><button class="button ghost" data-action="skip-testament" data-player-id="${escapeHtml(player.id)}" type="button">遺言なし</button><button class="button primary" data-action="commit-human-testament" data-player-id="${escapeHtml(player.id)}" type="button">遺言を公開</button></div>`;
  }

  renderGraveyardConversationTask(state) {
    const session = getActiveGraveyardConversation(state);
    if (!session) return '<div class="empty-state"><strong>墓場会話を確認できません</strong><span>夜状態を確認してください。</span></div>';
    const eligibleIds = getGraveyardConversationEligibleSpeakerIds(session);
    const participants = eligibleIds.map((id) => getPlayer(state, id));
    const requestedSpeakerId = this.host.selectedGraveyardSpeakerId();
    const selectedId = requestedSpeakerId && canGraveyardConversationSpeakerTakeTurn(session, requestedSpeakerId)
      ? requestedSpeakerId
      : getGraveyardConversationNextSpeakerId(session);
    this.host.setSelectedGraveyardSpeakerId(selectedId);
    const speaker = selectedId ? getPlayer(state, selectedId) : null;
    const history = session.messages.length ? session.messages.map((message) => `<div class="chat-message"><strong>${escapeHtml(getPlayerName(state, message.speakerId))}</strong><p>${escapeHtml(message.content)}</p></div>`).join('') : '<div class="empty-inline">まだ墓場発言はありません。</div>';
    const total = session.participantIds.length * session.speechCountPerParticipant;
    const remaining = session.participantIds.reduce((sum, id) => sum + getGraveyardConversationRemaining(session, id), 0);
    const progress = session.participantIds.map((id) => `<div class="vote-progress-row"><strong>${escapeHtml(getPlayerName(state, id))}</strong><span>残り${getGraveyardConversationRemaining(session, id)}回</span></div>`).join('');
    const help = '<p class="help">夜開始時点ですでに死亡している者だけが参加します。過去の墓場会話は継承されますが、死亡後の地上情報は自動共有されません。</p>';
    if (!speaker) {
      return `<div class="task-head"><span class="task-count">${total}/${total}発言完了</span><h3>墓場会話</h3></div>${help}<div class="chat-history">${this.host.showConfidential() ? history : '<div class="role-hidden">墓場会話は機密情報非表示中です。</div>'}</div><div class="vote-progress-list">${progress}</div><button class="button primary wide" data-action="close-graveyard-chat" type="button">墓場会話を完了する</button>`;
    }
    return `<div class="task-head"><span class="task-count">${total - remaining}/${total}発言・1人${session.speechCountPerParticipant}回</span><h3>墓場会話</h3></div>${help}<div class="chat-history">${this.host.showConfidential() ? history : '<div class="role-hidden">墓場会話は機密情報非表示中です。</div>'}</div><div class="vote-progress-list">${progress}</div><label class="field"><span>次に処理する死亡者</span><select data-draft="graveyard-speaker">${playerOptions(participants, selectedId)}</select></label>${speaker.controller === 'ai' ? this.host.renderAiBox(state, speaker, 'graveyard-conversation', []) : renderHumanTaskCard(state, { type: 'graveyard-conversation', playerId: speaker.id, conversationId: session.id })}<div class="secondary-actions"><button class="button ghost" data-action="close-graveyard-chat" type="button">残り回数を使わず墓場会話を終了</button></div>`;
  }

  renderMasonConversationTask(state) {
    const session = getActiveMasonConversation(state);
    const eligibleIds = getMasonConversationEligibleSpeakerIds(session);
    const participants = eligibleIds.map((id) => getPlayer(state, id));
    const requestedSpeakerId = this.host.selectedMasonSpeakerId();
    const selectedId = requestedSpeakerId && canMasonConversationSpeakerTakeTurn(session, requestedSpeakerId)
      ? requestedSpeakerId
      : getMasonConversationNextSpeakerId(session);
    this.host.setSelectedMasonSpeakerId(selectedId);
    const speaker = selectedId ? getPlayer(state, selectedId) : null;
    const history = session.messages.length ? session.messages.map((message) => `<div class="chat-message"><strong>${escapeHtml(getPlayerName(state, message.speakerId))}</strong><p>${escapeHtml(message.content)}</p></div>`).join('') : '<div class="empty-inline">まだ共有発言はありません。</div>';
    const total = session.participantIds.length * session.speechCountPerParticipant;
    const remaining = session.participantIds.reduce((sum, id) => sum + getMasonConversationRemaining(session, id), 0);
    const progress = session.participantIds.map((id) => `<div class="vote-progress-row"><strong>${escapeHtml(getPlayerName(state, id))}</strong><span>残り${getMasonConversationRemaining(session, id)}回</span></div>`).join('');
    if (!speaker) {
      return `<div class="task-head"><span class="task-count">${total}/${total}発言完了</span><h3>共有者共有会話</h3></div><div class="chat-history">${this.host.showConfidential() ? history : '<div class="role-hidden">共有会話内容は機密情報非表示中です。</div>'}</div><div class="vote-progress-list">${progress}</div><button class="button primary wide" data-action="close-mason-chat" type="button">共有会話を完了する</button>`;
    }
    return `<div class="task-head"><span class="task-count">${total - remaining}/${total}発言・1人${session.speechCountPerParticipant}回</span><h3>共有者共有会話</h3></div><div class="chat-history">${this.host.showConfidential() ? history : '<div class="role-hidden">共有会話内容は機密情報非表示中です。</div>'}</div><div class="vote-progress-list">${progress}</div><label class="field"><span>次に処理する参加者</span><select data-draft="mason-speaker">${playerOptions(participants, selectedId)}</select></label>${speaker.controller === 'ai' ? this.host.renderAiBox(state, speaker, 'mason-conversation', []) : renderHumanTaskCard(state, { type: 'mason-conversation', playerId: speaker.id, conversationId: session.id })}<div class="secondary-actions"><button class="button ghost" data-action="close-mason-chat" type="button">残り回数を使わず相談を終了</button></div>`;
  }

  renderWolfConversationTask(state) {
    const session = getActiveWolfConversation(state);
    const eligibleIds = getWolfConversationEligibleSpeakerIds(session);
    const participants = eligibleIds.map((id) => getPlayer(state, id));
    const requestedSpeakerId = this.host.selectedWolfSpeakerId();
    const selectedId = requestedSpeakerId && canWolfConversationSpeakerTakeTurn(session, requestedSpeakerId)
      ? requestedSpeakerId
      : getWolfConversationNextSpeakerId(session);
    this.host.setSelectedWolfSpeakerId(selectedId);
    const speaker = selectedId ? getPlayer(state, selectedId) : null;
    const history = session.messages.length ? session.messages.map((message) => `<div class="chat-message"><strong>${escapeHtml(getPlayerName(state, message.speakerId))}</strong><p>${escapeHtml(message.content)}</p></div>`).join('') : '<div class="empty-inline">まだ共有発言はありません。</div>';
    const total = session.participantIds.length * session.speechCountPerParticipant;
    const remaining = session.participantIds.reduce((sum, id) => sum + getWolfConversationRemaining(session, id), 0);
    const progress = session.participantIds.map((id) => `<div class="vote-progress-row"><strong>${escapeHtml(getPlayerName(state, id))}</strong><span>残り${getWolfConversationRemaining(session, id)}回</span></div>`).join('');
    if (!speaker) {
      return `<div class="task-head"><span class="task-count">${total}/${total}発言完了</span><h3>人狼共有会話</h3></div><div class="chat-history">${this.host.showConfidential() ? history : '<div class="role-hidden">共有会話内容は機密情報非表示中です。</div>'}</div><div class="vote-progress-list">${progress}</div><button class="button primary wide" data-action="close-wolf-chat" type="button">共有会話を完了する</button>`;
    }
    return `<div class="task-head"><span class="task-count">${total - remaining}/${total}発言・1人${session.speechCountPerParticipant}回</span><h3>人狼共有会話</h3></div><div class="chat-history">${this.host.showConfidential() ? history : '<div class="role-hidden">共有会話内容は機密情報非表示中です。</div>'}</div><div class="vote-progress-list">${progress}</div><label class="field"><span>次に処理する参加者</span><select data-draft="wolf-speaker">${playerOptions(participants, selectedId)}</select></label>${speaker.controller === 'ai' ? this.host.renderAiBox(state, speaker, 'wolf-conversation', []) : renderHumanTaskCard(state, { type: 'wolf-conversation', playerId: speaker.id, conversationId: session.id })}<div class="secondary-actions"><button class="button ghost" data-action="close-wolf-chat" type="button">残り回数を使わず相談を終了</button></div>`;
  }

  renderWolfAttackVoteTask(state, playerId) {
    const player = getPlayer(state, playerId);
    const candidates = getAttackCandidates(state);
    const attack = state.night.wolfAttack;
    const completed = attack.voterWolfIds.filter((id) => Boolean(attack.voteByWolfId?.[id])).length;
    const total = attack.voterWolfIds.length;
    const progress = attack.voterWolfIds.map((id) => `<div class="vote-progress-row"><strong>${escapeHtml(getPlayerName(state, id))}</strong><span>${attack.voteByWolfId?.[id] ? '入力済み' : '未入力'}</span></div>`).join('');
    const header = `<div class="task-head"><span class="task-count">襲撃先投票 ${completed + 1}/${total}</span><h3>${escapeHtml(player.name)}・秘密投票</h3></div><p class="help">他の人狼の投票先は全票確定まで表示されません。最多票の対象を襲撃し、最多同率の場合は同率候補からランダムに決定します。</p><div class="vote-progress-list">${progress}</div>`;
    if (player.controller === 'ai') {
      return `${header}${this.host.renderAiBox(state, player, 'wolf-attack', candidates.map((item) => item.id))}${this.renderProxyAction(state, player, 'wolf-attack', candidates)}${this.renderRandomAction(player, 'wolf-attack', '')}`;
    }
    return `${header}${renderHumanTaskCard(state, { type: 'wolf-attack', playerId: player.id })}`;
  }

  renderNightActionTask(state, task) {
    const player = getPlayer(state, task.playerId);
    const candidates = getNightActionCandidates(state, task.type, player.id);
    const label = nightActionTargetLabel(task.type);
    const header = `<div class="task-head"><span class="task-count">夜行動</span><h3>${escapeHtml(player.name)}・${escapeHtml(label)}</h3></div>`;
    if (player.controller === 'ai') return `${header}${this.host.renderAiBox(state, player, task.type, candidates.map((item) => item.id), task.slotId)}${this.renderProxyAction(state, player, task.type, candidates, task.slotId)}${this.renderRandomAction(player, task.type, task.slotId)}`;
    return `${header}${renderHumanTaskCard(state, task)}`;
  }

  renderResolveNightTask(state) {
    const attack = state.night.wolfAttack;
    const attackText = state.night.plan.wolfAttackRequired ? getPlayerName(state, attack.finalTargetId) : '襲撃なし';
    const slots = state.night.slots.map((slot) => `<li>${escapeHtml(getPlayerName(state, slot.actorId))}: ${escapeHtml(nightActionLabel(slot.type))} → ${slot.targetId ? escapeHtml(getPlayerName(state, slot.targetId)) : '行動なし'}${slot.override ? `（${escapeHtml(slot.override.selectedBy)}）` : ''}</li>`).join('');
    const attackVoteSummary = state.night.plan.wolfAttackRequired && attack.status === 'confirmed'
      ? (() => {
        if (!this.host.showConfidential()) return '<div class="role-hidden">襲撃票の内訳は機密情報非表示中です。</div>';
        const voteRows = attack.voterWolfIds.map((wolfId) => {
          const targetId = attack.voteByWolfId?.[wolfId];
          const override = attack.overrideByWolfId?.[wolfId];
          const source = override?.type === 'random-fallback' ? '（ランダム代替）' : override?.type === 'gm-proxy' ? '（GM代理）' : '';
          return `<li>${escapeHtml(getPlayerName(state, wolfId))} → ${escapeHtml(getPlayerName(state, targetId))}${escapeHtml(source)}</li>`;
        }).join('');
        const tallyRows = Object.entries(attack.tally?.countsByTargetId ?? {})
          .map(([targetId, count]) => `<li>${escapeHtml(getPlayerName(state, targetId))}: ${Number(count)}票</li>`)
          .join('');
        const tieText = attack.tally?.resolutionMethod === 'random-tie'
          ? `<p><strong>最多同率:</strong> ${escapeHtml((attack.tally.topTargetIds ?? []).map((id) => getPlayerName(state, id)).join('、'))}<br><strong>決定方法:</strong> 同率候補からランダム</p>`
          : '<p><strong>決定方法:</strong> 単独最多</p>';
        return `<details class="optional-box" open><summary>襲撃先投票の集計</summary><p><strong>各人狼の票</strong></p><ul>${voteRows}</ul><p><strong>対象別票数</strong></p><ul>${tallyRows}</ul>${tieText}</details>`;
      })()
      : '';
    return `<div class="task-head"><span class="task-count">全夜行動入力済み</span><h3>夜行動を同時解決</h3></div><div class="summary-box"><p><strong>確定襲撃先:</strong> ${escapeHtml(attackText)}</p>${attackVoteSummary}<ul>${slots || '<li>個人夜行動なし</li>'}</ul></div><button class="button primary wide" data-action="resolve-night" type="button">夜行動を解決</button>`;
  }

  renderDawnTask(state) {
    const r = state.night.resolution;
    const title = r.publicAnnouncement ? `Day ${state.night.day + 1} 夜明け` : '初日夜処理完了';
    const preview = r.publicAnnouncement ?? '公開事項はありません。個人結果を確定し、1日目の昼を開始します。';
    const privateResultRows = r.privateResults.map((item) => `<li>${escapeHtml(getPlayerName(state, item.actorId))}: ${escapeHtml(getPlayerName(state, item.targetId))}は${item.result === 'wolf' ? '人狼' : '人狼ではない'}</li>`).join('');
    const deathRows = r.deaths.map((death) => {
      const sourceNames = (death.sourcePlayerIds ?? []).map((id) => getPlayerName(state, id)).filter(Boolean);
      const sourceText = sourceNames.length ? `／関係者: ${sourceNames.join('、')}` : '';
      return `<li>${escapeHtml(getPlayerName(state, death.playerId))}: ${escapeHtml(deathCauseLabel(death.cause))}${escapeHtml(sourceText)}</li>`;
    }).join('');
    const gmNoteRows = r.gmNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
    return `<div class="task-head"><span class="task-count">${r.publicAnnouncement ? '公開前確認' : '非公開処理確認'}</span><h3>${escapeHtml(title)}</h3></div><div class="public-preview">${escapeHtml(preview)}</div><details class="optional-box"><summary>個人通知・GM情報</summary><ul>${privateResultRows || '<li>個人通知なし</li>'}${deathRows || '<li>死亡解決なし</li>'}${gmNoteRows}</ul></details><button class="button primary wide" data-action="publish-dawn" type="button">${r.publicAnnouncement ? '夜明けを公開' : '1日目の昼を開始'}</button>`;
  }

  renderResultConfirm(state) {
    const winner = TEAM_LABELS[state.result.winner] ?? 'ゲーム終了';
    const headline = state.result.winner === 'draw' ? winner : `${winner}の勝利`;
    return `<div class="task-head"><span class="task-count">勝敗検出</span><h3>${escapeHtml(headline)}</h3></div><div class="result-banner large">${escapeHtml(state.result.reason)}</div><label class="check-row"><input type="checkbox" data-draft="result-reveal-roles" checked>全役職を公開する</label><label class="check-row"><input type="checkbox" data-draft="result-reveal-chat">人狼共有会話を公開する</label><label class="check-row"><input type="checkbox" data-draft="result-reveal-mason-chat">共有者共有会話を公開する</label><label class="check-row"><input type="checkbox" data-draft="result-reveal-graveyard-chat">墓場会話を公開する</label><label class="check-row"><input type="checkbox" data-draft="result-reveal-memos">内部メモ・心の声を公開する</label><button class="button primary wide" data-action="confirm-result" type="button">公開内容を確認</button>`;
  }

  renderResultPublish(state) {
    return `<div class="task-head"><span class="task-count">結果公開前</span><h3>公開内容を確認済みです</h3></div><ul><li>全役職: ${state.result.revealAllRoles ? '公開' : '非公開'}</li><li>人狼共有会話: ${state.result.revealWolfConversation ? '公開' : '非公開'}</li><li>共有者共有会話: ${state.result.revealMasonConversation ? '公開' : '非公開'}</li><li>墓場会話: ${state.result.revealGraveyardConversation ? '公開' : '非公開'}</li><li>内部メモ・心の声: ${state.result.revealInternalMemos ? '公開' : '非公開'}</li></ul><button class="button primary wide" data-action="publish-result" type="button">ゲーム結果を公開して感想へ</button>`;
  }

  renderResultImpression(state, playerId) {
    const player = getPlayer(state, playerId);
    const completed = state.events.filter((event) => event.type === 'result-impression' && event.status === 'published').length;
    const header = `<div class="task-head"><span class="task-count">${completed + 1}/${state.players.length}</span><h3>${escapeHtml(player.name)}の勝敗後感想</h3></div><p class="help">投票・夜行動・勝敗を受けた短い公開感想を登録します。公開表示へそのまま掲載されます。</p>`;
    if (player.controller === 'ai') return `${header}${this.host.renderAiBox(state, player, 'result-impression', [])}`;
    const key = `human-result-impression:${playerId}`;
    return `${header}<label class="field"><span>公開感想</span><textarea data-draft="${escapeHtml(key)}" placeholder="1～2文の短い感想を入力">${escapeHtml(this.host.drafts().get(key) ?? '')}</textarea></label><button class="button primary wide" data-action="commit-human-result-impression" data-player-id="${escapeHtml(playerId)}" type="button">感想を公開</button>`;
  }

  renderEnded(state) {
    return `<div class="success-card"><h3>${escapeHtml(TEAM_LABELS[state.result?.winner] ?? 'ゲーム終了')}</h3><p>${escapeHtml(state.result?.reason ?? state.game.winnerReason)}</p><div class="button-row"><button class="button ghost" data-action="go-records" type="button">全記録を見る</button><button class="button primary" data-action="go-public" type="button">公開表示を見る</button></div></div>`;
  }

  renderProxyAction(state, player, taskType, candidates, slotId = '') {
    return `<details class="optional-box"><summary>AI回答が無効な場合のGM代理入力</summary><label class="field"><span>代理対象</span><select data-draft="proxy:${escapeHtml(taskType)}:${escapeHtml(player.id)}:${escapeHtml(slotId)}">${playerOptions(candidates, '', '選択してください', { allowAbstain: taskType === 'vote' && state.game.rules.vote.abstentionAllowed })}</select></label><label class="field"><span>代理理由</span><input data-draft="proxy-reason:${escapeHtml(taskType)}:${escapeHtml(player.id)}:${escapeHtml(slotId)}" value="AI回答を正常に取得できないため"></label><button class="button ghost wide" data-action="commit-proxy" data-player-id="${escapeHtml(player.id)}" data-task-type="${escapeHtml(taskType)}" data-slot-id="${escapeHtml(slotId)}" type="button">GM代理入力を登録</button></details>`;
  }

  renderRandomAction(player, taskType, slotId) {
    return `<details class="optional-box"><summary>ランダム決定</summary><p class="help">GM代理入力も困難な場合だけ使用してください。監査履歴へ理由を残します。</p><button class="button danger-ghost wide" data-action="random-action" data-player-id="${escapeHtml(player.id)}" data-task-type="${escapeHtml(taskType)}" data-slot-id="${escapeHtml(slotId)}" type="button">有効候補からランダム決定</button></details>`;
  }
}
