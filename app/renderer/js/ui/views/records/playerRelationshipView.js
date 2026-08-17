/**
 * 責務: リアルタイムまたは日終了スナップショットのプレイヤー相関モデルを、公開／機密境界と選択中レイヤーに従って描画する。
 * 変更ルール: ゲーム状態とスナップショットを更新しない。モデル構築・日終了保存・死亡時点別の疑い線除外はdomain/records/playerRelationshipModel.jsへ委譲し、機密情報非表示時は疑い関係・疑い強度・真役職をDOMへ生成しない。公開能力結果はそのゲームの配役に含まれる公開主張可能役職だけを独立レイヤーとして切り替え、配役に存在しない役職の切替UIは生成しない。線種は能力役職、疑い線は判断強度を表示クラスへ射影する。状態由来の文字列と識別子は必ずHTMLエスケープする。
 */

import {
  buildPlayerRelationshipModel,
  PLAYER_RELATIONSHIP_LABELS,
  PLAYER_RELATIONSHIP_TYPES,
  projectPlayerRelationshipSnapshot,
} from '../../../domain/records/playerRelationshipModel.js';
import { PUBLIC_ABILITY_ROLE_IDS } from '../../../domain/policies/publicAbilityClaimPolicy.js';
import { escapeHtml } from '../../../shared/utils.js';

const GRAPH_WIDTH = 1180;
const GRAPH_HEIGHT = 700;
const NODE_WIDTH = 166;
const NODE_HEIGHT = 86;
const RELATION_TYPES = PLAYER_RELATIONSHIP_TYPES;
const ABILITY_LAYER_PREFIX = 'ability:';
const DEFAULT_VISIBLE_RELATION_LAYERS = Object.freeze([
  'suspicion',
  ...PUBLIC_ABILITY_ROLE_IDS.map((roleId) => `${ABILITY_LAYER_PREFIX}${roleId}`),
]);

function abilityLayerKey(roleId) {
  return `${ABILITY_LAYER_PREFIX}${String(roleId ?? '')}`;
}

function isVisibleLayerKey(value) {
  if (['suspicion', 'vote'].includes(value)) return true;
  if (!value.startsWith(ABILITY_LAYER_PREFIX)) return false;
  return PUBLIC_ABILITY_ROLE_IDS.includes(value.slice(ABILITY_LAYER_PREFIX.length));
}

function edgeLayerKey(edge) {
  return edge.type === 'ability' ? abilityLayerKey(edge.abilityRoleId) : edge.type;
}

const SUSPICION_STRENGTH_LABELS = Object.freeze({
  unresolved: '未確定',
  slight: '弱い',
  moderate: '中程度',
  strong: '強い',
});

function compact(value, maxLength = 16) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function nodePositions(nodes) {
  const count = Math.max(1, nodes.length);
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT / 2 - 8;
  const radiusX = count <= 6 ? 390 : count <= 10 ? 455 : 492;
  const radiusY = count <= 6 ? 225 : count <= 10 ? 252 : 270;
  return new Map(nodes.map((node, index) => {
    const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / count);
    return [node.id, {
      x: centerX + (Math.cos(angle) * radiusX),
      y: centerY + (Math.sin(angle) * radiusY),
      index,
    }];
  }));
}

function relationTypeIndex(type) {
  return Math.max(0, RELATION_TYPES.indexOf(type));
}

function nodeBoundaryDistance(ux, uy) {
  const horizontal = Math.abs(ux) > 0.0001 ? (NODE_WIDTH / 2) / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const vertical = Math.abs(uy) > 0.0001 ? (NODE_HEIGHT / 2) / Math.abs(uy) : Number.POSITIVE_INFINITY;
  return Math.min(horizontal, vertical) + 4;
}

function edgeLabelOffset(edgeType, bend) {
  const baseOffset = edgeType === 'ability'
    ? 15
    : edgeType === 'vote'
      ? 17
      : 13;
  const direction = bend === 0 ? 1 : Math.sign(bend);
  return baseOffset * direction;
}

