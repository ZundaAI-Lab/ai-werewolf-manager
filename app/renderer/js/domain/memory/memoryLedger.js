/**
 * 責務: AI本人の確定記憶台帳と自由内部メモを管理し、通常ターンの短い応答によるメモ縮退を防ぐ。
 * 変更ルール: 公開・非公開の可視性を混同しない。通常更新はkeep/addだけを受理し、要約の全置換は専用整理処理に限定する。同一追記を重複保存せず、未整理ノートは新しい20件だけを保持する。
 */

import { ROLE_DEFINITIONS, TEAM_LABELS } from '../../config/constants.js';
import { getPlayerTeam } from '../roles/roleAttributes.js';
import { createId, nowIso } from '../../shared/utils.js';
import { getCurrentDecisionProjection } from '../game/decisionTargetPolicy.js';

const INTERNAL_MEMORY_DUPLICATE_LOOKBACK = 8;
const INTERNAL_MEMORY_NOTE_LIMIT = 20;
const INTERNAL_MEMORY_CONSOLIDATION_NOTE_THRESHOLD = 8;
const INTERNAL_MEMORY_CONSOLIDATION_LENGTH_THRESHOLD = 2000;

export function createEmptyInternalMemory(overrides = {}) {
  return {
    summary: String(overrides.summary ?? ''),
    notes: Array.isArray(overrides.notes)
      ? overrides.notes.map((note) => ({
        id: note.id ?? createId('memo-note'),
        sourceAiTurnId: note.sourceAiTurnId ?? null,
        text: String(note.text ?? ''),
        createdAt: note.createdAt ?? nowIso(),
      }))
      : [],
    lastConsolidatedAt: overrides.lastConsolidatedAt ?? null,
    consolidationRecommended: Boolean(overrides.consolidationRecommended),
  };
}

export function createEmptyMemoryLedger(overrides = {}) {
  return {
    privateFacts: Array.isArray(overrides.privateFacts) ? overrides.privateFacts.map((item) => ({ ...item })) : [],
    publicCommitments: Array.isArray(overrides.publicCommitments) ? overrides.publicCommitments.map((item) => ({ ...item })) : [],
    actionRationales: Array.isArray(overrides.actionRationales) ? overrides.actionRationales.map((item) => ({ ...item })) : [],
    pendingDiscriminators: Array.isArray(overrides.pendingDiscriminators) ? overrides.pendingDiscriminators.map((item) => ({ ...item })) : [],
    updatedAt: overrides.updatedAt ?? null,
  };
}


function latestTimestamp(values) {
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .sort()
    .at(-1) ?? null;
}

function deterministicLedgerUpdatedAt(state, player) {
  const eventTimes = (state.events ?? []).flatMap((event) => [event.createdAt, event.publishedAt]);
  const turnTimes = (state.aiTurns ?? [])
    .filter((turn) => turn.playerId === player.id)
    .map((turn) => turn.timestamp);
  const knowledgeTime = state.playerKnowledge?.[player.id]?.roleNotifiedAt ?? null;
  return latestTimestamp([knowledgeTime, player.decisionState?.updatedAt, ...eventTimes, ...turnTimes]);
}

function playerName(state, playerId) {
  return state.players.find((player) => player.id === playerId)?.name ?? '不明';
}

function activeEvents(state) {
  return (state.events ?? []).filter((event) => event.status !== 'voided');
}

