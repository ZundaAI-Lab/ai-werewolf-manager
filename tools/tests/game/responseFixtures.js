/**
 * 責務: AI応答JSONのテスト入力を、実運用と同じ現行契約で生成する。
 * 変更ルール: 旧見出し形式を再現しない。応答契約の変更時はテスト内へ文字列連結を散らさず本ファイルを更新する。
 */

export function stringifyResponse(value) {
  return JSON.stringify(value, null, 2);
}

export function decisionUpdate({
  suspicionCandidates = [],
  executionCandidates = [],
  intendedVote = undefined,
  assessmentLevel = 'unresolved',
  leaveAliveBenefit = '判断を翌日へ延ばすことで追加情報を得られる可能性がある',
  misexecutionCost = '人狼ではない対象を処刑すると処刑余裕と陣営票を失う',
  selectionDifference = '候補間の公開情報と今回処刑する価値の差',
  uncertainty = null,
  nextDiscriminatingInformation = null,
  decisionReason = '現在の公開情報では候補を絞れないため',
  compact = false,
  correctedSpeechSequences = [],
  evidenceEventSequences = [],
} = {}) {
  const patch = { suspicionCandidates, executionCandidates, assessmentLevel };
  if (intendedVote !== undefined) patch.intendedVote = intendedVote;
  if (uncertainty !== null) patch.uncertainty = uncertainty;
  if (!compact) Object.assign(patch, { leaveAliveBenefit, misexecutionCost, selectionDifference });
  if (nextDiscriminatingInformation !== null) patch.nextDiscriminatingInformation = nextDiscriminatingInformation;
  if (decisionReason) patch.reason = decisionReason;
  if (correctedSpeechSequences.length) patch.correctedSpeechSequences = correctedSpeechSequences;
  if (evidenceEventSequences.length) patch.evidenceEventSequences = evidenceEventSequences;
  return patch;
}

export function factionStrategyChanges(roleId = 'wolf', overrides = {}) {
  const values = {
    wolf: {
      publicWorld: '公開された発言と投票だけから、必要な偽役職が少ない世界が成立している',
      dayWinPath: '対象A処刑へあと一票を動かし、人狼二人生存を維持する',
      partnerDisposition: 'independent',
      collapsePlan: '仲間の主張が崩れた場合は切り離し、自分だけが残る小さい公開世界へ移る',
      failureRisk: '票移動に失敗し仲間を失ったうえで自分も占い対象へ固定される',
    },
    madman: {
      publicWorld: '公開情報から対象Aと対象Bのどちらも人狼候補として成立する',
      dayWinPath: '対象C処刑へあと一票を動かし、人狼候補の即処刑を避ける',
      linkageRisk: '対象Aへの擁護を重ねると、対象Aが崩れた際に一体視される',
      fallbackRoute: '対象Aが崩れたら誤認として切り離し、別役職比較で縄を使わせる',
      failureRisk: '誤認した対象を囲って人狼本体へ票を集中させる',
    },
    fox: {
      publicWorld: '公開情報から占い候補と処刑候補を分離できる',
      pressureGoal: '自分への占いと処刑を避けつつ通常陣営の人数を減らす',
      failureRisk: '占い理由の比較から自分へ占いが向く',
      nextDayPlan: '夜死亡と能力結果に応じて生存可能性を残す説明へ更新する',
    },
  };
  return { ...values[roleId], ...overrides };
}

export function factionStrategyPatch(roleId = 'wolf', overrides = {}, { mode = 'patch' } = {}) {
  return {
    mode,
    changes: mode === 'keep' ? {} : factionStrategyChanges(roleId, overrides),
  };
}

export function speechResponse(text, {
  speechInteraction = { questionTargets: [], answerEventSequences: [] },
  coOperation,
  abilityClaims,
  decision = decisionUpdate({ compact: true }),
  factionStrategyUpdate,
  heartVoice = '少し緊張するのだ。',
  memoAdd,
  internalMemoUpdate,
} = {}) {
  const payload = {
    publicSpeech: text,
    speechInteraction,
    decisionPatch: decision,
    heartVoice,
  };
  if (coOperation !== undefined) payload.coOperation = coOperation;
  if (abilityClaims !== undefined) payload.abilityClaims = abilityClaims;
  if (factionStrategyUpdate !== undefined) payload.factionStrategyUpdate = factionStrategyUpdate;
  const memo = memoAdd ?? internalMemoUpdate?.text;
  if (memo !== undefined) payload.memoAdd = memo;
  return stringifyResponse(payload);
}

export function voteResponse(actionAnswer, {
  decision = decisionUpdate({
    suspicionCandidates: [actionAnswer],
    executionCandidates: [actionAnswer],
    decisionReason: '',
  }),
  actionRationale = '公開情報と候補比較から、この相手の処刑価値が最も高いと判断したためです。',
  factionStrategyUpdate,
  memoAdd,
  internalMemoUpdate,
} = {}) {
  const payload = { actionAnswer, actionRationale, decisionPatch: decision };
  if (factionStrategyUpdate !== undefined) payload.factionStrategyUpdate = factionStrategyUpdate;
  const memo = memoAdd ?? internalMemoUpdate?.text;
  if (memo !== undefined) payload.memoAdd = memo;
  return stringifyResponse(payload);
}

export function nightActionResponse(actionAnswer, {
  actionRationale = '結果判明前の公開情報を比較し、他候補より価値が高いと判断したためです。',
} = {}) {
  return stringifyResponse({ actionAnswer, actionRationale });
}

export function freezeActionResponse(actionAnswer, {
  estimatedWerewolfIds,
  predictedAttackTargetIds,
  actionRationale = '推定人狼と予想襲撃先を避け、翌日に残る中で発言と投票への影響が最も大きい対象を選びました。',
} = {}) {
  return stringifyResponse({
    estimate: {
      wolfCandidateIds: estimatedWerewolfIds,
      predictedAttackTargetIds,
    },
    actionAnswer,
    actionRationale,
  });
}

export function attackResponse(actionAnswer, attackAssessment, options = {}) {
  return stringifyResponse({
    actionAnswer,
    attackAssessment,
    actionRationale: options.actionRationale ?? '成功見込みと翌日の票数を比較して選びました。',
  });
}

export function wolfConversationResponse(wolfMessage, sharedStrategyUpdate, options = {}) {
  const normalized = sharedStrategyUpdate?.mode
    ? sharedStrategyUpdate
    : { mode: 'patch', changes: { ...(sharedStrategyUpdate ?? {}) } };
  const payload = { wolfMessage, sharedStrategyUpdate: normalized };
  const memo = options.memoAdd ?? options.internalMemoUpdate?.text;
  if (memo !== undefined) payload.memoAdd = memo;
  return stringifyResponse(payload);
}

export function masonConversationResponse(masonMessage, options = {}) {
  const payload = { masonMessage };
  if (options.decision !== undefined) payload.decisionPatch = options.decision;
  const memo = options.memoAdd ?? options.internalMemoUpdate?.text;
  if (memo !== undefined) payload.memoAdd = memo;
  return stringifyResponse(payload);
}
