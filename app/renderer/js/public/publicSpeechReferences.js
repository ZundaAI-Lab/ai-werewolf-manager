/**
 * 責務: 公開発言のイベント番号を表示用参照として扱い、発言本文中の「#N」を既存の公開発言へ安全に関連付ける。
 * 変更ルール: 公開スナップショット内の公開発言だけを参照し、イベント番号の採番・状態更新・DOMイベント登録は行わない。引用先が存在しない参照は原文のまま表示する。
 */

import { escapeHtml } from '../shared/utils.js';

const PUBLIC_REFERENCE_PATTERN = /#([1-9]\d*)/gu;

function playerName(snapshot, playerId) {
  return snapshot.players.find((player) => player.id === playerId)?.name ?? '不明';
}

function validSequence(event) {
  const sequence = Number(event?.sequence);
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

export function createPublicSpeechReferenceIndex(snapshot) {
  return new Map((snapshot.events ?? [])
    .filter((event) => event.type === 'public-speech' && validSequence(event) !== null)
    .map((event) => [validSequence(event), event]));
}

function tooltipText(snapshot, event) {
  const text = String(event.payload?.text ?? '').trim();
  const header = `Day ${event.day} #${validSequence(event)} ${playerName(snapshot, event.actorId)}`;
  return text ? `${header}\n${text}` : header;
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\r\n?|\n/gu, '&#10;');
}

export function renderPublicSpeechText(snapshot, text, references = createPublicSpeechReferenceIndex(snapshot)) {
  const source = String(text ?? '');
  let html = '';
  let cursor = 0;

  for (const match of source.matchAll(PUBLIC_REFERENCE_PATTERN)) {
    const start = match.index ?? 0;
    html += escapeHtml(source.slice(cursor, start));
    const sequence = Number(match[1]);
    const target = references.get(sequence);
    if (!target) {
      html += escapeHtml(match[0]);
    } else {
      const tooltip = tooltipText(snapshot, target);
      html += `<span class="public-quote-ref" tabindex="0" data-public-ref="#${sequence}" title="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(`${match[0]}の引用先: ${tooltip}`)}">${escapeHtml(match[0])}</span>`;
    }
    cursor = start + match[0].length;
  }

  return html + escapeHtml(source.slice(cursor));
}
