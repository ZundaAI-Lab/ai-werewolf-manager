/**
 * 責務: 処刑解決の対象、遺言、猫又道連れ、座敷わらし後追い、公開後死亡状態の整合を検査する。
 * 変更ルール: 投票集計や夜解決を再計算せず、確定済み処刑解決とプレイヤー状態の一致だけを検査する。凍結中の遺言自動スキップは処刑公開前のresolved状態だけ現在の状態異常から検査し、公開後は保存済み遺言状態と公開イベントの整合を検査する。
 */

import { FROZEN_TESTAMENT_SKIP_REASON, getTestamentAvailability } from '../../domain/execution/testamentPolicy.js';

export function validateExecutionState(context) {
  const { raw, label, errors, checkId, checkIds } = context;
  if (raw.executionResolution) {
    const resolution = raw.executionResolution;
    checkId(resolution.targetId, '処刑解決対象');
    checkId(resolution.collateralPlayerId, '処刑時の猫又道連れ対象');
    if (!['resolved', 'published'].includes(resolution.status)) errors.push(`${label}: 処刑解決状態が不正です。`);
    const testament = resolution.testament;
    const testamentStatuses = new Set(['pending', 'completed', 'skipped', 'not-required']);
    if (!testament || !testamentStatuses.has(testament.status)) errors.push(`${label}: 遺言状態が不正です。`);
    if (testament) {
      const enabled = raw.game.rules.testament?.enabled === true;
      const availability = resolution.status === 'resolved'
        ? getTestamentAvailability(raw, resolution.targetId)
        : null;
      if (!enabled && testament.status !== 'not-required') errors.push(`${label}: 遺言OFFなのに遺言待ち状態があります。`);
      if (enabled && testament.status === 'not-required') errors.push(`${label}: 遺言ONなのに遺言が不要扱いです。`);
      if (availability?.status === 'skipped' && testament.status !== 'skipped') errors.push(`${label}: 凍結中の処刑対象に遺言機会が残っています。`);
      if (availability?.status === 'skipped' && testament.status === 'skipped' && testament.skippedReason !== FROZEN_TESTAMENT_SKIP_REASON) errors.push(`${label}: 凍結中の遺言自動スキップ理由が不正です。`);
      if (testament.status === 'pending' && (testament.eventId !== null || testament.skippedReason !== '' || testament.completedAt !== null)) errors.push(`${label}: 遺言待ち状態の保存値が不正です。`);
      if (testament.status === 'completed') {
        const event = raw.events.find((item) => item.id === testament.eventId) ?? null;
        if (!event || event.type !== 'public-speech' || event.actorId !== resolution.targetId || event.payload?.speechKind !== 'testament') errors.push(`${label}: 遺言完了イベントが処刑対象の遺言公開発言ではありません。`);
        if (!testament.completedAt || testament.skippedReason) errors.push(`${label}: 遺言完了状態の完了情報が不正です。`);
      }
      if (testament.status === 'skipped' && (testament.eventId !== null || !String(testament.skippedReason ?? '').trim() || !testament.completedAt)) errors.push(`${label}: 遺言辞退状態の保存値が不正です。`);
      if (testament.status === 'not-required' && (testament.eventId !== null || testament.skippedReason !== '' || testament.completedAt !== null)) errors.push(`${label}: 遺言不要状態の保存値が不正です。`);
      if (resolution.status === 'published' && testament.status === 'pending') errors.push(`${label}: 遺言待ちのまま処刑が公開されています。`);
    }
    const deaths = Array.isArray(resolution.deaths) ? resolution.deaths : [];
    const deathById = new Map();
    deaths.forEach((death) => {
      checkId(death.playerId, '処刑解決の死亡者');
      checkId(death.triggerPlayerId, '処刑解決の能力発動元');
      checkIds(death.sourcePlayerIds, '処刑解決の原因プレイヤー');
      if (!['execution', 'cat-revenge', 'owner-follow'].includes(death.cause)) errors.push(`${label}: 処刑解決の死因が不正です。`);
      if (deathById.has(death.playerId)) errors.push(`${label}: 処刑解決の死亡者が重複しています。`);
      deathById.set(death.playerId, death);
    });
    const target = raw.players.find((player) => player.id === resolution.targetId) ?? null;
    if (deathById.get(resolution.targetId)?.cause !== 'execution') errors.push(`${label}: 処刑対象が処刑死として登録されていません。`);
    const revengeDeaths = deaths.filter((death) => death.cause === 'cat-revenge');
    if (target?.roleId === 'cat') {
      const aliveBeforeResolutionIds = new Set(raw.players
        .filter((player) => player.alive || deathById.has(player.id))
        .map((player) => player.id));
      const collateralCandidateIds = raw.players
        .filter((player) => player.id !== target.id && aliveBeforeResolutionIds.has(player.id))
        .map((player) => player.id);
      const expectedRevengeCount = collateralCandidateIds.length ? 1 : 0;
      if (revengeDeaths.length !== expectedRevengeCount) errors.push(`${label}: 処刑された猫又の道連れ件数が生存候補数と一致しません。`);
      const revenge = revengeDeaths[0] ?? null;
      if (revenge && !collateralCandidateIds.includes(revenge.playerId)) errors.push(`${label}: 処刑時の猫又道連れ対象が処刑直前の生存者ではありません。`);
      if ((resolution.collateralPlayerId ?? null) !== (revenge?.playerId ?? null)) errors.push(`${label}: 処刑時の猫又道連れ対象が死亡解決と一致しません。`);
      if (revenge?.triggerPlayerId !== target.id) errors.push(`${label}: 処刑時の猫又道連れ発動元が処刑対象と一致しません。`);
      if (revenge?.playerId === target.id) errors.push(`${label}: 猫又が自身を道連れ対象にしています。`);
    } else if (revengeDeaths.length || resolution.collateralPlayerId) {
      errors.push(`${label}: 猫又以外の処刑に道連れが含まれています。`);
    }
    deaths.filter((death) => death.cause === 'owner-follow').forEach((death) => {
      const follower = raw.players.find((player) => player.id === death.playerId);
      if (follower?.roleId !== 'zashikiWarashi' || follower.roleState?.ownerId !== death.triggerPlayerId || !deathById.has(death.triggerPlayerId)) errors.push(`${label}: 処刑時の座敷わらし後追いが家主死亡と一致しません。`);
    });
    raw.players.filter((player) => player.roleId === 'zashikiWarashi' && player.roleState?.ownerId && deathById.has(player.roleState.ownerId)).forEach((player) => {
      if (!deathById.has(player.id)) errors.push(`${label}: 家主が死亡していますが座敷わらしの後追いがありません。`);
    });
    if (resolution.status === 'published') {
      deaths.forEach((death) => {
        const player = raw.players.find((item) => item.id === death.playerId);
        if (player?.alive || player?.death?.cause !== death.cause || player?.death?.phase !== 'execution') errors.push(`${label}: 公開済み処刑の死亡状態が処刑解決と一致しません。`);
      });
    }
  }
}
