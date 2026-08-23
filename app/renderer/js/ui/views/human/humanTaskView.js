/**
 * 責務: 人間プレイヤーの現在タスクを、進行卓内で完結するインライン操作カードまたは役職通知ダイアログとして純粋描画する。
 * 変更ルール: 公開・非公開を問わず現在の進行卓上へ必要最小限の入力だけを出し、役職通知だけは本人が明示的に開いた時にダイアログ表示する。公開CO候補と役職構成表示はroleComposition.jsの公開構成を使用し、役職欠け後の実配役を漏らさない。ゲーム状態は更新しない。
 */

import { buildClaimRolePolicy } from '../../../domain/claims/claimRolePolicy.js';
import { canSpeakDuringDay } from '../../../domain/game/playerStatus.js';
import { getAlivePlayers, getAttackCandidates, getNightActionCandidates, getPlayer, getVoteCandidates } from '../../../domain/game/standardRules.js';
import { getPublicAbilityClaimDefinition, publicAbilityResultLabel } from '../../../domain/policies/publicAbilityClaimPolicy.js';
import { getActiveGraveyardConversation, getActiveMasonConversation, getActiveWolfConversation, getPlayerName, getRoleName } from '../../../state/selectors.js';
import { ROLE_DEFINITIONS } from '../../../config/constants.js';
import { getPublicRoleComposition } from '../../../domain/roles/roleComposition.js';
import { escapeHtml } from '../../../shared/utils.js';
import { option, playerOptions } from '../../components/components.js';
import { isPersonalNightAction, nightActionLabel, nightActionTargetLabel } from '../../controllers/uiStateFormatters.js';

function humanCardShell({ taskType, playerId, slotId = '', questionEventId = '', tone = 'public', title, eyebrow, body, actions = '' }) {
  return `<section class="human-task-card human-task-${escapeHtml(tone)}" data-human-task-card data-task-type="${escapeHtml(taskType)}" data-player-id="${escapeHtml(playerId)}" data-slot-id="${escapeHtml(slotId)}" data-question-event-id="${escapeHtml(questionEventId)}" tabindex="-1">
    <div class="human-task-head"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h3>${escapeHtml(title)}</h3></div>${tone === 'private' ? '<span class="human-task-private-badge">非公開操作</span>' : ''}</div>
    ${body}
    ${actions}
  </section>`;
}

function coForm(state, playerId, scope = playerId, summary = '任意のCO操作') {
  const policy = buildClaimRolePolicy(getPublicRoleComposition(state));
  const defaultRole = policy.coRoleIds.find((roleId) => roleId !== 'none') ?? 'none';
  const roleItems = policy.coRoleIds.filter((roleId) => roleId !== 'none').map((roleId) => option(roleId, getRoleName(roleId), defaultRole)).join('');
  return `<details class="optional-box human-task-options"><summary>${escapeHtml(summary)}</summary><div class="form-grid compact"><label class="field"><span>CO操作</span><select data-human-field="coAction">${option('none', 'COなし', 'none')}${option('declare', '新規CO', 'none')}${option('change', 'CO役職変更', 'none')}${option('withdraw', 'CO撤回', 'none')}</select></label><label class="field"><span>CO役職</span><select data-human-field="coRoleId">${roleItems}</select></label></div><p class="help">COなし・撤回では役職選択を使用しません。</p></details>`;
}

