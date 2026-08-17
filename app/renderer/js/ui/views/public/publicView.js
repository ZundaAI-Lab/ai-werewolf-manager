/**
 * 責務: 公開専用スナップショットだけから参加者向け画面を描画し、自動実行時の進行卓と統一した話者・Day・番号、本文改行、投票内訳、許可済みの真の役職と発言別の心の声を表示する。
 * 変更ルール: 完全状態を受け取らず、秘密情報を推測しない。真の役職と心の声はevent.confidentialに明示された話者イベントだけへ描画する。公開イベントの本文と投票内訳はスナップショットの構造化済み情報だけから整形する。
 */

import { ROLE_DEFINITIONS, TEAM_LABELS } from '../../../config/constants.js';
import { escapeHtml } from '../../../shared/utils.js';
import { publicAbilityResultLabel } from '../../../domain/policies/publicAbilityClaimPolicy.js';
import { createPublicSpeechReferenceIndex, renderPublicSpeechText } from '../../../public/publicSpeechReferences.js';

function nameOf(snapshot, id) {
  return snapshot.players.find((player) => player.id === id)?.name ?? '不明';
}

function publicPlayerClass(player) {
  return ['public-player', player.alive ? '' : 'dead', player.frozen ? 'frozen' : ''].filter(Boolean).join(' ');
}

function voteResultBody(snapshot, payload) {
  const source = String(payload.text ?? '').trim();
  const summary = source.replace(/\s*投票先:\s*[\s\S]*$/u, '').trim();
  const ballots = (payload.ballots ?? []).map((ballot) => {
    const voter = nameOf(snapshot, ballot.voterId);
    const target = ballot.targetId === 'abstain' ? '棄権' : nameOf(snapshot, ballot.targetId);
    return `<div class="public-vote-ballot"><span>${escapeHtml(voter)}</span><span aria-hidden="true">→</span><strong>${escapeHtml(target)}</strong></div>`;
  }).join('');
  const tally = (payload.tally ?? []).map((item) => `${nameOf(snapshot, item.targetId)} ${item.count}票`).join('\n');
  const fallback = summary || tally || '投票結果';
  if (!ballots) return escapeHtml(fallback);
  return `<div class="public-vote-summary">${escapeHtml(fallback)}</div><section class="public-vote-breakdown" aria-label="投票先の内訳"><strong>投票先の内訳</strong><div>${ballots}</div></section>`;
}

function eventBody(snapshot, event, speechReferences) {
  const payload = event.payload ?? {};
  if (event.type === 'vote-finalized') return voteResultBody(snapshot, payload);
  if (payload.text) {
    return event.type === 'public-speech'
      ? renderPublicSpeechText(snapshot, payload.text, speechReferences)
      : escapeHtml(payload.text);
  }
  return escapeHtml(event.type);
}

function eventMeta(event) {
  const sequence = Number(event.sequence);
  const number = Number.isInteger(sequence) && sequence > 0 ? `#${sequence}` : '#-';
  return `Day ${Number(event.day ?? 0)}・${number}`;
}

function eventSpeaker(snapshot, event) {
  const isSpeakerEvent = ['public-speech', 'result-impression'].includes(event.type) && Boolean(event.actorId);
  if (!isSpeakerEvent) return '<strong class="public-speaker-name">ゲーム進行</strong>';
  const roleId = String(event.confidential?.roleId ?? '').trim();
  const roleName = roleId ? (ROLE_DEFINITIONS[roleId]?.name ?? roleId) : '';
  const role = roleName ? `<span class="public-speaker-role">（${escapeHtml(roleName)}）</span>` : '';
  return `<strong class="public-speaker-name">${escapeHtml(nameOf(snapshot, event.actorId))}</strong>${role}`;
}

function eventHeartVoice(event) {
  if (!['public-speech', 'result-impression'].includes(event.type)) return '';
  const source = String(event.confidential?.heartVoice ?? '').trim();
  if (!source) return '';
  const text = source.replace(/^\(([\s\S]*)\)$/u, '$1').trim();
  if (!text) return '';
  return `<p class="public-heart-voice">(${escapeHtml(text)})</p>`;
}

