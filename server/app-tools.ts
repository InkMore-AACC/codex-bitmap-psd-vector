import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Use the installed official MCP server, never its private wire protocol.
export function appToolsServer(): string | undefined {
  const base = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'plugins',
    'cache',
    'openai-bundled',
    'codex-app-tools',
  );
  try {
    return fs
      .readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(base, v, 'server.mjs'))
      .find((p) => fs.existsSync(p));
  } catch {
    return undefined;
  }
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export function toolResult(result: any): any {
  const text = (result.content || [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
  if (result.isError) throw new DeliveryError(text || 'Codex 拒绝了此次发送');
  try {
    return JSON.parse(text);
  } catch {
    throw new DeliveryError('Codex 返回了无法识别的发送结果', true);
  }
}
export async function sendToDesktop(taskId: string, prompt: string, pipePath: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId))
    throw new DeliveryError('画布没有绑定真实的 Codex 对话 ID');
  const server = appToolsServer();
  if (!server || !pipePath)
    throw new DeliveryError('未取得 Codex 桌面发送接口，请从目标对话重新打开画布');
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  env.CODEX_APP_TOOLS_PIPE_PATH = pipePath;
  const client = new Client({ name: 'layer-canvas-dispatch', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env,
    stderr: 'pipe',
  });
  let sending = false;
  try {
    await client.connect(transport, { timeout: 10000 });
    const catalog = await client.listTools(undefined, { timeout: 10000 });
    if (!catalog.tools.some((t) => t.name === 'send_message_to_thread'))
      throw new DeliveryError('当前 Codex 版本没有提供对话发送工具');
    const meta = { 'openai/threadId': taskId };
    const read = toolResult(
      await client.callTool(
        {
          name: 'read_thread',
          arguments: { threadId: taskId, turnLimit: 1, maxOutputCharsPerItem: 0 },
          _meta: meta,
        },
        undefined,
        { timeout: 15000 },
      ),
    );
    if (
      read.thread?.id !== taskId ||
      read.thread?.kind !== 'codex' ||
      read.thread?.hostId !== 'local'
    )
      throw new DeliveryError('无法确认目标是本机画布绑定的 Codex 对话，已停止发送');
    sending = true;
    const sent = toolResult(
      await client.callTool(
        { name: 'send_message_to_thread', arguments: { threadId: taskId, prompt }, _meta: meta },
        undefined,
        { timeout: 30000 },
      ),
    );
    if (sent.threadId !== taskId) throw new DeliveryError('发送回执与目标对话不一致', true);
    return sent;
  } catch (e) {
    if (e instanceof DeliveryError) throw e;
    throw new DeliveryError(e instanceof Error ? e.message : String(e), sending);
  } finally {
    await client.close().catch(() => {});
  }
}
