/**
 * 責務: 夜行動スロット、夜開始時生存者、能力実行、襲撃・護衛・凍結・死亡解決の保存値整合を検査する。
 * 変更ルール: 秘密会話本文・昼投票・処刑解決を扱わず、夜フェーズの確定事実を再計算保存せず検証だけ行う。後追い期待値は夜開始時生存者だけを対象とする。
 */

import { countsAsWolf, isActualFox, isBadChild, isNightActionActor } from '../../domain/roles/roleAttributes.js';
import { isFrozenOnDay } from '../../domain/game/playerStatus.js';

export function validateNightState(context) {
  const { raw, label, errors, checkId, checkIds } = context;
  const wolfConversationIdSet = new Set((raw.wolfConversations ?? []).map((session) => session.id));
  const masonConversationIdSet = new Set((raw.masonConversations ?? []).map((session) => session.id));
  const graveyardConversationIdSet = new Set((raw.graveyardConversations ?? []).map((session) => session.id));
  if (raw.night) {
    checkIds(raw.night.aliveAtStartIds, '夜開始時生存者');
    const aliveAtStart = new Set(raw.night.aliveAtStartIds ?? []);
    if (raw.night.wolfConversationId && !wolfConversationIdSet.has(raw.night.wolfConversationId)) errors.push(`${label}: night.wolfConversationIdの参照先がありません。`);
    if (raw.night.masonConversationId && !masonConversationIdSet.has(raw.night.masonConversationId)) errors.push(`${label}: night.masonConversationIdの参照先がありません。`);
    if (raw.night.graveyardConversationId && !graveyardConversationIdSet.has(raw.night.graveyardConversationId)) errors.push(`${label}: night.graveyardConversationIdの参照先がありません。`);
    const graveyardSession = raw.night.graveyardConversationId ? (raw.graveyardConversations ?? []).find((session) => session.id === raw.night.graveyardConversationId) ?? null : null;
    const expectedDeadAtStartIds = raw.players.filter((player) => !aliveAtStart.has(player.id)).map((player) => player.id).sort();
    if (raw.night.plan?.graveyardConversationRequired) {
      if (!graveyardSession) errors.push(`${label}: 墓場会話が必要な夜に会話セッションがありません。`);
      else if (JSON.stringify([...(graveyardSession.participantIds ?? [])].sort()) !== JSON.stringify(expectedDeadAtStartIds)) errors.push(`${label}: 墓場会話参加者が夜開始時死亡者と一致しません。`);
    } else if (raw.night.graveyardConversationId) {
      errors.push(`${label}: 墓場会話不要の夜に墓場会話セッションがあります。`);
    }
    const slotKeys = new Set();
    const submittedSlotsByType = {
      inspect: [],
      guard: [],
      visit: [],
      freeze: [],
      'choose-owner': [],
    };
    (raw.night.slots ?? []).forEach((slot) => {
      checkId(slot.actorId, '夜行動者');
      checkId(slot.targetId, '夜行動対象');
      const actor = raw.players.find((player) => player.id === slot.actorId);
      const target = raw.players.find((player) => player.id === slot.targetId);
      if (!Object.hasOwn(submittedSlotsByType, slot.type)) errors.push(`${label}: 夜行動スロット種別が不正です。`);
      if (actor && !isNightActionActor(raw, actor, slot.type)) errors.push(`${label}: 夜行動スロット種別と行動者の役職属性が一致しません。`);
      if (!aliveAtStart.has(slot.actorId)) errors.push(`${label}: 夜行動者が夜開始時の生存者ではありません。`);
      const key = `${slot.actorId}:${slot.type}`;
      if (slotKeys.has(key)) errors.push(`${label}: 同一人物の夜行動スロットが重複しています。`);
      slotKeys.add(key);
      const submitted = ['submitted', 'gm-override'].includes(slot.status);
      if (submitted && !slot.targetId) errors.push(`${label}: 提出済み夜行動に対象がありません。`);
      if (slot.rationale !== undefined && typeof slot.rationale !== 'string') errors.push(`${label}: 夜行動の選択理由が文字列ではありません。`);
      if (slot.aiTurnId && !String(slot.rationale ?? '').trim()) errors.push(`${label}: AI夜行動に結果判明前の選択理由がありません。`);
      if (slot.targetId) {
        if (!target || !aliveAtStart.has(slot.targetId)) errors.push(`${label}: 夜行動対象が夜開始時の生存者ではありません。`);
        if (slot.type === 'inspect' && slot.actorId === slot.targetId && !raw.game.rules.seer.selfTargetAllowed) errors.push(`${label}: 自己占い禁止ルールに反する夜行動です。`);
        if (slot.type === 'guard' && slot.actorId === slot.targetId && !raw.game.rules.guard.selfGuardAllowed) errors.push(`${label}: 自己護衛禁止ルールに反する夜行動です。`);
        if (['visit', 'freeze', 'choose-owner'].includes(slot.type) && slot.actorId === slot.targetId) errors.push(`${label}: ${slot.type}で自分自身が対象になっています。`);
        if (slot.type === 'visit' && submitted && actor?.roleState?.lastTargetId !== slot.targetId) errors.push(`${label}: なまはげの確定訪問先が直前訪問対象へ記録されていません。`);
        if (slot.type === 'freeze' && submitted && actor?.roleState?.lastTargetId !== slot.targetId) errors.push(`${label}: 雪女の確定対象が直前凍結対象へ記録されていません。`);
        if (slot.type === 'choose-owner' && submitted && actor?.roleState?.ownerId !== slot.targetId) errors.push(`${label}: 座敷わらしの確定家主が役職状態と一致しません。`);
      }
      if (submitted && submittedSlotsByType[slot.type]) submittedSlotsByType[slot.type].push(slot);
    });
    const submittedInspectSlots = submittedSlotsByType.inspect;
    const submittedGuardSlots = submittedSlotsByType.guard;
    const submittedVisitSlots = submittedSlotsByType.visit;
    const submittedFreezeSlots = submittedSlotsByType.freeze;
    const attack = raw.night.wolfAttack;
    const validAttackStatuses = new Set(['not-required', 'waiting-conversation', 'voting', 'confirmed']);
    if (!validAttackStatuses.has(attack?.status)) errors.push(`${label}: 襲撃投票状態が不正です。`);
    if (!Array.isArray(attack?.voterWolfIds)) {
      errors.push(`${label}: 襲撃投票権者一覧が配列ではありません。`);
    } else {
      checkIds(attack.voterWolfIds, '襲撃投票権者');
      if (new Set(attack.voterWolfIds).size !== attack.voterWolfIds.length) errors.push(`${label}: 襲撃投票権者が重複しています。`);
      attack.voterWolfIds.forEach((wolfId) => {
        const wolf = raw.players.find((player) => player.id === wolfId);
        if (!wolf || !aliveAtStart.has(wolfId) || !countsAsWolf(raw, wolf)) errors.push(`${label}: 襲撃投票権者が夜開始時の生存人狼ではありません。`);
      });
    }
    const voterWolfIds = attack?.voterWolfIds ?? [];
    const voterSet = new Set(voterWolfIds);
    const validateVoterMap = (value, mapLabel, validator) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${label}: ${mapLabel}が不正です。`);
        return;
      }
      const keys = Object.keys(value);
      if (keys.length !== voterSet.size || keys.some((key) => !voterSet.has(key))) errors.push(`${label}: ${mapLabel}の人狼一覧が投票権者と一致しません。`);
      voterWolfIds.forEach((wolfId) => validator(value[wolfId], wolfId));
    };
    validateVoterMap(attack?.voteByWolfId, '襲撃投票一覧', (targetId) => {
      if (targetId === null) return;
      checkId(targetId, '襲撃投票対象');
      const target = raw.players.find((player) => player.id === targetId);
      if (!target || !aliveAtStart.has(targetId) || countsAsWolf(raw, target)) errors.push(`${label}: 襲撃票が夜開始時の生存非人狼を対象としていません。`);
    });
    validateVoterMap(attack?.rationaleByWolfId, '襲撃投票理由一覧', (rationale) => {
      if (typeof rationale !== 'string') errors.push(`${label}: 襲撃投票理由が文字列ではありません。`);
    });
    validateVoterMap(attack?.overrideByWolfId, '襲撃投票代替情報一覧', (override) => {
      if (override === null) return;
      if (!override || typeof override !== 'object' || Array.isArray(override)) {
        errors.push(`${label}: 襲撃投票代替情報が不正です。`);
        return;
      }
      if (!String(override.type ?? '').trim()) errors.push(`${label}: 襲撃投票代替種別がありません。`);
      if (!String(override.selectedBy ?? '').trim()) errors.push(`${label}: 襲撃投票代替の実行者がありません。`);
      if (!String(override.reason ?? '').trim()) errors.push(`${label}: 襲撃投票代替の理由がありません。`);
      (override.candidateIds ?? []).forEach((id) => checkId(id, '襲撃投票代替候補'));
      checkId(override.selectedTargetId, '襲撃投票代替結果');
    });

    const submittedVoteEntries = Object.entries(attack?.voteByWolfId ?? {}).filter(([, targetId]) => Boolean(targetId));
    const expectedCounts = Object.fromEntries(submittedVoteEntries.reduce((map, [, targetId]) => map.set(targetId, (map.get(targetId) ?? 0) + 1), new Map()));
    const tally = attack?.tally;
    if (!tally || typeof tally !== 'object' || Array.isArray(tally)) {
      errors.push(`${label}: 襲撃投票集計が不正です。`);
    } else {
      const countsByTargetId = tally.countsByTargetId;
      if (!countsByTargetId || typeof countsByTargetId !== 'object' || Array.isArray(countsByTargetId)) {
        errors.push(`${label}: 襲撃対象別票数が不正です。`);
      } else {
        Object.entries(countsByTargetId).forEach(([targetId, count]) => {
          checkId(targetId, '襲撃集計対象');
          if (!Number.isInteger(count) || count < 1) errors.push(`${label}: 襲撃対象別票数が正の整数ではありません。`);
        });
      }
      checkIds(tally.topTargetIds, '襲撃最多票対象');
      if (!Array.isArray(tally.topTargetIds) || new Set(tally.topTargetIds).size !== tally.topTargetIds.length) errors.push(`${label}: 襲撃最多票対象一覧が不正です。`);
      if (![null, 'plurality', 'random-tie'].includes(tally.resolutionMethod)) errors.push(`${label}: 襲撃対象決定方法が不正です。`);
    }

    checkId(attack?.finalTargetId, '確定襲撃対象');
    if (attack?.finalTargetId) {
      const target = raw.players.find((player) => player.id === attack.finalTargetId);
      if (!target || !aliveAtStart.has(target.id) || countsAsWolf(raw, target)) errors.push(`${label}: 確定襲撃対象が夜開始時の生存非人狼ではありません。`);
    }
    if (attack?.status === 'confirmed') {
      if (submittedVoteEntries.length !== voterWolfIds.length) errors.push(`${label}: 襲撃確定状態に未投票の人狼がいます。`);
      if (!attack.finalTargetId) errors.push(`${label}: 襲撃確定状態に最終対象がありません。`);
      if (JSON.stringify(tally?.countsByTargetId ?? {}) !== JSON.stringify(expectedCounts)) errors.push(`${label}: 襲撃対象別票数が登録票と一致しません。`);
      const countValues = Object.values(expectedCounts);
      const maxVotes = countValues.length ? Math.max(...countValues) : 0;
      const expectedTopIds = Object.entries(expectedCounts).filter(([, count]) => count === maxVotes).map(([targetId]) => targetId);
      if (JSON.stringify(tally?.topTargetIds ?? []) !== JSON.stringify(expectedTopIds)) errors.push(`${label}: 襲撃最多票対象が登録票と一致しません。`);
      if (!expectedTopIds.includes(attack.finalTargetId)) errors.push(`${label}: 確定襲撃対象が最多票候補ではありません。`);
      const expectedMethod = expectedTopIds.length === 1 ? 'plurality' : 'random-tie';
      if (tally?.resolutionMethod !== expectedMethod) errors.push(`${label}: 襲撃対象決定方法が票数と一致しません。`);
    } else {
      if (attack?.finalTargetId !== null) errors.push(`${label}: 未確定の襲撃投票に最終対象があります。`);
      if (Object.keys(tally?.countsByTargetId ?? {}).length || (tally?.topTargetIds?.length ?? 0) || tally?.resolutionMethod !== null) errors.push(`${label}: 未確定の襲撃投票に集計結果があります。`);
      if (attack?.status === 'waiting-conversation' && submittedVoteEntries.length) errors.push(`${label}: 共有会話待機中に襲撃票があります。`);
    }
    if (raw.game.phase === 'dawn' && !raw.night.resolution) errors.push(`${label}: dawnフェーズに夜解決結果がありません。`);
    if (raw.night.resolution) {
      const resolution = raw.night.resolution;
      checkId(resolution.attackedTargetId, '夜解決の襲撃対象');
      checkIds(resolution.guardedTargetIds, '夜解決の護衛対象');
      checkIds(resolution.successfulGuardActorIds, '護衛成功者');
      checkIds(resolution.inspectedFoxIds, '占殺された妖狐');
      checkId(resolution.catCollateralWolfId, '猫又の道連れ人狼');
      checkId(resolution.freezeActorId, '凍結行動者');
      checkId(resolution.freezeTargetId, '凍結対象');
      checkId(resolution.frozenPlayerId, '翌昼の凍結者');
      (resolution.statusApplications ?? []).forEach((application) => {
        checkId(application.sourcePlayerId, '状態付与元');
        checkId(application.targetPlayerId, '状態付与対象');
        if (application.type !== 'fear') errors.push(`${label}: 夜解決の状態付与種別が不正です。`);
        if (!Number.isInteger(Number(application.appliedNightDay)) || Number(application.appliedNightDay) !== Number(raw.night.day)) {
          errors.push(`${label}: 夜解決の恐怖付与Dayが対象夜と一致しません。`);
        }
      });
      (resolution.actionExecutions ?? []).forEach((execution) => {
        checkIds(execution.actorIds, '夜行動の構成員');
        checkIds(execution.fearfulActorIds, '夜行動の恐怖状態構成員');
        checkIds(execution.consumedFearPlayerIds, '夜行動で解除する恐怖対象');
        if (!['wolf-attack', 'freeze'].includes(execution.actionType)) errors.push(`${label}: 夜行動制御のactionTypeが不正です。`);
        if (!['not-required', 'executed', 'blocked'].includes(execution.executionState)) errors.push(`${label}: 夜行動制御のexecutionStateが不正です。`);
        if (![null, 'fear'].includes(execution.blockReason)) errors.push(`${label}: 夜行動制御のblockReasonが不正です。`);
      });
      const deaths = Array.isArray(resolution.deaths) ? resolution.deaths : [];
      const deathById = new Map();
      deaths.forEach((death) => {
        checkId(death.playerId, '夜解決の死亡者');
        checkId(death.triggerPlayerId, '夜解決の能力発動元');
        checkIds(death.sourcePlayerIds, '夜解決の原因プレイヤー');
        if (!['wolf-attack', 'fox-divination', 'cat-revenge', 'owner-follow'].includes(death.cause)) errors.push(`${label}: 夜解決の死因が不正です。`);
        if (deathById.has(death.playerId)) errors.push(`${label}: 夜解決の死亡者が重複しています。`);
        deathById.set(death.playerId, death);
      });
      const plannedAttackTargetId = raw.night.plan?.wolfAttackRequired ? raw.night.wolfAttack?.finalTargetId ?? null : null;
      const expectedGuarded = [...new Set(submittedGuardSlots.map((slot) => slot.targetId).filter(Boolean))];
      const expectedStatusApplications = submittedVisitSlots
        .filter((slot) => aliveAtStart.has(slot.targetId) && isBadChild(raw, slot.targetId))
        .map((slot) => ({
          type: 'fear',
          sourcePlayerId: slot.actorId,
          targetPlayerId: slot.targetId,
          appliedNightDay: Number(raw.night.day),
        }));
      if (JSON.stringify(resolution.statusApplications ?? []) !== JSON.stringify(expectedStatusApplications)) {
        errors.push(`${label}: 夜解決の状態付与が訪問対象と悪い子属性に一致しません。`);
      }

      const recordedExecutions = Array.isArray(resolution.actionExecutions) ? resolution.actionExecutions : [];
      const recordedConsumedFearIds = new Set(recordedExecutions.flatMap((execution) => execution.consumedFearPlayerIds ?? []));
      const fearAtActionIds = new Set([
        ...raw.players
          .filter((player) => (player.statusEffects ?? []).some((effect) => effect.type === 'fear'))
          .map((player) => player.id),
        ...expectedStatusApplications.map((application) => application.targetPlayerId),
        ...recordedConsumedFearIds,
      ]);
      const aliveWolfIdsAtStart = raw.players
        .filter((player) => countsAsWolf(raw, player) && aliveAtStart.has(player.id))
        .map((player) => player.id);
      const expectedWolfFearIds = aliveWolfIdsAtStart.filter((id) => fearAtActionIds.has(id));
      const attackBlockedByFear = Boolean(plannedAttackTargetId)
        && aliveWolfIdsAtStart.length > 0
        && expectedWolfFearIds.length === aliveWolfIdsAtStart.length;
      const expectedAttackExecution = {
        actionType: 'wolf-attack',
        actorIds: plannedAttackTargetId ? aliveWolfIdsAtStart : [],
        fearfulActorIds: plannedAttackTargetId ? expectedWolfFearIds : [],
        executionState: !plannedAttackTargetId ? 'not-required' : attackBlockedByFear ? 'blocked' : 'executed',
        blockReason: attackBlockedByFear ? 'fear' : null,
        consumedFearPlayerIds: attackBlockedByFear ? expectedWolfFearIds : [],
      };

      const freezeSlot = submittedFreezeSlots[0] ?? null;
      const freezeActorIds = freezeSlot ? [freezeSlot.actorId] : [];
      const expectedFreezeFearIds = freezeActorIds.filter((id) => fearAtActionIds.has(id));
      const freezeBlockedByFear = Boolean(freezeSlot) && expectedFreezeFearIds.length === freezeActorIds.length;
      const expectedFreezeExecution = {
        actionType: 'freeze',
        actorIds: freezeActorIds,
        fearfulActorIds: expectedFreezeFearIds,
        executionState: !freezeSlot ? 'not-required' : freezeBlockedByFear ? 'blocked' : 'executed',
        blockReason: freezeBlockedByFear ? 'fear' : null,
        consumedFearPlayerIds: freezeBlockedByFear ? expectedFreezeFearIds : [],
      };
      const expectedActionExecutions = [expectedAttackExecution, expectedFreezeExecution];
      if (JSON.stringify(recordedExecutions) !== JSON.stringify(expectedActionExecutions)) {
        errors.push(`${label}: 夜行動の実行可否・恐怖蓄積・解除対象が共通行動制御と一致しません。`);
      }

      const expectedAttacked = expectedAttackExecution.executionState === 'executed' ? plannedAttackTargetId : null;
      const attackedPlayer = raw.players.find((player) => player.id === expectedAttacked) ?? null;
      const expectedAttackOutcome = !plannedAttackTargetId
        ? 'not-required'
        : attackBlockedByFear
          ? 'not-executed'
          : isActualFox(raw, attackedPlayer)
            ? 'fox-immune'
            : expectedGuarded.includes(expectedAttacked)
              ? 'guarded'
              : 'killed';
      const expectedSuccessfulGuards = expectedAttackOutcome === 'guarded'
        ? submittedGuardSlots.filter((slot) => slot.targetId === expectedAttacked).map((slot) => slot.actorId)
        : [];
      const expectedInspectedFoxIds = [...new Set(submittedInspectSlots
        .map((slot) => slot.targetId)
        .filter((id) => isActualFox(raw, id)))];
      if ((resolution.attackedTargetId ?? null) !== expectedAttacked) errors.push(`${label}: 夜解決の実行済み襲撃対象が行動開始判定と一致しません。`);
      if (resolution.attackOutcome !== expectedAttackOutcome) errors.push(`${label}: 夜解決の襲撃結果が行動開始判定・役職属性・護衛と一致しません。`);
      if (JSON.stringify([...(resolution.guardedTargetIds ?? [])].sort()) !== JSON.stringify([...expectedGuarded].sort())) errors.push(`${label}: 夜解決の護衛対象が提出済み護衛と一致しません。`);
      if (JSON.stringify([...(resolution.successfulGuardActorIds ?? [])].sort()) !== JSON.stringify([...expectedSuccessfulGuards].sort())) errors.push(`${label}: 夜解決の護衛成功者が提出済み護衛と一致しません。`);
      if (JSON.stringify([...(resolution.inspectedFoxIds ?? [])].sort()) !== JSON.stringify([...expectedInspectedFoxIds].sort())) errors.push(`${label}: 夜解決の占殺妖狐が提出済み占いと一致しません。`);
      expectedInspectedFoxIds.forEach((foxId) => {
        const foxDeath = deathById.get(foxId);
        if (foxDeath?.cause !== 'fox-divination') errors.push(`${label}: 占われた妖狐が占殺として死亡予定になっていません。`);
      });
      if (expectedAttackOutcome === 'killed' && expectedAttacked && deathById.get(expectedAttacked)?.cause !== 'wolf-attack') errors.push(`${label}: 成功した襲撃対象が襲撃死として登録されていません。`);
      if (expectedAttackOutcome !== 'killed' && expectedAttacked && deathById.get(expectedAttacked)?.cause === 'wolf-attack') errors.push(`${label}: 無効になった襲撃対象が襲撃死として登録されています。`);
      const catRevengeDeaths = deaths.filter((death) => death.cause === 'cat-revenge');
      if (expectedAttackOutcome === 'killed' && attackedPlayer?.roleId === 'cat') {
        const expectedRevengeCount = aliveWolfIdsAtStart.length ? 1 : 0;
        if (catRevengeDeaths.length !== expectedRevengeCount) errors.push(`${label}: 襲撃死した猫又の人狼道連れ件数が生存人狼数と一致しません。`);
        const revenge = catRevengeDeaths[0] ?? null;
        if (revenge && !aliveWolfIdsAtStart.includes(revenge.playerId)) errors.push(`${label}: 猫又の襲撃道連れ対象が夜開始時の生存人狼ではありません。`);
        if ((resolution.catCollateralWolfId ?? null) !== (revenge?.playerId ?? null)) errors.push(`${label}: 猫又道連れ人狼IDが死亡解決と一致しません。`);
      } else if (catRevengeDeaths.length || resolution.catCollateralWolfId) {
        errors.push(`${label}: 猫又が襲撃死していない夜に人狼道連れがあります。`);
      }
      const expectedBaseDeathIds = new Set([
        ...expectedInspectedFoxIds,
        ...(expectedAttackOutcome === 'killed' && expectedAttacked ? [expectedAttacked] : []),
        ...(resolution.catCollateralWolfId ? [resolution.catCollateralWolfId] : []),
      ]);
      raw.players.filter((player) => aliveAtStart.has(player.id) && player.roleId === 'zashikiWarashi' && player.roleState?.ownerId && expectedBaseDeathIds.has(player.roleState.ownerId)).forEach((player) => expectedBaseDeathIds.add(player.id));
      if (deaths.some((death) => !expectedBaseDeathIds.has(death.playerId)) || expectedBaseDeathIds.size !== deathById.size) errors.push(`${label}: 夜解決の死亡予定者が占い・襲撃・猫又道連れ・後追いと一致しません。`);
      deaths.filter((death) => death.cause === 'owner-follow').forEach((death) => {
        const follower = raw.players.find((player) => player.id === death.playerId);
        if (follower?.roleId !== 'zashikiWarashi' || follower.roleState?.ownerId !== death.triggerPlayerId || !deathById.has(death.triggerPlayerId)) errors.push(`${label}: 座敷わらしの後追い死亡が家主死亡と一致しません。`);
      });
      const expectedFreezeTargetId = expectedFreezeExecution.executionState === 'executed'
        ? freezeSlot?.targetId ?? null
        : null;
      let expectedFreezeOutcome = 'not-required';
      let expectedFrozenPlayerId = null;
      if (freezeSlot) {
        if (freezeBlockedByFear) expectedFreezeOutcome = 'not-executed';
        else if (expectedGuarded.includes(expectedFreezeTargetId)) expectedFreezeOutcome = 'guarded';
        else if (deathById.has(expectedFreezeTargetId)) expectedFreezeOutcome = 'target-dead';
        else {
          expectedFreezeOutcome = 'applied';
          expectedFrozenPlayerId = expectedFreezeTargetId;
        }
      }
      if ((resolution.freezeActorId ?? null) !== (freezeSlot?.actorId ?? null)) errors.push(`${label}: 凍結行動者が提出済み行動と一致しません。`);
      if ((resolution.freezeTargetId ?? null) !== expectedFreezeTargetId) errors.push(`${label}: 夜解決の実行済み凍結対象が行動開始判定と一致しません。`);
      if (resolution.freezeOutcome !== expectedFreezeOutcome) errors.push(`${label}: 凍結結果が行動開始判定・護衛・死亡状態と一致しません。`);
      if ((resolution.frozenPlayerId ?? null) !== expectedFrozenPlayerId) errors.push(`${label}: 翌昼の凍結者が凍結結果と一致しません。`);
      const privateInspectKeys = new Set((resolution.privateResults ?? []).filter((entry) => entry.actionType === 'inspect').map((entry) => `${entry.actorId}:${entry.targetId}`));
      submittedInspectSlots.forEach((slot) => {
        if (!privateInspectKeys.has(`${slot.actorId}:${slot.targetId}`)) errors.push(`${label}: 提出済み占いに対応する私的結果がありません。`);
      });
      if (Number(raw.game.day) > Number(raw.night.day)) {
        deaths.forEach((death) => {
          const player = raw.players.find((item) => item.id === death.playerId);
          if (player?.alive || player?.death?.cause !== death.cause || Number(player?.death?.day) !== Number(raw.night.day) + 1) errors.push(`${label}: 公開済み夜明けの死亡状態が夜解決結果と一致しません。`);
        });
        if (expectedFrozenPlayerId && !isFrozenOnDay(raw, expectedFrozenPlayerId, Number(raw.night.day) + 1)) errors.push(`${label}: 公開済み夜明けの凍結状態が夜解決結果と一致しません。`);
        const consumedFearIds = new Set(expectedActionExecutions.flatMap((execution) => execution.consumedFearPlayerIds));
        const expectedPersistingFearIds = new Set([
          ...expectedStatusApplications.map((application) => application.targetPlayerId),
          ...expectedActionExecutions.flatMap((execution) => execution.fearfulActorIds),
        ]);
        consumedFearIds.forEach((playerId) => {
          const player = raw.players.find((item) => item.id === playerId);
          if ((player?.statusEffects ?? []).some((effect) => effect.type === 'fear')) {
            errors.push(`${label}: 行動阻害後に${player?.name ?? playerId}の恐怖が解除されていません。`);
          }
        });
        expectedPersistingFearIds.forEach((playerId) => {
          if (consumedFearIds.has(playerId) || deathById.has(playerId)) return;
          const player = raw.players.find((item) => item.id === playerId);
          if (!(player?.statusEffects ?? []).some((effect) => effect.type === 'fear')) {
            errors.push(`${label}: 行動が実行された構成員${player?.name ?? playerId}の恐怖が維持されていません。`);
          }
        });
      }
    }
  }
}
