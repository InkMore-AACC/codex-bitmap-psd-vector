import { readFile } from 'node:fs/promises';
import { CanvasClient } from './client.js';

// Temporary transport when an already-running Codex task has not refreshed MCP tools.
// This process never invokes a model or starts another Codex conversation.
const [name, file] = process.argv.slice(2);
if (!name || !file) throw new Error('用法：node --import tsx bridge/cli.ts <toolName> <arguments.json>');
const args = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const client = new CanvasClient();
let result: unknown;
try {
  switch (name) {
    case 'canvas_open': result = await client.open(args.taskId); break;
    case 'canvas_get_document': result = await client.document(args.taskId); break;
    case 'canvas_import': {
      const doc = await client.document(args.taskId);
      result = await client.request(`/api/document/${encodeURIComponent(doc.id)}/import-path`, 'POST', { path: args.path, taskId: args.taskId });
      break;
    }
    case 'canvas_wait_requests': result = await client.wait(args.taskId, args.timeoutMs ?? 50000, args.excludeJobIds); break;
    case 'canvas_get_request': result = await client.packet(args.taskId, args.jobId,args.generationPlan); break;
    case 'canvas_claim_request': {
      await client.mutateJob(args.taskId, args.jobId, 'claim');
      result = await client.packet(args.taskId, args.jobId);
      break;
    }
    case 'canvas_web_vector': { const {taskId,jobId,...payload}=args;result=await client.mutateJob(taskId,jobId,'web-vector',payload);break; }
    case 'canvas_adobe': { const {taskId,jobId,...payload}=args;result=await client.mutateJob(taskId,jobId,'adobe',payload);break; }
    case 'canvas_prepare_cutouts': {
      const {taskId,jobId,...payload}=args;
      result=await client.mutateJob(taskId,jobId,'cutouts',payload); break;
    }
    case 'canvas_apply_plan':
    case 'canvas_complete_request':
    case 'canvas_fail_request': {
      const { taskId, jobId, ...payload } = args;
      if (name === 'canvas_complete_request' && !payload.vectorSvg && !payload.layers?.length && !payload.artifactPath) throw new Error('必须提供实际完成的图层、矢量内容或本地文件。');
      result = await client.mutateJob(taskId, jobId, name === 'canvas_apply_plan' ? 'plan' : name === 'canvas_fail_request' ? 'fail' : 'apply', payload);
      break;
    }
    default: throw new Error(`未知工具：${name}`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 1;
}