function edgeGeometry(edge, positions, reverseKeys) {
  const source = positions.get(edge.sourceId);
  const target = positions.get(edge.targetId);
  if (!source || !target) return null;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const boundaryDistance = nodeBoundaryDistance(ux, uy);
  const start = { x: source.x + (ux * boundaryDistance), y: source.y + (uy * boundaryDistance) };
  const end = { x: target.x - (ux * boundaryDistance), y: target.y - (uy * boundaryDistance) };
  const perpendicular = { x: -uy, y: ux };
  const reverseExists = reverseKeys.has(`${edge.type}:${edge.targetId}:${edge.sourceId}`);
  // 相互方向の線では進行方向そのものが反転するため、同じbend符号を使うことで
  // 垂直ベクトルの反転をそのまま左右分離へ利用する。ここでsource/target順による符号反転を
  // 重ねると2本が同じ側へ曲がり、実質1本に重なってしまう。
  const bend = reverseExists
    ? 42
    : ((relationTypeIndex(edge.type) - 1) * 15);
  const control = {
    x: ((start.x + end.x) / 2) + (perpendicular.x * bend),
    y: ((start.y + end.y) / 2) + (perpendicular.y * bend),
  };
  const curveMidpoint = {
    x: (start.x + (2 * control.x) + end.x) / 4,
    y: (start.y + (2 * control.y) + end.y) / 4,
  };
  const labelOffset = edgeLabelOffset(edge.type, bend);
  return {
    path: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    labelX: (curveMidpoint.x + (perpendicular.x * labelOffset)).toFixed(1),
    labelY: (curveMidpoint.y + (perpendicular.y * labelOffset)).toFixed(1),
  };
}

function relationClass(type) {
  return `relationship-edge-${type}`;
}

function markerId(type, variant = '') {
  return `relationship-arrow-${type}${variant ? `-${variant}` : ''}`;
}

function abilityVariant(edge) {
  if (edge.abilityRoleId === 'seer') return 'seer';
  if (edge.abilityRoleId === 'medium') return 'medium';
  return 'other';
}

function normalizedSuspicionStrength(value) {
  return Object.hasOwn(SUSPICION_STRENGTH_LABELS, value) ? value : 'unresolved';
}

function renderMarkerDefinitions() {
  const marker = (id) => `<marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker>`;
  return [
    marker(markerId('suspicion')),
    marker(markerId('ability', 'seer')),
    marker(markerId('ability', 'medium')),
    marker(markerId('ability', 'other')),
    marker(markerId('vote')),
  ].join('');
}

function renderEdges(edges, positions, selectedPlayerId, suspicionStrengthBySource) {
  const reverseKeys = new Set(edges.map((edge) => `${edge.type}:${edge.sourceId}:${edge.targetId}`));
  return edges.map((edge, index) => {
    const geometry = edgeGeometry(edge, positions, reverseKeys);
    if (!geometry) return '';
    const connected = !selectedPlayerId || edge.sourceId === selectedPlayerId || edge.targetId === selectedPlayerId;
    const abilityRoleVariant = edge.type === 'ability' ? abilityVariant(edge) : '';
    const suspicionStrength = edge.type === 'suspicion'
      ? normalizedSuspicionStrength(suspicionStrengthBySource.get(edge.sourceId))
      : '';
    const variantClass = edge.type === 'ability'
      ? `relationship-ability-${abilityRoleVariant}`
      : edge.type === 'suspicion'
        ? `relationship-suspicion-strength-${suspicionStrength}`
        : '';
    const className = `relationship-edge ${relationClass(edge.type)} ${variantClass} ${connected ? '' : 'is-dimmed'}`;
    const pathId = `relationship-edge-path-${index}`;
    const label = edge.type === 'ability' ? String(edge.graphLabel || edge.label || '').trim() : '';
    const title = edge.type === 'suspicion'
      ? `疑い（${SUSPICION_STRENGTH_LABELS[suspicionStrength]}）`
      : edge.label;
    const markerVariant = edge.type === 'ability' ? abilityRoleVariant : '';
    return `<g class="${className}"><title>${escapeHtml(title)}</title><path id="${pathId}" d="${geometry.path}" marker-end="url(#${markerId(edge.type, markerVariant)})"></path>${label ? `<text x="${geometry.labelX}" y="${geometry.labelY}"><tspan>${escapeHtml(compact(label, 12))}</tspan></text>` : ''}</g>`;
  }).join('');
}

