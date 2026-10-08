import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Codex's tool schema reader expects items to be a schema, not draft-07's
 * positional schema array. Adapt the advertised schema only; McpServer and
 * the HTTP backend still validate calls against the original Zod schemas.
 */
export function codexToolSchema(schema: Schema): Schema {
  const result = { ...schema };
  // Traverse schema-bearing keywords only: defaults/examples are user data.
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const map = result[key];
    if (isObject(map)) result[key] = Object.fromEntries(Object.entries(map).map(
      ([name, value]) => [name, isObject(value) ? codexToolSchema(value) : value],
    ));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(
      value => isObject(value) ? codexToolSchema(value) : value,
    );
  }
  for (const key of ['additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else']) {
    if (isObject(result[key])) result[key] = codexToolSchema(result[key]);
  }
  if (Array.isArray(result.items)) {
    const positions = result.items.map(value => isObject(value) ? codexToolSchema(value) : value);
    const unique = [...new Map(positions.map(value => [JSON.stringify(value), value])).values()];
    if (!positions.length || result.maxItems !== positions.length || result.minItems !== positions.length) {
      throw new Error('Codex schema adapter only supports fixed-length tuples');
    }
    result.items = unique.length === 1 ? unique[0] : { anyOf: unique };
    // Preserve differing positional constraints as guidance as well as in Zod.
    if (unique.length > 1) result.description = [result.description,
      `Tuple positions (zero-based), validated by the server: ${JSON.stringify(positions)}.`,
    ].filter(Boolean).join('\n');
    delete result.additionalItems;
  } else if (isObject(result.items)) {
    result.items = codexToolSchema(result.items);
  }
  return result;
}

/** Only tool-list metadata is adapted; tool inputs/results are untouched. */
export class CodexStdioServerTransport extends StdioServerTransport {
  override send(message: JSONRPCMessage): Promise<void> {
    if ('result' in message && Array.isArray(message.result.tools)) {
      return super.send({ ...message, result: { ...message.result,
        tools: message.result.tools.map(tool => isObject(tool) && isObject(tool.inputSchema)
          ? { ...tool, inputSchema: codexToolSchema(tool.inputSchema) } : tool),
      } });
    }
    return super.send(message);
  }
}