function privateFactsForPlayer(state, player) {
  const facts = [
    {
      id: `role:${player.id}`,
      type: 'role',
      sourceEventId: null,
      text: `真の役職: ${ROLE_DEFINITIONS[player.roleId]?.name ?? player.roleId}`,
      active: true,
    },
    {
      id: `team:${player.id}`,
      type: 'team',
      sourceEventId: null,
      text: `陣営: ${TEAM_LABELS[getPlayerTeam(state, player)] ?? '未決定'}`,
      active: true,
    },
  ];
  const knowledge = state.playerKnowledge?.[player.id] ?? {};
  const knownWolfIds = [...(knowledge.knownWolfIds ?? [])].filter((id) => id !== player.id);
  if (knownWolfIds.length) {
    facts.push({
      id: `known-wolves:${player.id}`,
      type: 'known-wolves',
      sourceEventId: null,
      text: `既知の人狼: ${knownWolfIds.map((id) => playerName(state, id)).join('、')}`,
      active: true,
    });
  }
  const knownMasonIds = [...(knowledge.knownMasonIds ?? [])].filter((id) => id !== player.id);
  if (knownMasonIds.length) {
    facts.push({
      id: `known-masons:${player.id}`,
      type: 'known-masons',
      sourceEventId: null,
      text: `既知の共有者: ${knownMasonIds.map((id) => playerName(state, id)).join('、')}`,
      active: true,
    });
  }
  const knownMadmanIds = [...(knowledge.knownMadmanIds ?? [])].filter((id) => id !== player.id);
  if (knownMadmanIds.length) {
    facts.push({
      id: `known-madmen:${player.id}`,
      type: 'known-madmen',
      sourceEventId: null,
      text: `既知の狂人: ${knownMadmanIds.map((id) => playerName(state, id)).join('、')}`,
      active: true,
    });
  }
  if (knowledge.knownOwnerId) {
    facts.push({
      id: `known-owner:${player.id}`,
      type: 'known-owner',
      sourceEventId: null,
      text: `家主: ${playerName(state, knowledge.knownOwnerId)}（${ROLE_DEFINITIONS[knowledge.knownOwnerRoleId]?.name ?? knowledge.knownOwnerRoleId}）`,
      active: true,
    });
  }
  activeEvents(state)
    .filter((event) => event.type === 'private-result')
    .filter((event) => event.audience?.type === 'player' && event.audience?.targetIds?.includes(player.id))
    .forEach((event) => {
      const payload = event.payload ?? {};
      const resultText = payload.result === 'wolf' || payload.result === '人狼' ? '人狼' : '人狼ではない';
      facts.push({
        id: `private-result:${event.id}`,
        type: payload.actionType ?? 'private-result',
        sourceEventId: event.id,
        text: `Day ${payload.nightDay ?? event.day} ${playerName(state, payload.targetId)}は${resultText}`,
        active: true,
      });
    });
  return facts;
}

function publicCommitmentsForPlayer(state, player) {
  const commitments = [];
  const activeClaim = (state.claims ?? []).find((claim) => claim.actorId === player.id && claim.status === 'active');
  if (activeClaim) {
    commitments.push({
      id: `active-claim:${activeClaim.id}`,
      type: 'role-claim',
      sourceEventId: activeClaim.sourceEventId ?? null,
      text: `${ROLE_DEFINITIONS[activeClaim.roleId]?.name ?? activeClaim.roleId}COを継続中`,
      active: true,
    });
  }
  (state.publicAbilityClaims ?? [])
    .filter((claim) => claim.actorId === player.id && claim.status === 'active')
    .forEach((claim) => {
      const actionLabel = {
        guard: '護衛',
        namahage: '訪問',
        snowWoman: '凍結',
      }[claim.claimedRoleId] ?? null;
      const claimText = actionLabel
        ? `Day ${claim.observedDay} ${playerName(state, claim.targetId)}への${actionLabel}履歴を公開`
        : `Day ${claim.observedDay} ${playerName(state, claim.targetId)}は${claim.result === 'wolf' ? '人狼' : '人狼ではない'}と公開`;
      commitments.push({
        id: `ability-claim:${claim.id}`,
        type: 'ability-claim',
        sourceEventId: claim.sourceEventId ?? null,
        text: claimText,
        active: true,
      });
    });
  activeEvents(state)
    .filter((event) => event.type === 'vote-cast' && event.actorId === player.id)
    .slice(-8)
    .forEach((event) => {
      const targetId = event.payload?.targetId;
      commitments.push({
        id: `vote:${event.id}`,
        type: 'vote',
        sourceEventId: event.id,
        text: `Day ${event.day} ${targetId === 'abstain' ? '棄権' : `${playerName(state, targetId)}へ投票`}`,
        active: true,
      });
    });
  const decision = player.decisionState ?? {};
  if (decision.updatedAt) {
    commitments.push({
      id: `decision:${player.id}:${decision.sourceEventId ?? decision.sourceAiTurnId ?? decision.updatedAt}`,
      type: 'gm-managed-decision',
      sourceEventId: decision.sourceEventId ?? null,
      text: [
        decision.suspicionCandidateIds?.length ? `疑い候補: ${decision.suspicionCandidateIds.map((id) => playerName(state, id)).join('、')}` : '',
        decision.executionCandidateIds?.length ? `処刑価値候補: ${decision.executionCandidateIds.map((id) => playerName(state, id)).join('、')}` : '',
        decision.intendedVoteId ? `投票予定: ${playerName(state, decision.intendedVoteId)}` : '',
        decision.decisionReason ? `判断理由: ${decision.decisionReason}` : '',
      ].filter(Boolean).join(' / '),
      active: true,
    });
  }
  return commitments;
}