function renderNodes(nodes, positions, edges, selectedPlayerId) {
  const relatedIds = new Set();
  if (selectedPlayerId) {
    relatedIds.add(selectedPlayerId);
    edges.forEach((edge) => {
      if (edge.sourceId === selectedPlayerId) relatedIds.add(edge.targetId);
      if (edge.targetId === selectedPlayerId) relatedIds.add(edge.sourceId);
    });
  }
  return nodes.map((node) => {
    const position = positions.get(node.id);
    const selected = selectedPlayerId === node.id;
    const dimmed = Boolean(selectedPlayerId && !relatedIds.has(node.id));
    const coText = node.claimedRoleName ? `${node.claimedRoleName}CO` : 'COなし';
    const roleText = node.actualRoleName ? `真役職: ${node.actualRoleName}` : '';
    return `<g class="relationship-node ${node.alive ? 'is-alive' : 'is-dead'} ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''}" transform="translate(${(position.x - (NODE_WIDTH / 2)).toFixed(1)} ${(position.y - (NODE_HEIGHT / 2)).toFixed(1)})" data-action="relationship-select-player" data-player-id="${escapeHtml(node.id)}"><title>${escapeHtml(`${node.name}、${coText}${roleText ? `、${roleText}` : ''}`)}</title><rect width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="14"></rect><circle cx="17" cy="19" r="5"></circle><text class="relationship-node-name" x="30" y="24">${escapeHtml(compact(node.name, 15))}</text><text class="relationship-node-co" x="14" y="50">${escapeHtml(compact(coText, 19))}</text>${roleText ? `<text class="relationship-node-role" x="14" y="70">${escapeHtml(compact(roleText, 21))}</text>` : ''}</g>`;
  }).join('');
}

function configuredPublicAbilityRoleIds(state) {
  const configuredRoleIds = new Set((state?.players ?? []).map((player) => player.roleId));
  return PUBLIC_ABILITY_ROLE_IDS.filter((roleId) => configuredRoleIds.has(roleId));
}

function renderLegend(model, visibleTypes, getRoleName, state) {
  const abilityItems = configuredPublicAbilityRoleIds(state).map((roleId) => ({
    layerKey: abilityLayerKey(roleId),
    relationType: 'ability',
    roleId,
    label: `${getRoleName(roleId)}結果`,
    count: model.edges.filter((edge) => edge.type === 'ability' && edge.abilityRoleId === roleId).length,
    disabled: false,
  }));
  const items = [
    { layerKey: 'suspicion', relationType: 'suspicion', roleId: null, label: model.showConfidential ? '疑い' : '疑い（機密情報）', count: model.counts.suspicion, disabled: !model.showConfidential },
    ...abilityItems,
    { layerKey: 'vote', relationType: 'vote', roleId: null, label: model.latestVoteDay === null ? '公開投票' : `Day ${model.latestVoteDay} 投票`, count: model.counts.vote, disabled: false },
  ];
  return `<div class="relationship-layer-controls" aria-label="表示する関係">${items.map((item) => {
    const active = visibleTypes.has(item.layerKey) && !item.disabled;
    const abilityClass = item.relationType === 'ability' ? `relationship-ability-${abilityVariant({ abilityRoleId: item.roleId })}` : '';
    return `<button class="relationship-layer-toggle ${relationClass(item.relationType)} ${abilityClass} ${active ? 'is-active' : ''}" data-action="relationship-toggle-layer" data-relation-type="${escapeHtml(item.layerKey)}" aria-pressed="${active}" ${item.disabled ? 'disabled' : ''} type="button"><span></span>${escapeHtml(item.label)} <strong>${item.count}</strong></button>`;
  }).join('')}</div>`;
}

