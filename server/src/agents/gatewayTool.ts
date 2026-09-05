import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';

export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape, 'strict'>;
  schema: Record<string, unknown>;
  exec: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    text: string;
    image?: { data: string; mimeType: string };
  }>;
}

/** The same schema validates API calls and declares/validates MCP tools. */
export function defineGatewayTool(
  definition: Omit<GatewayTool, 'schema' | 'inputSchema'> & { inputSchema: z.ZodRawShape },
): GatewayTool {
  const inputSchema = z.object(definition.inputSchema).strict();
  return {
    ...definition,
    inputSchema,
    // Use the SDK's exported converter, just as its tools/list handler does.
    schema: toJsonSchemaCompat(inputSchema),
    exec: async (input) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        const details = parsed.error.issues.map((issue) =>
          `${issue.path.join('.') || 'input'}: ${issue.message}`,
        ).join('; ');
        return { ok: false, text: `工具参数无效：${details}` };
      }
      return definition.exec(parsed.data);
    },
  };
}