function abilityClaimsForm(state, playerId, contextLabel = '能力結果公開（任意）') {
  const policy = buildClaimRolePolicy(getPublicRoleComposition(state));
  if (!policy.abilityClaimRoleIds.length) return '';
  const activeRoleId = state.claims.find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId ?? null;
  const defaultRoleId = policy.abilityClaimRoleIds.includes(activeRoleId) ? activeRoleId : policy.abilityClaimRoleIds[0];
  const rowCount = Math.max(1, Number(state.game.day ?? 1));
  const rows = Array.from({ length: rowCount }, (_, offset) => {
    const index = offset + 1;
    const definition = getPublicAbilityClaimDefinition(defaultRoleId);
    const roleItems = policy.abilityClaimRoleIds.map((id) => option(id, getRoleName(id), defaultRoleId)).join('');
    const resultItems = (definition?.results ?? ['unknown']).map((value) => option(value, publicAbilityResultLabel(value, defaultRoleId), definition?.results?.[0] ?? 'unknown')).join('');
    return `<fieldset class="optional-box human-ability-row" data-human-ability-row><legend>能力結果 ${index}</legend><div class="form-grid compact"><label class="field"><span>主張役職</span><select data-human-ability-field="claimedRoleId">${roleItems}</select></label><label class="field"><span>能力を実行・成立したDay</span><input type="number" min="0" max="${Math.max(0, Number(state.game.day ?? 1) - 1)}" value="${offset}" data-human-ability-field="actionDay"></label><label class="field"><span>対象</span><select data-human-ability-field="targetId"><option value="">公開しない</option>${playerOptions(state.players)}</select></label><label class="field"><span>結果</span><select data-human-ability-field="result">${resultItems}</select></label><label class="field"><span>選定根拠</span><select data-human-ability-field="selectionBasis"><option value="no-public-information">公開根拠なし</option><option value="public-evidence">公開根拠あり</option><option value="rule-forced">ルールで対象固定</option></select></label><label class="field"><span>公開根拠番号</span><input data-human-ability-field="evidence" placeholder="#12, #15"></label><label class="field full"><span>選定時点の理由（任意）</span><input data-human-ability-field="selectionReasonAtTime"></label></div></fieldset>`;
  }).join('');
  return `<details class="optional-box human-task-options"><summary>${escapeHtml(contextLabel)}</summary><label class="field"><span>能力結果操作</span><select data-human-field="abilityAction"><option value="none">公開しない</option><option value="publish">能力結果を公開する</option></select></label><div class="human-ability-rows">${rows}</div><p class="help">「能力結果を公開する」を選んだ場合、対象を選択した行だけ登録します。</p></details>`;
}

function renderBriefing(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  return humanCardShell({
    taskType: 'briefing', playerId: player.id, tone: 'private', eyebrow: '個人通知', title: `${player.name}への役職通知`,
    body: '<p class="help">ゲーム開始時の役職情報があります。必要な時だけ開いて確認してください。</p>',
    actions: `<div class="human-task-actions"><button class="button primary" data-action="open-human-role-notice" data-player-id="${escapeHtml(player.id)}" type="button">役職を確認</button></div>`,
  });
}

function privateResultRows(state, playerId) {
  const notices = state.events.filter((event) => event.type === 'private-result' && event.status === 'confirmed' && event.audience?.targetIds?.includes(playerId) && !event.payload?.acknowledgedAt);
  return notices.map((event) => {
    if (event.payload.actionType === 'choose-owner') {
      const teamName = event.payload.resolvedTeam === 'wolf' ? '人狼陣営' : event.payload.resolvedTeam === 'fox' ? '妖狐陣営' : '村人陣営';
      return `<div class="human-private-result"><span>家主を選びました</span><strong>${escapeHtml(getPlayerName(state, event.payload.targetId))}</strong><p>家主の役職: ${escapeHtml(getRoleName(event.payload.ownerRoleId))} / 所属陣営: ${escapeHtml(teamName)}</p></div>`;
    }
    const action = event.payload.actionType === 'medium' ? '霊能結果' : '占い結果';
    const result = event.payload.result === 'wolf' ? '人狼です' : '人狼ではありません';
    return `<div class="human-private-result"><span>${escapeHtml(action)}</span><strong>${escapeHtml(getPlayerName(state, event.payload.targetId))}</strong><p>${escapeHtml(result)}</p></div>`;
  }).join('');
}

function renderPrivateNotification(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  return humanCardShell({
    taskType: 'private-notification', playerId: player.id, tone: 'private', eyebrow: '本人限定結果', title: `${player.name}への能力結果`,
    body: privateResultRows(state, player.id) || '<p class="help">確認待ちの本人限定結果があります。</p>',
    actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">確認して続行</button></div>',
  });
}