function namesForIds(ids, nodeById) {
  return (ids ?? []).map((id) => nodeById.get(id)?.name).filter(Boolean);
}

function renderSelectedPlayerDetail(model, selectedPlayerId, getRoleName, visibleTypes) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const selected = nodeById.get(selectedPlayerId) ?? null;
  if (!selected) {
    return `<div class="relationship-summary"><h3>相関図の見方</h3><p>プレイヤーを選ぶと、その人物から出る関係と向けられている関係を強調します。</p><dl><div><dt>参加者</dt><dd>${model.nodes.length}名</dd></div><div><dt>CO中</dt><dd>${model.nodes.filter((node) => node.claimedRoleId).length}名</dd></div><div><dt>疑い関係</dt><dd>${model.showConfidential ? `${model.counts.suspicion}本` : '機密情報非表示'}</dd></div><div><dt>公開能力結果</dt><dd>${model.counts.ability}本</dd></div><div><dt>公開投票</dt><dd>${model.counts.vote}本</dd></div></dl></div>`;
  }

  const outgoingSuspicion = model.edges.filter((edge) => edge.type === 'suspicion' && edge.sourceId === selected.id);
  const incomingSuspicion = model.edges.filter((edge) => edge.type === 'suspicion' && edge.targetId === selected.id);
  const abilityClaims = model.edges.filter((edge) => edge.type === 'ability'
    && edge.sourceId === selected.id
    && visibleTypes.has(edgeLayerKey(edge)));
  const votes = model.edges.filter((edge) => edge.type === 'vote' && edge.sourceId === selected.id);
  const outgoingNames = namesForIds(outgoingSuspicion.map((edge) => edge.targetId), nodeById);
  const incomingNames = namesForIds(incomingSuspicion.map((edge) => edge.sourceId), nodeById);

  return `<div class="relationship-player-detail"><div class="relationship-detail-head"><div><span>${selected.alive ? '生存' : '死亡'}・${selected.controller === 'ai' ? 'AI' : '人間'}</span><h3>${escapeHtml(selected.name)}</h3></div><button class="button ghost small" data-action="relationship-clear-selection" type="button">全体表示</button></div><dl class="relationship-detail-list"><div><dt>公開CO</dt><dd>${selected.claimedRoleId ? escapeHtml(`${selected.claimedRoleName}CO`) : 'なし'}</dd></div>${selected.actualRoleId ? `<div><dt>真の役職</dt><dd>${escapeHtml(getRoleName(selected.actualRoleId))}</dd></div>` : ''}<div><dt>疑っている相手</dt><dd>${model.showConfidential ? escapeHtml(outgoingNames.join('、') || 'なし') : '機密情報非表示'}</dd></div><div><dt>疑いを向けている相手</dt><dd>${model.showConfidential ? escapeHtml(incomingNames.join('、') || 'なし') : '機密情報非表示'}</dd></div><div><dt>公開能力結果</dt><dd>${abilityClaims.length ? abilityClaims.map((edge) => `${escapeHtml(nodeById.get(edge.targetId)?.name ?? '不明')}：${escapeHtml(edge.label)}`).join('<br>') : 'なし'}</dd></div><div><dt>最新の公開投票</dt><dd>${votes.length ? escapeHtml(nodeById.get(votes[0].targetId)?.name ?? '不明') : 'なし'}</dd></div></dl></div>`;
}

function renderPlayerIndex(nodes, selectedPlayerId) {
  return `<div class="relationship-player-index" aria-label="プレイヤー一覧">${nodes.map((node) => `<button class="relationship-player-index-item ${selectedPlayerId === node.id ? 'is-selected' : ''} ${node.alive ? '' : 'is-dead'}" data-action="relationship-select-player" data-player-id="${escapeHtml(node.id)}" type="button"><span>${escapeHtml(node.name)}</span><small>${node.claimedRoleName ? escapeHtml(`${node.claimedRoleName}CO`) : 'COなし'}</small></button>`).join('')}</div>`;
}

