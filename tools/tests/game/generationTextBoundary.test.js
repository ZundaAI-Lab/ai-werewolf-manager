/**
 * 責務: AI公開発言の文章境界検査が、他人の公開発言全文と本人可視の秘密会話文の流用だけを機械的に拒否し、短い定型句や無関係な文章を許可することを検証する。
 * 変更ルール: 役職・CO・能力結果・ゲーム上の意味を解析するテストを追加せず、stageSource.safetyReferencesと文字列比較だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  longestCommonSubstringLength,
  normalizeBoundaryText,
  validateGeneratedTextBoundary,
} from '../../../app/renderer/js/prompts/stages/generationTextBoundary.js';

function artifact(taskType = 'speech') {
  return {
    taskType,
    stageSource: {
      safetyReferences: {
        otherPublicSpeeches: [{
          eventId: 'e1',
          actorId: 'p2',
          sequence: 10,
          text: '白上虎太郎ですね。占い師として確認しましたよ。狼だったんです。',
        }],
        privateDialogueTexts: [{
          id: 'w1',
          speakerId: 'p1',
          content: '今は村役職と偽るべきか、狼だと公言すべきかの判断だ。まず情報を交換しよう。',
        }],
      },
    },
  };
}

test('他プレイヤーの長い公開発言全文コピーを拒否する', () => {
  const result = validateGeneratedTextBoundary({
    taskArtifact: artifact(),
    candidateObject: { publicSpeech: '「白上虎太郎ですね。占い師として確認しましたよ。狼だったんです。」' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'PUBLIC_SPEECH_COPIES_OTHER_PLAYER');
});

test('秘密会話全文と長い断片の転用を拒否する', () => {
  const exact = validateGeneratedTextBoundary({
    taskArtifact: artifact(),
    candidateObject: { publicSpeech: '今は村役職と偽るべきか、狼だと公言すべきかの判断だ。まず情報を交換しよう。' },
  });
  assert.equal(exact.ok, false);
  assert.equal(exact.issues[0].code, 'PUBLIC_SPEECH_COPIES_PRIVATE_DIALOGUE');

  const reused = validateGeneratedTextBoundary({
    taskArtifact: artifact(),
    candidateObject: { publicSpeech: '今は村役職と偽るべきか、狼だと公言すべきかの判断だ。まず情報を交換したい。' },
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.issues[0].code, 'PUBLIC_SPEECH_REUSES_PRIVATE_DIALOGUE');
});


