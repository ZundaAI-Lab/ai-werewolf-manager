/**
 * 責務: キャラクターJSONに含まれる固有会話種の構造だけを検証する。
 * 変更ルール:
 * - 会話内容そのものはJSON側で管理し、このモジュールへ固有キャラクター情報を持ち込まない。
 * - ゲーム進行やプロンプト生成は扱わず、会話種は0件を許可し、登録された項目についてだけID・話題・雰囲気と一意性を保証する。
 */

export function validateCharacterConversationSeeds(card) {
  const seeds = card.character?.conversationSeeds;
  if (!Array.isArray(seeds)) {
    throw new Error(`${card.name}の固有会話種が配列ではありません。`);
  }
  const ids = seeds.map((item) => String(item?.id ?? '').trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error(`${card.name}の固有会話種IDが不正です。`);
  }
  seeds.forEach((item) => {
    if (!String(item?.subject ?? '').trim()
      || !String(item?.tone ?? '').trim()) {
      throw new Error(`${card.name}の固有会話種が不正です。`);
    }
  });
}
