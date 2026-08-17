/**
 * 責務: correctsEventIdで連結されたイベント訂正系列の起点・全系列・指定時点の正本・現在公開中の正本を決定的に解決する。
 * 変更ルール: 状態を更新しない。訂正対象の意味や公開可否を判断せず、同一イベント種別のcorrectsEventId参照だけを追跡する。
 */

function bySequence(left, right) {
  return Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}

function eventById(events, eventOrId) {
  if (eventOrId && typeof eventOrId === 'object') return eventOrId;
  return (events ?? []).find((event) => event.id === eventOrId) ?? null;
}

export function getCorrectionRootEvent(events, eventOrId) {
  let current = eventById(events, eventOrId);
  if (!current) return null;
  const visited = new Set();
  while (current?.payload?.correctsEventId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = eventById(events, current.payload.correctsEventId);
    if (!parent || parent.type !== current.type) break;
    current = parent;
  }
  return current;
}

export function collectCorrectionLineage(events, eventOrId) {
  const root = getCorrectionRootEvent(events, eventOrId);
  if (!root) return [];
  const lineage = [root];
  const visited = new Set([root.id]);
  let current = root;
  while (current) {
    const children = (events ?? [])
      .filter((event) => event.type === root.type && event.payload?.correctsEventId === current.id)
      .sort(bySequence);
    const child = children.at(-1) ?? null;
    if (!child || visited.has(child.id)) break;
    lineage.push(child);
    visited.add(child.id);
    current = child;
  }
  return lineage;
}

export function collectCorrectionLineageIds(events, eventOrId) {
  return collectCorrectionLineage(events, eventOrId).map((event) => event.id);
}

export function resolvePublishedCorrectionHead(events, eventOrId) {
  return collectCorrectionLineage(events, eventOrId)
    .filter((event) => event.status === 'published')
    .at(-1) ?? null;
}

export function resolveCorrectionHeadAtSequence(events, eventOrId, maximumSequence) {
  const limit = Number(maximumSequence);
  if (!Number.isFinite(limit)) return collectCorrectionLineage(events, eventOrId).at(-1) ?? null;
  return collectCorrectionLineage(events, eventOrId)
    .filter((event) => Number(event.sequence ?? 0) <= limit)
    .at(-1) ?? null;
}

export function getLogicalEventSequence(events, eventOrId) {
  return Number(getCorrectionRootEvent(events, eventOrId)?.sequence ?? 0);
}