export function renderPublicSnapshot(snapshot) {
  const speechReferences = createPublicSpeechReferenceIndex(snapshot);
  const claims = snapshot.claims.map((claim) => `<li><strong>${escapeHtml(nameOf(snapshot, claim.actorId))}</strong>: ${escapeHtml(ROLE_DEFINITIONS[claim.roleId]?.name ?? claim.roleId)}CO</li>`).join('');
  const roleLabels = { seer: '占い', medium: '霊能', guard: '護衛' };
  const abilityClaims = snapshot.publicAbilityClaims.map((claim) => `<li><strong>${escapeHtml(nameOf(snapshot, claim.actorId))}</strong>: Day ${escapeHtml(String(claim.observedDay))} ${escapeHtml(roleLabels[claim.claimedRoleId] ?? claim.claimedRoleId ?? '能力')} → ${escapeHtml(nameOf(snapshot, claim.targetId))}は${escapeHtml(publicAbilityResultLabel(claim.result, claim.claimedRoleId))}</li>`).join('');
  const resultRoles = snapshot.result?.roles?.length
    ? `<details class="public-details"><summary>全役職</summary><ul>${snapshot.result.roles.map((item) => `<li>${escapeHtml(nameOf(snapshot, item.playerId))}: ${escapeHtml(ROLE_DEFINITIONS[item.roleId]?.name ?? item.roleId)}</li>`).join('')}</ul></details>`
    : '';
  const resultChats = snapshot.result?.wolfConversations?.length
    ? `<details class="public-details"><summary>人狼共有会話</summary>${snapshot.result.wolfConversations.map((session) => `<section><h4>Day ${session.day}</h4>${session.messages.map((message) => `<p><strong>${escapeHtml(nameOf(snapshot, message.speakerId))}</strong>: ${escapeHtml(message.content)}</p>`).join('')}</section>`).join('')}</details>`
    : '';
  const resultMasonChats = snapshot.result?.masonConversations?.length
    ? `<details class="public-details"><summary>共有者共有会話</summary>${snapshot.result.masonConversations.map((session) => `<section><h4>Day ${session.day}</h4>${session.messages.map((message) => `<p><strong>${escapeHtml(nameOf(snapshot, message.speakerId))}</strong>: ${escapeHtml(message.content)}</p>`).join('')}</section>`).join('')}</details>`
    : '';
  const resultGraveyardChats = snapshot.result?.graveyardConversations?.length
    ? `<details class="public-details"><summary>墓場会話</summary>${snapshot.result.graveyardConversations.map((session) => `<section><h4>Day ${session.day}</h4>${session.messages.map((message) => `<p><strong>${escapeHtml(nameOf(snapshot, message.speakerId))}</strong>: ${escapeHtml(message.content)}</p>`).join('')}</section>`).join('')}</details>`
    : '';
  const resultMemos = snapshot.result?.internalMemos?.length
    ? `<details class="public-details"><summary>心の声・自由内部メモ</summary>${snapshot.result.internalMemos.map((item) => `<section><h4>${escapeHtml(nameOf(snapshot, item.playerId))}</h4><h5>心の声</h5><p class="public-heart-voice-summary">${escapeHtml(item.heartVoice || 'なし')}</p><h5>自由内部メモ</h5><pre>${escapeHtml(item.memo || 'なし')}</pre></section>`).join('')}</details>`
    : '';

  return `<div class="public-board">
    <div class="public-status"><strong>Day ${snapshot.game.day}</strong><span>${escapeHtml(snapshot.game.phaseLabel)}</span></div>
    <div class="public-players">${snapshot.players.map((player) => `<div class="${publicPlayerClass(player)}"><span>${player.alive ? '○' : '×'}</span><strong>${escapeHtml(player.name)}</strong>${player.frozen ? '<span class="public-player-status">凍結</span>' : ''}</div>`).join('')}</div>
    ${(claims || abilityClaims) ? `<div class="public-facts"><section><h3>公開CO</h3><ul>${claims || '<li>なし</li>'}</ul></section><section><h3>公開能力結果</h3><ul>${abilityClaims || '<li>なし</li>'}</ul></section></div>` : ''}
    ${snapshot.result ? `<div class="public-result"><strong>${escapeHtml(TEAM_LABELS[snapshot.result.winner] ?? 'ゲーム終了')}</strong><span>${escapeHtml(snapshot.result.reason)}</span></div>${resultRoles}${resultChats}${resultMasonChats}${resultGraveyardChats}${resultMemos}` : ''}
    <div class="public-log">${snapshot.events.map((event) => `<article><div class="public-log-meta"><span>${eventSpeaker(snapshot, event)}</span><small>${escapeHtml(eventMeta(event))}</small></div><div class="public-log-body">${eventBody(snapshot, event, speechReferences)}</div>${eventHeartVoice(event)}</article>`).join('') || '<div class="empty-inline">公開記録はまだありません。</div>'}</div>
  </div>`;
}
