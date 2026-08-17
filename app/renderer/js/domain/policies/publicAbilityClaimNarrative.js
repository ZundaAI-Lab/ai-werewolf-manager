/**
 * 製造規約（最優先）:
 * - AI回答のpublicSpeech本文は、解析結果と公開イベント保存値を完全一致させる。
 * - システムによる固定文、能力結果文、理由文、口調、句読点、要約、補足の追加・置換・並べ替えを禁止する。
 * - CO操作・能力結果主張・判断更新などの構造化欄は状態更新専用とし、公開発言本文を生成してはならない。
 *
 * 責務: AI公開発言の原文不変契約を実行時と保存状態検証で強制する。
 * 変更ルール: 文字列の正規化・trim・補完を行わず、完全一致以外を拒否する。公開文の生成責務を追加してはならない。
 */

export function assertAiPublicSpeechUnmodified(aiPublicSpeech, storedPublicSpeech) {
  const source = String(aiPublicSpeech ?? '');
  const stored = String(storedPublicSpeech ?? '');
  if (source !== stored) {
    throw new Error('製造規約違反: AI回答の公開発言本文がシステムによって変更されています。');
  }
  return stored;
}

export function validateAiPublicSpeechUnmodified(aiPublicSpeech, storedPublicSpeech) {
  return String(aiPublicSpeech ?? '') === String(storedPublicSpeech ?? '');
}
