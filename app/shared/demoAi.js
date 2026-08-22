/**
 * 責務: 外部APIキーなしでゲーム自動進行とチャットルームを検証できる、タスク種別ごとのデモAI応答を生成する。
 * 変更ルール: ゲーム状態を変更しない。ゲーム進行ではマーク付きの今回JSON例と表示名ベースのdraft-task-dataを使用し、チャットルームではJSON例へ依存せず専用の固定台詞を構造化応答として返す。チャットの質問専用回答IDと本人の既存内部メモだけはPrompt内の専用data blockから引き継ぐ。発言化はfield-jobs、昼議論校正はproofread-inputだけを読み、内部IDへ依存せず、実戦用AIの代替として評価結果へ混在させない。
 */

(function exposeDemoAi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiWerewolfDemoAi = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function parseDataBlock(promptText, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`^\\[game-data:${escaped}\\]\\r?\\n([\\s\\S]*?)\\r?\\n\\[\\/game-data\\]$`, 'mu');
    const match = String(promptText ?? '').match(pattern);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  const CHAT_ROOM_DEMO_MESSAGE = 'こんにちは。デモAIです。チャットルームの動作確認用に参加しています。';

  function generateChatRoomResponse(promptText) {
    const memoryData = parseDataBlock(promptText, 'chat-memory') ?? {};
    const turnData = parseDataBlock(promptText, 'chat-turn-context') ?? parseDataBlock(promptText, 'chat-turn') ?? {};
    const requiredAnswerMessageId = String(turnData.requiredAnswerMessageId ?? '').trim();
    return {
      chatMessage: CHAT_ROOM_DEMO_MESSAGE,
      memory: Array.isArray(memoryData.items) ? memoryData.items : [],
      interaction: {
        questionTargetIds: [],
        answersMessageIds: requiredAnswerMessageId ? [requiredAnswerMessageId] : [],
      },
    };
  }

  function parseResponseExample(promptText) {
    const lines = String(promptText ?? '').split(/\r?\n/u).map((line) => line.trim());
    const markerIndex = lines.findIndex((line) => line === '### 今回のJSON例');
    if (markerIndex >= 0) {
      for (let index = markerIndex + 1; index < lines.length; index += 1) {
        if (index > markerIndex + 1 && lines[index].startsWith('##')) break;
        if (!lines[index].startsWith('{') || !lines[index].endsWith('}')) continue;
        try {
          return JSON.parse(lines[index]);
        } catch {
          // JSON例の説明行や別区画を読み飛ばす。
        }
      }
    }
    throw new Error('プロンプトから応答JSON例を取得できません。');
  }

  function targetRows(currentTask) {
    const source = currentTask?.validTargets ?? currentTask?.alivePlayers ?? [];
    return source.map((item) => typeof item === 'string'
      ? { id: item, name: item }
      : { id: String(item?.id ?? item?.name ?? ''), name: String(item?.name ?? item?.id ?? '') })
      .filter((item) => item.name);
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function chooseTarget(rows, seed, excludedIds = new Set()) {
    const candidates = rows.filter((row) => !excludedIds.has(row.id));
    if (!candidates.length) return null;
    return candidates[hashText(seed) % candidates.length];
  }

  function normalizeDecisionPatch(patch, { taskType, selectedTarget }) {
    if (!patch || typeof patch !== 'object') return patch;
    const result = structuredClone(patch);
    if (Object.hasOwn(result, 'suspects')) result.suspects = [];
    if (Object.hasOwn(result, 'executionCandidates')) result.executionCandidates = taskType === 'vote' && selectedTarget ? [selectedTarget.name] : [];
    if (Object.hasOwn(result, 'intendedVote')) result.intendedVote = taskType === 'vote' ? undefined : null;
    if (result.intendedVote === undefined) delete result.intendedVote;
    if (Object.hasOwn(result, 'assessmentLevel')) result.assessmentLevel = taskType === 'vote' ? 'moderate' : 'unresolved';
    if (Object.hasOwn(result, 'leaveAliveBenefit')) result.leaveAliveBenefit = '今後の発言比較から追加情報を得られる。';
    if (Object.hasOwn(result, 'misexecutionCost')) result.misexecutionCost = '村側なら処刑回数と発言情報を失う。';
    if (Object.hasOwn(result, 'selectionDifference')) result.selectionDifference = '他候補より発言の整合性を再確認する価値が高い。';
    if (Object.hasOwn(result, 'uncertainty')) result.uncertainty = taskType === 'vote' ? '確定情報ではなく公開発言からの暫定判断。' : '公開根拠がまだ不足しているため保留。';
    if (Object.hasOwn(result, 'nextDiscriminatingInformation')) result.nextDiscriminatingInformation = '次の投票理由と能力結果の整合性。';
    if (Object.hasOwn(result, 'reason')) result.reason = '公開材料がまだ少ないため、断定せず発言の変化を継続して確認する。';
    if (Object.hasOwn(result, 'evidenceRefs')) result.evidenceRefs = [];
    if (Object.hasOwn(result, 'correctedSpeechRefs')) result.correctedSpeechRefs = [];
    return result;
  }

  function normalizeStrategyUpdate(update, { selectedTarget = null, knownWolves = [] } = {}) {
    if (!update || typeof update !== 'object') return update;
    const result = structuredClone(update);
    if (result.mode !== 'patch' || !result.changes) return result;
    Object.entries(result.changes).forEach(([key, value]) => {
      if (key === 'partnerDisposition') {
        result.changes[key] = String(value || 'not-applicable');
        return;
      }
      result.changes[key] = value === 'none' ? 'none' : '公開情報の変化に合わせて柔軟に調整する。';
    });
    return result;
  }

  function demoStageText(job) {
    const sourceText = String(job?.sourceText ?? '');
    if (job?.purpose !== 'public-dialogue') return sourceText;
    const deadPlayers = Array.isArray(job?.context?.publicState?.deadPlayers)
      ? job.context.publicState.deadPlayers
      : [];
    const containsInvalidLifeState = sourceText.includes('今も生きています');
    const containsInvalidAttackActor = sourceText.includes('狂人に襲撃されました');
    if ((!containsInvalidLifeState && !containsInvalidAttackActor) || !deadPlayers.length) return sourceText;
    return deadPlayers.map((player) => {
      const name = String(player?.name ?? player?.playerName ?? player?.id ?? '対象者');
      const cause = String(player?.cause ?? '');
      if (cause === 'execution') return `${name}さんはすでに処刑されています。`;
      if (cause === 'wolf-attack') return `${name}さんは人狼の襲撃で死亡しています。`;
      return `${name}さんはすでに死亡しています。`;
    }).join('');
  }

  function demoProofreadText(input) {
    const sourceText = String(input?.sourceText ?? '');
    const deadNames = Array.isArray(input?.publicSituation?.deadNames)
      ? input.publicSituation.deadNames.map(String).filter(Boolean)
      : [];
    const containsInvalidLifeState = sourceText.includes('今も生きています');
    const containsInvalidAttackActor = sourceText.includes('狂人に襲撃されました');
    if ((!containsInvalidLifeState && !containsInvalidAttackActor) || !deadNames.length) return sourceText;
    return deadNames.map((name) => `${name}さんはすでに死亡しています。`).join('');
  }

  function generate({ prompt, taskType = '', playerName = '', requestPurpose = 'normal' } = {}) {
    if (taskType === 'chat-room') {
      return JSON.stringify(generateChatRoomResponse(prompt));
    }
    if (requestPurpose === 'generation-render') {
      const jobs = parseDataBlock(prompt, 'field-jobs') ?? [];
      const textPatch = Object.fromEntries(jobs.map((job) => [String(job.field), demoStageText(job)]));
      return JSON.stringify({ textPatch });
    }
    if (requestPurpose === 'generation-proofread') {
      const input = parseDataBlock(prompt, 'proofread-input') ?? {};
      return JSON.stringify({ textPatch: { publicSpeech: demoProofreadText(input) } });
    }
    const draftTaskData = requestPurpose === 'generation-draft'
      ? parseDataBlock(prompt, 'draft-task-data') ?? {}
      : null;
    const stageContract = parseDataBlock(prompt, 'response-contract');
    const example = stageContract?.completeExample ?? parseResponseExample(prompt);
    const player = parseDataBlock(prompt, 'player') ?? draftTaskData?.currentMoment ?? {};
    const privateInformation = parseDataBlock(prompt, 'private-information') ?? draftTaskData?.privateState ?? {};
    const publicPlayers = [
      ...(draftTaskData?.publicState?.alivePlayers ?? []),
      ...(draftTaskData?.publicState?.deadPlayers ?? []),
    ].map((item) => typeof item === 'string'
      ? { id: item, name: item }
      : { id: String(item?.id ?? item?.playerId ?? item?.name ?? ''), name: String(item?.name ?? item?.playerName ?? item?.id ?? '') })
      .filter((item) => item.id && item.name);
    const draftTargetSource = draftTaskData?.roleTaskData?.validTargetPlayers
      ?? draftTaskData?.roleTaskData?.validTargets
      ?? draftTaskData?.roleTaskData?.validTargetIds
      ?? [];
    const draftTargets = targetRows({ validTargets: draftTargetSource });
    const currentTask = parseDataBlock(prompt, 'current-task') ?? {
      validTargets: draftTargets,
      alivePlayers: draftTaskData?.publicState?.alivePlayers ?? [],
    };
    const actorName = String(playerName || player.name || player.playerName || 'AIプレイヤー');
    const targets = targetRows(currentTask);
    const selectedTarget = chooseTarget(targets, `${actorName}:${taskType}:${prompt.length}`);
    const otherTarget = targets.find((target) => target.name !== selectedTarget?.name) ?? null;
    const result = structuredClone(example);
    if (taskType === 'discussion-opening-preference' && Object.hasOwn(result, 'openingPreference')) result.openingPreference = 'NORMAL';
    if (taskType === 'speech-designated' && Object.hasOwn(result, 'nextSpeakerPreference')) result.nextSpeakerPreference = '';
    if (taskType === 'speech-free' && Object.hasOwn(result, 'discussionPreference')) result.discussionPreference = 'DONE';

    if (Object.hasOwn(result, 'publicSpeech')) {
      result.publicSpeech = taskType === 'result-impression'
        ? `${actorName}です。最後まで読み切れない展開でしたが、投票と夜の結果を踏まえて楽しめました。`
        : `${actorName}です。まだ断定できる材料は少ないので、投票理由と発言の変化を見ながら判断します。`;
    }
    if (Object.hasOwn(result, 'speechInteraction')) delete result.speechInteraction;
    if (Object.hasOwn(result, 'decisionPatch')) {
      result.decisionPatch = normalizeDecisionPatch(result.decisionPatch, { taskType, selectedTarget });
    }
    if (Object.hasOwn(result, 'factionStrategy')) {
      result.factionStrategy = normalizeStrategyUpdate(result.factionStrategy, {
        selectedTarget,
        knownWolves: Array.isArray(privateInformation.knownWolves)
          ? privateInformation.knownWolves.map(String)
          : Array.isArray(privateInformation?.teammates?.knownWolves)
            ? privateInformation.teammates.knownWolves.map(String)
            : [],
      });
    }
    if (Object.hasOwn(result, 'sharedStrategy')) result.sharedStrategy = normalizeStrategyUpdate(result.sharedStrategy);
    if (Object.hasOwn(result, 'wolfMessage')) {
      result.wolfMessage = selectedTarget
        ? `今夜は${selectedTarget.name}を候補にしつつ、護衛リスクと翌日の盤面を比較したい。`
        : '今夜は公開発言の変化を確認し、襲撃候補を絞りたい。';
    }
    if (Object.hasOwn(result, 'masonMessage')) {
      result.masonMessage = '明日は公開発言の矛盾と投票理由を照合し、必要ならCO条件を相談しよう。';
    }
    if (Object.hasOwn(result, 'heartVoice')) result.heartVoice = 'まだ決め打ちは危険。小さな違和感を見落とさないようにしよう。';
    if (Object.hasOwn(result, 'memoAdd')) {
      result.memoAdd = taskType === 'vote'
        ? `${selectedTarget?.name ?? '投票先'}への投票理由と次の公開情報を照合する。`
        : '公開発言の整合性と投票理由の変化を次のターンでも確認する。';
    }
    if (Object.hasOwn(result, 'rationale')) {
      result.rationale = selectedTarget
        ? `${selectedTarget.name}を他候補と比較し、現時点で得られる情報価値を優先した。`
        : '有効候補の中から公開情報に反しない対象を選んだ。';
    }
    if (Object.hasOwn(result, 'actionAnswer')) {
      result.actionAnswer = selectedTarget?.name ?? targets[0]?.name ?? '棄権';
    }
    if (Object.hasOwn(result, 'attackAssessment')) {
      const assessment = result.attackAssessment;
      assessment.hunterAliveChance = 'medium';
      assessment.guardRisk = 'medium';
      if (Object.hasOwn(assessment, 'otherTarget')) assessment.otherTarget = otherTarget?.name ?? selectedTarget?.name ?? '';
      if (Object.hasOwn(assessment, 'otherGuardRisk')) assessment.otherGuardRisk = 'medium';
    }
    if (Object.hasOwn(result, 'estimate')) {
      const aliveRows = targetRows({ alivePlayers: currentTask.alivePlayers ?? [] });
      const wolfEstimate = aliveRows[0] ? [aliveRows[0].id] : [];
      const attackEstimate = aliveRows[1] ? [aliveRows[1].id] : wolfEstimate;
      result.estimate = {
        wolfCandidateIds: wolfEstimate,
        predictedAttackTargetIds: attackEstimate,
      };
      const excluded = new Set([...wolfEstimate, ...attackEstimate]);
      const freezeTarget = chooseTarget(targetRows({ validTargets: currentTask.validTargets ?? [] }), `${actorName}:freeze`, excluded);
      if (Object.hasOwn(result, 'actionAnswer') && freezeTarget) result.actionAnswer = freezeTarget.name;
    }
    if (Object.hasOwn(result, 'fullMemo')) {
      result.fullMemo = '公開発言の整合性、投票理由、能力結果の時系列を優先して確認する。断定できない点は保留する。';
    }

    return JSON.stringify(result);
  }

  return Object.freeze({ generate, parseDataBlock, parseResponseExample });
}));
