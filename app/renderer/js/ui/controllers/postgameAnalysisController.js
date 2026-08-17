/**
 * 責務: ゲーム終了後のGM向けAI事後分析について、UIセッション内だけの質問履歴・実行中状態・エラー表示を管理する。
 * 変更ルール: ゲームState・AIターン監査・イベント・保存JSONを変更しない。分析API呼び出しはautomation層から注入されたadapterへ委譲し、ゲーム中・手動生成ターン・デモAIでは実行しない。利用可否は現在の実行方式ではなく、対象ターンの生成記録と現在の元プロファイル状態から判定する。
 */

function emptySession() {
  return { pending: false, error: '', exchanges: [] };
}

function normalizeTurnId(value) {
  return String(value ?? '').trim();
}

export function createPostgameAnalysisController({ ui }) {
  if (!ui) throw new TypeError('AppUIがありません。');
  let adapter = null;
  const sessions = new Map();

  function sessionFor(turnId) {
    const id = normalizeTurnId(turnId);
    if (!sessions.has(id)) sessions.set(id, emptySession());
    return sessions.get(id);
  }

  function analysisAvailability(state, turn) {
    if (!adapter?.analyzeTurn || state?.game?.phase !== 'ended') return { available: false, reason: '' };
    if (turn?.generationRun?.executionMode !== 'automatic') return { available: false, reason: '' };
    const profileId = String(turn?.generationRun?.ownerProfileId ?? '').trim();
    if (!profileId) return { available: false, reason: 'このAIターンを生成したAIプロファイルを特定できないため、終了後分析を利用できません。' };
    const profile = ui.aiExecutionSettings?.profiles?.find((item) => item.id === profileId) ?? null;
    if (!profile?.enabled) return { available: false, reason: 'このAIターンを生成したAIプロファイルが現在利用できないため、終了後分析を利用できません。' };
    if (profile.provider === 'demo') return { available: false, reason: 'デモAIでは終了後分析できません。' };
    return { available: true, reason: '' };
  }

  function viewModel(state) {
    const byTurnId = Object.fromEntries((state?.aiTurns ?? []).map((turn) => {
      const session = sessions.get(turn.id) ?? emptySession();
      const availability = analysisAvailability(state, turn);
      return [turn.id, {
        available: availability.available,
        unavailableReason: availability.reason,
        pending: Boolean(session.pending),
        error: String(session.error ?? ''),
        draftQuestion: String(ui.drafts.get(`postgame-analysis-question:${turn.id}`) ?? ''),
        exchanges: session.exchanges.map((exchange) => ({
          question: exchange.question,
          answer: exchange.answer,
          attributions: exchange.attributions.map((item) => ({ ...item })),
          otherFactors: exchange.otherFactors,
          promptImprovement: exchange.promptImprovement,
          uncertainty: exchange.uncertainty,
        })),
      }];
    }));
    return {
      enabled: Boolean(adapter?.analyzeTurn) && state?.game?.phase === 'ended',
      byTurnId,
    };
  }

  function setAdapter(nextAdapter) {
    if (nextAdapter !== null && typeof nextAdapter?.analyzeTurn !== 'function') {
      throw new TypeError('終了後AI分析adapterにanalyzeTurnがありません。');
    }
    adapter = nextAdapter;
    ui.render();
  }

  function reset() {
    sessions.clear();
  }

  async function ask(turnId) {
    const id = normalizeTurnId(turnId);
    const state = ui.store.getState();
    const turn = state.aiTurns.find((item) => item.id === id);
    if (!turn) return ui.toast('対象のAIターンが見つかりません。', 'error');
    const availability = analysisAvailability(state, turn);
    if (!availability.available) {
      return ui.toast(availability.reason || '終了後AI分析は、自動API実行で生成されたAIターンをゲーム終了後にだけ利用できます。', 'error');
    }
    const session = sessionFor(id);
    if (session.pending) return undefined;
    const draftKey = `postgame-analysis-question:${id}`;
    const question = String(ui._controlValue(draftKey, '')).trim();
    if (!question) return ui.toast('GMからの質問を入力してください。', 'error');
    if (question.length > 2000) return ui.toast('GMからの質問は2000文字以内にしてください。', 'error');

    const player = state.players.find((item) => item.id === turn.playerId);
    session.pending = true;
    session.error = '';
    ui.render();
    try {
      const result = await adapter.analyzeTurn({
        gameId: String(state.game.id ?? ''),
        player: { id: turn.playerId, name: player?.name ?? turn.playerId },
        turn: structuredClone(turn),
        question,
        previousExchanges: session.exchanges.map((exchange) => ({
          question: exchange.question,
          answer: exchange.answer,
          attributions: exchange.attributions.map((item) => ({ ...item })),
          otherFactors: exchange.otherFactors,
          promptImprovement: exchange.promptImprovement,
          uncertainty: exchange.uncertainty,
        })),
      });
      session.exchanges.push({
        question,
        answer: String(result.answer ?? ''),
        attributions: Array.isArray(result.attributions) ? result.attributions.map((item) => ({
          source: String(item?.source ?? ''),
          influence: String(item?.influence ?? ''),
          excerpt: String(item?.excerpt ?? ''),
          reason: String(item?.reason ?? ''),
        })) : [],
        otherFactors: String(result.otherFactors ?? ''),
        promptImprovement: String(result.promptImprovement ?? ''),
        uncertainty: String(result.uncertainty ?? ''),
      });
      ui.drafts.set(draftKey, '');
    } catch (error) {
      session.error = String(error?.message ?? error ?? '終了後AI分析に失敗しました。');
      ui.toast(`終了後AI分析失敗: ${session.error}`, 'error');
    } finally {
      session.pending = false;
      ui.render();
    }
    return undefined;
  }

  function clear(turnId) {
    sessions.delete(normalizeTurnId(turnId));
    ui.render();
  }

  return Object.freeze({ ask, clear, reset, setAdapter, viewModel });
}
