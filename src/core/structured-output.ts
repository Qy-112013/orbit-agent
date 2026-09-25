const UNSUPPORTED_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'minimum', 'maximum', 'uniqueItems']);

export interface ResponseSchema { name: string; schema: Record<string, unknown> }

/**
 * Converts a local validation schema into the subset accepted by provider
 * structured-output modes. Local validation remains the final authority, so
 * dropped constraints are still enforced after parsing.
 */
export function toProviderSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toProviderSchema(child as Record<string, unknown>)]));
    } else if (key === 'items' && value && typeof value === 'object') {
      result.items = toProviderSchema(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  if (result.type === 'object') {
    const properties = Object.keys((result.properties ?? {}) as Record<string, unknown>);
    const required = new Set((result.required ?? []) as string[]);
    // Strict modes require every property; refuse rather than silently change semantics.
    const optional = properties.filter((name) => !required.has(name));
    if (optional.length) throw new Error(`structured output schema has optional properties: ${optional.join(', ')}`);
    result.additionalProperties = false;
  }
  return result;
}
