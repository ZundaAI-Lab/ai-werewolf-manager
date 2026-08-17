/**
 * 責務: 生成工程テスト用候補復元、工程比較、仮ゲーム検証を所有する。
 * 変更ルール: 設定保存と画面遷移を独自実装せず、desktopAutomation.jsから渡された正式依存へ委譲する。AI管理全体のイベント振り分けを持たない。生成工程テストは自動実行running中にAI生成リソースと競合させず、各工程担当が外部プロバイダーなら実通信直前だけprivacy/dataTransmissionNotice.jsの確認を要求する。
 */

(function initializeAiWerewolfGenerationTestController(globalScope) {
  'use strict';

  function createGenerationTestController(context) {
    const {
      GENERATION_STAGE_LABELS,
      apiErrorAsException,
      bridge,
      collectManagementForm,
      controller,
      isAutomationAiRequestLocked,
      persistSettings,
      playerName,
      profileById,
      refreshVisibleUi,
      runtime,
    } = context;

    function generationCandidateAnswer(candidateObject, fallbackRawResponse = '') {
            const textFields = [
              ['publicSpeech', '公開発言'],
              ['wolfMessage', '人狼会話'],
              ['masonMessage', '共有者会話'],
              ['graveyardMessage', '墓場会話'],
              ['actionAnswer', '行動回答'],
              ['consolidatedMemo', '整理後の内部メモ'],
              ['heartVoice', '心の声'],
            ];
            for (const [key, label] of textFields) {
              const value = candidateObject?.[key];
              if (typeof value === 'string' && value.trim()) return { label, text: value.trim() };
            }
            const raw = String(fallbackRawResponse ?? '').trim();
            return { label: 'AI回答', text: raw };
          }

    function buildGenerationTestStageSnapshots({ pipeline, evaluateCandidate, runtimeApi }) {
            const statusLabels = Object.freeze({ accepted: '採用', applied: '適用', skipped: '対象外', fallback: '不採用' });
            let candidateObject = null;
            let previousAnswerText = '';
            return (pipeline?.generationRun?.stages ?? []).map((stage) => {
              if ((stage.stageId === 'direct' || stage.stageId === 'draft') && stage.status === 'accepted') {
                const evaluation = evaluateCandidate(stage.rawResponse);
                if (evaluation?.candidateObject) candidateObject = evaluation.candidateObject;
              } else if ((stage.stageId === 'render' || stage.stageId === 'proofread') && stage.status === 'applied' && candidateObject) {
                const parsed = runtimeApi.parseTextPatchResponse(stage.rawResponse);
                if (parsed?.ok) {
                  const merged = runtimeApi.mergeTextPatch(candidateObject, parsed.textPatch, stage.targetTextFields);
                  const evaluation = evaluateCandidate(JSON.stringify(merged));
                  if (evaluation?.candidateObject) candidateObject = evaluation.candidateObject;
                }
              }
              const answer = generationCandidateAnswer(candidateObject, stage.rawResponse);
              const answerText = answer.text;
              const changed = previousAnswerText !== '' && answerText !== previousAnswerText;
              if (answerText) previousAnswerText = answerText;
              const issueText = stage.status === 'fallback'
                ? stage.issues?.map((item) => item.message).filter(Boolean).join(' / ') || 'この工程の回答を適用できなかったため、前工程の回答を継続しました。'
                : stage.status === 'skipped'
                  ? 'このタスクには変更対象となる文章項目がないため、工程を実行していません。'
                  : '';
              return {
                stageId: stage.stageId,
                label: GENERATION_STAGE_LABELS[stage.stageId] ?? stage.stageId,
                status: stage.status,
                statusLabel: statusLabels[stage.status] ?? stage.status,
                executorLabel: profileById(stage.executorProfileId)?.label ?? `不明なプロファイル (${stage.executorProfileId})`,
                answerLabel: answer.label,
                answerText,
                answerLength: [...answerText].length,
                changed,
                issueText,
                rawResponse: stage.rawResponse,
              };
            });
          }

    async function testGenerationPipeline(profileId, button) {
            if (isAutomationAiRequestLocked()) {
              runtime().toast('自動実行中は生成工程テストを実行できません。一時停止してから実行してください。', 'warning');
              return;
            }
            button.disabled = true;
            const original = button.textContent;
            button.textContent = '工程確認中…';
            controller.generationTestResults.delete(profileId);
            try {
              await persistSettings(collectManagementForm(), { refresh: false });
              const runtimeApi = runtime();
              const fixture = runtimeApi?.createGenerationPipelineTestTask?.();
              if (!fixture?.taskArtifact || typeof fixture.evaluateCandidate !== 'function') {
                throw new Error('仮ゲームの生成工程テストを準備できませんでした。');
              }
              const request = fixture.request;
              const taskArtifact = fixture.taskArtifact;
              const evaluateCandidate = fixture.evaluateCandidate;
              const testPlayerName = fixture.playerName;
              const testGameId = fixture.gameId;
              const promptLabel = fixture.promptLabel ?? '仮ゲームの公開発言';
        
              const ownerProfile = profileById(profileId);
              if (!ownerProfile?.enabled) throw new Error('テスト対象プロファイルを利用できません。');
              const plan = runtimeApi.resolveGenerationPlan({ ownerProfile, profiles: controller.settings.profiles, taskType: request.taskType });
              let actualCalls = 0;
              async function callStage({ stage, prompt, requestPurpose }) {
                actualCalls += 1;
                const textPatchStage = stage.stageId === 'render' || stage.stageId === 'proofread';
                const baseEnvelope = taskArtifact.promptEnvelope ?? {};
                const promptEnvelope = {
                  schemaVersion: 5,
                  commonSystemInstruction: textPatchStage ? '' : String(baseEnvelope.commonSystemInstruction ?? taskArtifact.systemInstruction ?? ''),
                  commonGameContext: textPatchStage ? '' : String(baseEnvelope.commonGameContext ?? ''),
                  taskInvariantContext: textPatchStage ? '' : String(baseEnvelope.taskInvariantContext ?? ''),
                  taskVariableContext: textPatchStage ? '' : String(baseEnvelope.taskVariableContext ?? ''),
                  stablePlayerContext: textPatchStage ? '' : String(baseEnvelope.stablePlayerContext ?? ''),
                  dynamicTaskPrompt: String(prompt ?? ''),
                  structuredOutput: textPatchStage ? null : (baseEnvelope.structuredOutput ? structuredClone(baseEnvelope.structuredOutput) : null),
                  cacheIdentity: {
                    ...(baseEnvelope.cacheIdentity ?? {}),
                    promptFamily: textPatchStage ? 'generation-text-patch' : String(baseEnvelope.cacheIdentity?.promptFamily ?? 'generation-candidate'),
                  },
                };
                const executorProfile = profileById(stage.executorProfileId);
                const dataNoticeAccepted = await globalScope.AiWerewolfDataTransmissionNotice?.ensureExternalDataNoticeForProfile?.(executorProfile);
                if (dataNoticeAccepted === false) throw new Error('外部LLMへのデータ送信を開始しませんでした。');
                const response = await bridge.generate({
                  requestId: `generation-test-${Date.now()}-${actualCalls}`,
                  profileId: stage.executorProfileId,
                  promptEnvelope,
                  taskType: request.taskType,
                  requestPurpose,
                  generationStage: stage.stageId,
                  playerName: testPlayerName,
                  gameId: testGameId,
                  retryIndex: 0,
                  publicHistoryMode: 'full',
                });
                if (response?.ok === false) throw apiErrorAsException(response.error ?? {});
                if (!response?.text) throw new Error(`${GENERATION_STAGE_LABELS[stage.stageId]}で空応答が返されました。`);
                return response;
              }
              const pipeline = await runtimeApi.runGenerationPipeline({
                plan,
                taskArtifact,
                requestFullCandidate: async ({ stage, prompt }) => {
                  const response = await callStage({
                    stage,
                    prompt,
                    requestPurpose: stage.stageId === 'draft' ? 'generation-draft' : 'normal',
                  });
                  const evaluation = evaluateCandidate(response.text);
                  return { ok: evaluation.ok, rawResponse: response.text, evaluation, attemptCount: 1, usage: response.usage, issues: evaluation.issues };
                },
                requestTextPatch: async ({ stage, prompt }) => {
                  const response = await callStage({ stage, prompt, requestPurpose: `generation-${stage.stageId}` });
                  return { ok: true, rawResponse: response.text, attemptCount: 1, usage: response.usage, issues: [] };
                },
                evaluateCandidate,
                resolveStagePromptPolicy: runtimeApi.resolveGenerationStagePromptPolicy,
                buildDraftPrompt: runtimeApi.buildDraftStagePrompt,
                buildRenderPrompt: runtimeApi.buildRenderStagePrompt,
                buildProofreadPrompt: runtimeApi.buildProofreadStagePrompt,
              });
              if (!pipeline?.ok || !pipeline.evaluation?.ok) throw new Error('実効パイプラインの最終候補が現行検証を通りませんでした。');
              const expectedActualCalls = pipeline.generationRun.stages.filter((stage) => stage.status !== 'skipped' && Number(stage.attemptCount ?? 0) > 0).length;
              if (actualCalls !== expectedActualCalls) throw new Error(`実効パイプラインの呼び出し数が不正です。期待${expectedActualCalls}回 / 実際${actualCalls}回`);
        
              const generationStageStatusLabels = Object.freeze({ accepted: '採用', applied: '適用', skipped: '対象外', fallback: '前工程の回答を継続使用' });
              const fallbackStages = pipeline.generationRun.stages.filter((stage) => stage.status === 'fallback');
              const stageLines = pipeline.generationRun.stages.flatMap((stage) => {
                const lines = [`${GENERATION_STAGE_LABELS[stage.stageId]}: ${generationStageStatusLabels[stage.status] ?? stage.status}`];
                if (stage.status === 'skipped') lines.push(`  理由: このタスクでは${GENERATION_STAGE_LABELS[stage.stageId]}を実行しません。`);
                if (stage.status === 'fallback') {
                  const issueText = stage.issues?.map((item) => item.message).filter(Boolean).join(' / ') || '後段工程の回答を適用できませんでした。';
                  lines.push(`  理由: ${issueText}`);
                  lines.push('  実運用時の処理: 直前に検証済みの回答を使用して続行します。');
                }
                return lines;
              });
              const status = fallbackStages.length ? 'warning' : 'success';
              const lines = [
                '実行内容: 仮ゲームの同一プロンプトで、設定済みの生成工程を1回ずつ実行し、工程ごとの完成文章を比較します。',
                `テスト入力: ${promptLabel}`,
                '仮ゲーム状態: テスト内だけで生成し、実ゲームの状態・進行・画面には接続しません。',
                '工程結果',
                ...stageLines,
                '最終回答の本番検証: 成功',
                `設定上の通常AI呼び出し数: ${plan.normalCallCount}回`,
                `このテストで実行したAI呼び出し: ${actualCalls}回`,
                fallbackStages.length
                  ? '判定: 使用可能。ただし後段工程の一部が不採用になり、前工程の回答を使用しました。'
                  : '判定: 設定した全工程を正常に適用できました。',
              ];
              const stages = buildGenerationTestStageSnapshots({ pipeline, evaluateCandidate, runtimeApi });
              controller.generationTestResults.set(profileId, { ok: true, status, lines, stages });
              runtimeApi.toast?.(fallbackStages.length
                ? '生成工程テストは完了しました。後段工程の一部は不採用となり、前工程の回答を使用しました。'
                : '生成工程テストが成功しました。仮プロンプトだけを使用し、ゲーム状態は変更していません。', fallbackStages.length ? 'warning' : 'success');
            } catch (error) {
              controller.generationTestResults.set(profileId, { ok: false, status: 'error', lines: [`失敗: ${error.message}`, '最初の有効回答を作れなかったため、生成工程を完了できませんでした。', '仮ゲームだけを使用しているため、実ゲーム状態は変更していません。'] });
              runtime().toast(`生成工程テスト失敗: ${error.message}`, 'error');
            } finally {
              button.disabled = false;
              button.textContent = original;
              refreshVisibleUi();
            }
          }

    return Object.freeze({
      generationCandidateAnswer,
      buildGenerationTestStageSnapshots,
      testGenerationPipeline,
    });
  }

  globalScope.AiWerewolfGenerationTestController = Object.freeze({ createGenerationTestController });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