function renderOpeningPreference(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const body = `<p class="help">CO・対抗COなど初動の都合だけを申告します。公開発言はまだ行いません。</p><label class="field"><span>1巡目の発言順希望</span><select data-human-field="preference"><option value="EARLY">できるだけ早く発言したい</option><option value="NORMAL" selected>特に希望なし</option><option value="WAIT_CO">他者のCOを待って発言したい</option></select></label>`;
  return humanCardShell({ taskType: task.type, playerId: player.id, eyebrow: '人間操作', title: `${player.name}の発言順希望`, body, actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">登録して続行</button></div>' });
}

function renderSpeech(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const d = state.discussion;
  const answerPriorityEnabled = state.game.rules.discussion.answerPriorityEnabled === true;
  const questionCandidates = getAlivePlayers(state).filter((candidate) => {
    if (candidate.id === player.id || !canSpeakDuringDay(state, candidate.id)) return false;
    if (answerPriorityEnabled) return true;
    const candidateRemaining = state.discussion.remainingByPlayer?.[candidate.id];
    return Number(candidateRemaining ?? 0) > 0;
  });
  const questionField = `<label class="field"><span>個人質問先（任意）</span><select data-human-field="questionTargetId"><option value="">指定なし</option>${playerOptions(questionCandidates)}</select></label>`;
  const modeField = d.mode === 'designated'
    ? (() => {
      const candidates = (d.queue ?? []).slice(Number(d.currentIndex ?? 0) + 1).filter((id) => !(d.spokenInCurrentRound ?? []).includes(id)).map((id) => getPlayer(state, id)).filter(Boolean);
      return `<label class="field"><span>次に前倒しする発言者（任意）</span><select data-human-field="nextSpeakerPreference"><option value="">指名なし</option>${playerOptions(candidates)}</select></label>`;
    })()
    : d.mode === 'free'
      ? '<label class="field"><span>次巡の発言希望</span><select data-human-field="discussionPreference"><option value="EARLY">できるだけ早く発言したい</option><option value="NORMAL" selected>特に希望なし</option><option value="WAIT_CO">他者のCOを待って発言したい</option><option value="DONE">この時点で話すべきことはすべて話し切った</option></select></label>'
      : '';
  const body = `<label class="field human-chat-field"><span>公開発言</span><textarea data-human-field="content" data-human-primary-input data-human-enter-submit placeholder="${escapeHtml(player.name)}として発言"></textarea></label>${questionField}${modeField}${coForm(state, player.id)}`;
  const passButton = d.mode === 'free' ? '' : '<button class="button ghost" data-action="submit-human-task" data-human-submit-kind="pass" type="button">パス</button>';
  return humanCardShell({ taskType: task.type, playerId: player.id, eyebrow: '公開発言', title: `${player.name}の発言`, body, actions: `<div class="human-task-actions">${passButton}<button class="button primary" data-action="submit-human-task" type="button">送信</button></div>` });
}

function renderPriorityAnswer(state, task) {
  const player = getPlayer(state, task.playerId);
  const questionEventId = task.questionEventId ?? task.slotId ?? '';
  const question = state.events.find((event) => event.id === questionEventId && event.type === 'public-speech' && event.status === 'published');
  if (!player) return '';
  const asker = question ? getPlayer(state, question.actorId) : null;
  const questionBlock = question ? `<div class="status-card"><span>${escapeHtml(asker?.name ?? '質問者')}の質問 #${Number(question.sequence ?? 0)}</span><strong>${escapeHtml(question.payload?.text ?? '')}</strong></div>` : '';
  const body = `${questionBlock}<label class="field human-chat-field"><span>質問への回答</span><textarea data-human-field="content" data-human-primary-input data-human-enter-submit placeholder="回答を入力"></textarea></label>${coForm(state, player.id, questionEventId, '回答に伴うCO操作（任意）')}${abilityClaimsForm(state, player.id, '回答に伴う能力結果公開（任意）')}`;
  return humanCardShell({ taskType: 'priority-answer', playerId: player.id, questionEventId, eyebrow: '公開回答', title: `${player.name}の質問への回答`, body, actions: '<div class="human-task-actions"><button class="button ghost" data-action="submit-human-task" data-human-submit-kind="skip" type="button">回答をスキップ</button><button class="button primary" data-action="submit-human-task" type="button">回答を送信</button></div>' });
}

function renderVote(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const candidates = getVoteCandidates(state, player.id, state.voteSession?.candidateIds ?? []);
  const body = `<label class="field"><span>投票先</span><select data-human-field="targetId" data-human-primary-input>${playerOptions(candidates, '', '選択してください', { allowAbstain: state.game.rules.vote.abstentionAllowed })}</select></label>`;
  return humanCardShell({ taskType: 'vote', playerId: player.id, tone: 'private', eyebrow: '投票', title: `${player.name}の投票`, body, actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">投票を確定</button></div>' });
}

function renderPrivateConversation(state, task, label) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const session = task.type === 'wolf-conversation' ? getActiveWolfConversation(state) : task.type === 'mason-conversation' ? getActiveMasonConversation(state) : getActiveGraveyardConversation(state);
  const history = (session?.messages ?? []).map((message) => `<div class="chat-message"><strong>${escapeHtml(getPlayerName(state, message.speakerId))}</strong><p>${escapeHtml(message.content)}</p></div>`).join('') || '<div class="empty-inline">まだ会話はありません。</div>';
  const body = `<div class="chat-history human-private-chat-history">${history}</div><label class="field human-chat-field"><span>${escapeHtml(label)}への発言</span><textarea data-human-field="content" data-human-primary-input data-human-enter-submit></textarea></label>`;
  return humanCardShell({ taskType: task.type, playerId: player.id, tone: 'private', eyebrow: '非公開会話', title: `${player.name}の${label}`, body, actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">発言を登録</button></div>' });
}

function renderWolfAttack(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const candidates = getAttackCandidates(state);
  return humanCardShell({ taskType: 'wolf-attack', playerId: player.id, tone: 'private', eyebrow: '襲撃投票', title: `${player.name}の襲撃先選択`, body: `<label class="field"><span>襲撃先</span><select data-human-field="targetId" data-human-primary-input>${playerOptions(candidates, '', '選択してください')}</select></label>`, actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">襲撃票を確定</button></div>' });
}

function renderNightAction(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const candidates = getNightActionCandidates(state, task.type, player.id);
  return humanCardShell({ taskType: task.type, playerId: player.id, slotId: task.slotId ?? '', tone: 'private', eyebrow: '夜行動', title: `${player.name}・${nightActionLabel(task.type)}`, body: `<label class="field"><span>${escapeHtml(nightActionTargetLabel(task.type))}</span><select data-human-field="targetId" data-human-primary-input>${playerOptions(candidates, '', '選択してください')}</select></label>`, actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">対象を確定</button></div>' });
}

function renderTestament(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  const body = `<label class="field human-chat-field"><span>公開する遺言</span><textarea data-human-field="content" data-human-primary-input data-human-enter-submit placeholder="最後に残す発言を入力"></textarea></label>${coForm(state, player.id, `testament:${player.id}`, '遺言に伴うCO操作（任意）')}${abilityClaimsForm(state, player.id, '遺言に伴う能力結果公開（任意）')}`;
  return humanCardShell({ taskType: 'testament', playerId: player.id, eyebrow: '遺言', title: `${player.name}の遺言`, body, actions: '<div class="human-task-actions"><button class="button ghost" data-action="submit-human-task" data-human-submit-kind="skip" type="button">遺言なし</button><button class="button primary" data-action="submit-human-task" type="button">遺言を公開</button></div>' });
}

function renderResultImpression(state, task) {
  const player = getPlayer(state, task.playerId);
  if (!player) return '';
  return humanCardShell({ taskType: 'result-impression', playerId: player.id, eyebrow: '公開感想', title: `${player.name}のゲーム終了後の感想`, body: '<label class="field human-chat-field"><span>公開感想</span><textarea data-human-field="content" data-human-primary-input data-human-enter-submit placeholder="1～2文の短い感想を入力"></textarea></label>', actions: '<div class="human-task-actions"><button class="button primary" data-action="submit-human-task" type="button">感想を公開</button></div>' });
}

export function renderHumanTaskCard(state, task) {
  if (!state || !task?.type || !task?.playerId) return '';
  if (task.type === 'briefing') return renderBriefing(state, task);
  if (task.type === 'private-notification') return renderPrivateNotification(state, task);
  if (task.type === 'discussion-opening-preference') return renderOpeningPreference(state, task);
  if (['speech', 'speech-designated', 'speech-free'].includes(task.type)) return renderSpeech(state, task);
  if (task.type === 'priority-answer') return renderPriorityAnswer(state, task);
  if (task.type === 'vote') return renderVote(state, task);
  if (task.type === 'wolf-conversation') return renderPrivateConversation(state, task, '人狼共有会話');
  if (task.type === 'mason-conversation') return renderPrivateConversation(state, task, '共有者共有会話');
  if (task.type === 'graveyard-conversation') return renderPrivateConversation(state, task, '墓場会話');
  if (task.type === 'wolf-attack') return renderWolfAttack(state, task);
  if (isPersonalNightAction(task.type)) return renderNightAction(state, task);
  if (task.type === 'testament') return renderTestament(state, task);
  if (task.type === 'result-impression') return renderResultImpression(state, task);
  return '';
}

export function renderHumanRoleNoticeDialog(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return '<div class="modal-body"><p>役職通知対象を確認できません。</p></div>';
  const knowledge = state.playerKnowledge[player.id] ?? {};
  const wolves = (knowledge.knownWolfIds ?? []).filter((id) => id !== player.id).map((id) => getPlayerName(state, id));
  const madmen = (knowledge.knownMadmanIds ?? []).filter((id) => id !== player.id).map((id) => getPlayerName(state, id));
  const masons = (knowledge.knownMasonIds ?? []).filter((id) => id !== player.id).map((id) => getPlayerName(state, id));
  const role = ROLE_DEFINITIONS[player.roleId];
  const composition = getPublicRoleComposition(state);
  const compositionText = Object.entries(composition)
    .filter(([, count]) => Number(count) > 0)
    .map(([roleId, count]) => `${getRoleName(roleId)}×${count}`)
    .join('、');
  const roleMissingText = state.game.rules?.roleAssignment?.roleMissingEnabled === true
    ? '<p><strong>役職欠けあり</strong>：下記は開始前に公開された配役構成です。実際に欠けた役職は公開されません。</p>'
    : '';
  return `<div class="modal-header"><div><span class="eyebrow">${escapeHtml(player.name)}への役職通知</span><h3>${escapeHtml(getRoleName(player.roleId))}</h3></div></div><div class="modal-body human-role-notice-body"><div class="role-reveal"><strong>${escapeHtml(getRoleName(player.roleId))}</strong><p>${escapeHtml(role?.description ?? '')}</p>${roleMissingText}${compositionText ? `<p>公開配役: ${escapeHtml(compositionText)}</p>` : ''}${wolves.length ? `<p>人狼仲間: ${escapeHtml(wolves.join('、'))}</p>` : ''}${madmen.length ? `<p>既知の狂人: ${escapeHtml(madmen.join('、'))}</p>` : ''}${masons.length ? `<p>共有者仲間: ${escapeHtml(masons.join('、'))}</p>` : ''}</div></div><div class="modal-footer"><button class="button ghost" data-action="open-role-help" type="button">全役職のヘルプ</button><button class="button primary" data-action="confirm-human-role-notice" data-player-id="${escapeHtml(player.id)}" type="button">確認して続行</button></div>`;
}

if (typeof globalThis !== 'undefined') {
  globalThis.AiWerewolfHumanTaskView = Object.freeze({ renderHumanTaskCard, renderHumanRoleNoticeDialog });
}
