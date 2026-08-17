/**
 * 責務: Rendererで確定済みのProvider非依存JSON Schemaを、各Providerの構造化出力制約へ変換する。
 * 変更ルール: ゲーム固有のキーや意味を追加せず、request bodyも生成しない。OpenAI strictでは全object propertyをrequiredへ昇格し、元契約で任意だった値だけnull許容へ変換する。元Schemaは変更しない。
 */

'use strict';

function cloneSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const cloned = { ...schema };
  if (Array.isArray(schema.enum)) cloned.enum = [...schema.enum];
  if (schema.properties && typeof schema.properties === 'object') {
    cloned.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, cloneSchema(child)]));
  }
  if (Array.isArray(schema.required)) cloned.required = [...schema.required];
  if (schema.items) cloned.items = cloneSchema(schema.items);
  return cloned;
}

function nullableSchema(schema) {
  const next = cloneSchema(schema);
  const currentTypes = Array.isArray(next.type) ? [...next.type] : [next.type];
  next.type = [...new Set([...currentTypes.filter(Boolean), 'null'])];
  if (Array.isArray(next.enum) && !next.enum.includes(null)) next.enum = [...next.enum, null];
  return next;
}

function toOpenAiStrictSchema(schema) {
  const source = cloneSchema(schema);
  if (!source || typeof source !== 'object') return source;
  if (source.type === 'array') {
    source.items = toOpenAiStrictSchema(source.items);
    return source;
  }
  if (source.type !== 'object') return source;

  const originallyRequired = new Set(source.required ?? []);
  const properties = {};
  for (const [key, child] of Object.entries(source.properties ?? {})) {
    const converted = toOpenAiStrictSchema(child);
    properties[key] = originallyRequired.has(key) ? converted : nullableSchema(converted);
  }
  source.properties = properties;
  source.required = Object.keys(properties);
  source.additionalProperties = false;
  return source;
}

module.exports = { cloneSchema, nullableSchema, toOpenAiStrictSchema };