function actionRationalesForPlayer(state, player, previousLedger, { deterministicTimestamps = false } = {}) {
  const activeEventIds = new Set(activeEvents(state).map((event) => event.id));
  const preserved = (previousLedger?.actionRationales ?? [])
    .filter((item) => item.active !== false && (!item.sourceEventId || activeEventIds.has(item.sourceEventId)))
    .map((item) => ({ ...item }));
  const knownIds = new Set(preserved.map((item) => item.id));
  activeEvents(state)
    .filter((event) => event.type === 'night-action' && event.actorId === player.id)
    .forEach((event) => {
      const rationale = String(event.payload?.rationale ?? '').trim();
      if (!rationale) return;
      const id = `action-rationale:${event.id}`;
      if (knownIds.has(id)) return;
      preserved.push({
        id,
        taskType: event.payload?.actionType ?? 'night-action',
        day: Number(event.payload?.nightDay ?? event.day),
        phase: 'night',
        targetId: event.payload?.targetId ?? event.targetIds?.[0] ?? null,
        sourceEventId: event.id,
        sourceAiTurnId: event.payload?.sourceAiTurnId ?? null,
        rationale,
        createdAt: event.createdAt ?? event.publishedAt ?? (deterministicTimestamps ? null : nowIso()),
        active: true,
      });
      knownIds.add(id);
    });
  return preserved;
}

function pendingDiscriminatorsForPlayer(state, player) {
  const decision = getCurrentDecisionProjection(state, player.id, { taskType: 'speech' }).state;
  const text = String(decision.nextDiscriminatingInformation ?? '').trim();
  if (!text) return [];
  return [{
    id: `discriminator:${player.id}:${decision.sourceEventId ?? decision.sourceAiTurnId ?? decision.updatedAt ?? 'current'}`,
    text,
    sourceEventId: decision.sourceEventId ?? null,
    active: true,
  }];
}


export function recordActionRationale(state, playerId, {
  id = createId('action-rationale'),
  taskType,
  day = state.game?.day ?? 0,
  phase = state.game?.phase ?? null,
  targetId,
  rationale,
  sourceAiTurnId = null,
  sourceEventId = null,
} = {}) {
  const player = state.players.find((item) => item.id === playerId);
  const text = String(rationale ?? '').trim();
  if (!player || !text || !taskType || !targetId) return null;
  player.memoryLedger = createEmptyMemoryLedger(player.memoryLedger ?? {});
  const entry = {
    id,
    taskType: String(taskType),
    day: Number(day),
    phase: phase ? String(phase) : null,
    targetId,
    rationale: text,
    sourceAiTurnId,
    sourceEventId,
    createdAt: nowIso(),
    active: true,
  };
  const index = player.memoryLedger.actionRationales.findIndex((item) => item.id === id);
  if (index >= 0) player.memoryLedger.actionRationales[index] = entry;
  else player.memoryLedger.actionRationales.push(entry);
  return entry;
}

export function voidActionRationalesForDay(state, day, taskType = null) {
  (state.players ?? []).forEach((player) => {
    player.memoryLedger = createEmptyMemoryLedger(player.memoryLedger ?? {});
    player.memoryLedger.actionRationales.forEach((item) => {
      if (Number(item.day) === Number(day) && (!taskType || item.taskType === taskType)) item.active = false;
    });
  });
}

export function voidActionRationalesForEvent(state, sourceEventId) {
  if (!sourceEventId) return;
  (state.players ?? []).forEach((player) => {
    player.memoryLedger = createEmptyMemoryLedger(player.memoryLedger ?? {});
    player.memoryLedger.actionRationales.forEach((item) => {
      if (item.sourceEventId === sourceEventId) item.active = false;
    });
  });
}