function renderSnapshotSelector(snapshots, selectedSnapshotId) {
  const items = [...(snapshots ?? [])].sort((left, right) => Number(left.day) - Number(right.day));
  return `<div class="relationship-snapshot-bar"><div><span>表示時点</span><strong>${selectedSnapshotId ? `Day ${Number(items.find((item) => item.id === selectedSnapshotId)?.day ?? 0)} 終了時点` : 'リアルタイム'}</strong></div><div class="relationship-snapshot-list" role="tablist" aria-label="相関図の表示時点"><button class="relationship-snapshot-button ${selectedSnapshotId ? '' : 'is-active'}" data-action="relationship-select-snapshot" data-snapshot-id="" role="tab" aria-selected="${!selectedSnapshotId}" type="button">リアルタイム</button>${items.map((snapshot) => `<button class="relationship-snapshot-button ${selectedSnapshotId === snapshot.id ? 'is-active' : ''}" data-action="relationship-select-snapshot" data-snapshot-id="${escapeHtml(snapshot.id)}" role="tab" aria-selected="${selectedSnapshotId === snapshot.id}" type="button">Day ${Number(snapshot.day)} 終了</button>`).join('')}</div></div>`;
}

export function renderPlayerRelationshipView({
  state,
  showConfidential = false,
  selectedPlayerId = '',
  selectedSnapshotId = '',
  visibleRelationTypes = DEFAULT_VISIBLE_RELATION_LAYERS,
  getRoleName = (roleId) => roleId ?? '',
} = {}) {
  const visibleTypes = new Set((visibleRelationTypes ?? []).filter((type) => isVisibleLayerKey(type)));
  const snapshot = (state.relationshipSnapshots ?? []).find((item) => item.id === selectedSnapshotId) ?? null;
  const model = snapshot
    ? projectPlayerRelationshipSnapshot(snapshot, { showConfidential, state })
    : buildPlayerRelationshipModel(state, { showConfidential, getRoleName });
  const resolvedSnapshotId = snapshot?.id ?? '';
  const validSelectedPlayerId = model.nodes.some((node) => node.id === selectedPlayerId) ? selectedPlayerId : '';
  const edges = model.edges.filter((edge) => visibleTypes.has(edgeLayerKey(edge)));
  const positions = nodePositions(model.nodes);
  const suspicionStrengthBySource = new Map(model.nodes.map((node) => [node.id, node.suspicionStrength]));
  const hasAnyRelation = edges.length > 0;
  const viewTitle = snapshot ? `Day ${Number(snapshot.day)} 終了時点` : 'リアルタイム';

  return `<section class="player-relationship-view panel">${renderSnapshotSelector(state.relationshipSnapshots, resolvedSnapshotId)}<div class="relationship-toolbar"><div><span class="eyebrow">プレイヤー相関図・${escapeHtml(viewTitle)}</span><h3>CO・疑い・公開結果</h3></div>${renderLegend(model, visibleTypes, getRoleName, state)}</div><div class="relationship-layout"><div class="relationship-canvas-wrap"><svg class="relationship-canvas" viewBox="0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}" role="img" aria-label="${escapeHtml(viewTitle)}のプレイヤーCOと関係を示す相関図"><defs>${renderMarkerDefinitions()}</defs>${renderEdges(edges, positions, validSelectedPlayerId, suspicionStrengthBySource)}${renderNodes(model.nodes, positions, edges, validSelectedPlayerId)}</svg>${hasAnyRelation ? '' : `<div class="relationship-empty">${!showConfidential && model.counts.ability === 0 && model.counts.vote === 0 ? 'CO以外の公開関係はまだありません。疑い関係は機密情報を表示すると確認できます。' : '選択中の関係はまだ記録されていません。'}</div>`}</div><aside class="relationship-side-panel">${renderSelectedPlayerDetail(model, validSelectedPlayerId, getRoleName, visibleTypes)}${renderPlayerIndex(model.nodes, validSelectedPlayerId)}</aside></div></section>`;
}

export {
  buildPlayerRelationshipModel,
  PLAYER_RELATIONSHIP_LABELS,
  PLAYER_RELATIONSHIP_TYPES,
};