export function rebuildPlayerMemoryLedger(state, playerId, { deterministicTimestamps = false } = {}) {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return null;
  const previous = createEmptyMemoryLedger(player.memoryLedger ?? {});
  player.memoryLedger = {
    privateFacts: privateFactsForPlayer(state, player),
    publicCommitments: publicCommitmentsForPlayer(state, player),
    actionRationales: actionRationalesForPlayer(state, player, previous, { deterministicTimestamps }),
    pendingDiscriminators: pendingDiscriminatorsForPlayer(state, player),
    updatedAt: deterministicTimestamps ? deterministicLedgerUpdatedAt(state, player) : nowIso(),
  };
  return player.memoryLedger;
}

export function rebuildAllMemoryLedgers(state, { deterministicTimestamps = false } = {}) {
  (state.players ?? []).forEach((player) => rebuildPlayerMemoryLedger(state, player.id, { deterministicTimestamps }));
}

function internalMemoryLength(memory) {
  return String(memory.summary ?? '').length
    + (memory.notes ?? []).reduce((sum, note) => sum + String(note.text ?? '').length, 0);
}

export function applyInternalMemoryUpdate(state, playerId, update, sourceAiTurnId = null) {
  const player = state.players.find((item) => item.id === playerId);
  if (!player || !update) return { changed: false };
  if (update.mode !== 'add') return { changed: false };
  const text = String(update.text ?? '').trim();
  if (!text) return { changed: false };
  player.internalMemory = createEmptyInternalMemory(player.internalMemory ?? {});
  const recentNotes = player.internalMemory.notes.slice(-INTERNAL_MEMORY_DUPLICATE_LOOKBACK);
  if (recentNotes.some((note) => String(note.text ?? '').trim() === text)) {
    return { changed: false, duplicate: true };
  }
  player.internalMemory.notes.push({
    id: createId('memo-note'),
    sourceAiTurnId,
    text,
    createdAt: nowIso(),
  });
  if (player.internalMemory.notes.length > INTERNAL_MEMORY_NOTE_LIMIT) {
    player.internalMemory.notes.splice(0, player.internalMemory.notes.length - INTERNAL_MEMORY_NOTE_LIMIT);
  }
  player.internalMemory.consolidationRecommended = player.internalMemory.notes.length > INTERNAL_MEMORY_CONSOLIDATION_NOTE_THRESHOLD
    || internalMemoryLength(player.internalMemory) > INTERNAL_MEMORY_CONSOLIDATION_LENGTH_THRESHOLD;
  return { changed: true };
}

export function consolidateInternalMemory(state, playerId, summary, {
  sourceAiTurnId = null,
  source = 'ai',
} = {}) {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return { ok: false, message: '対象プレイヤーが存在しません。' };
  const text = String(summary ?? '').trim();
  if (!text) return { ok: false, message: '整理後内部メモを入力してください。' };
  player.internalMemory = createEmptyInternalMemory(player.internalMemory ?? {});
  player.memoHistory ??= [];
  player.memoHistory.push({
    summary: player.internalMemory.summary,
    notes: player.internalMemory.notes.map((note) => ({ ...note })),
    consolidatedAt: nowIso(),
    source,
    sourceAiTurnId,
  });
  player.internalMemory.summary = text;
  player.internalMemory.notes = [];
  player.internalMemory.lastConsolidatedAt = nowIso();
  player.internalMemory.consolidationRecommended = false;
  return { ok: true, message: '自由内部メモを整理しました。' };
}

export function formatInternalMemoryText(player) {
  const memory = createEmptyInternalMemory(player?.internalMemory ?? {});
  const rows = [];
  if (memory.summary.trim()) rows.push(memory.summary.trim());
  if (memory.notes.length) {
    rows.push(memory.notes.map((note) => `- ${note.text}`).join('\n'));
  }
  return rows.join('\n\n').trim();
}

export function formatMemoryLedgerSnapshotForPrompt(ledgerValue, resolvePlayerName) {
  const ledger = createEmptyMemoryLedger(ledgerValue ?? {});
  const sections = [];
  const append = (label, values) => {
    if (!values.length) return;
    sections.push({
      label,
      values: values.map((item) => String(item.text ?? '')).filter(Boolean),
    });
  };
  append('秘密の確定情報', ledger.privateFacts ?? []);
  append('自分が公開済みの立場・行動', ledger.publicCommitments ?? []);
  append('結果判明前に保存した行動理由', (ledger.actionRationales ?? []).map((item) => ({
    text: `${item.taskType}: ${resolvePlayerName(item.targetId)} / ${item.rationale}`,
  })));
  append('次に区別したい情報', ledger.pendingDiscriminators ?? []);
  return sections;
}
