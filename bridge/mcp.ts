import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CanvasClient } from './client.js';

const client = new CanvasClient();
const server = new McpServer({ name: 'layer-canvas', version: '0.1.0' });
const task = { taskId: z.string().describe('当前真实 Codex task/thread ID。不得取其他任务 ID。') };
const job = { ...task, jobId: z.string() };
const psdStyle = z.object({
  stroke: z.object({ color: z.string().regex(/^#[0-9a-f]{6}$/i), size: z.number().min(0).max(500) }).optional(),
  shadow: z.object({ color: z.string().regex(/^#[0-9a-f]{6}$/i), blur: z.number().min(0).max(500), offsetX: z.number(), offsetY: z.number(), opacity: z.number().min(0).max(1) }).optional(),
});
const output = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const call = (fn: () => Promise<unknown>) => fn().then(output).catch(error => ({ ...output({ error: error instanceof Error ? error.message : String(error) }), isError: true }));

server.registerTool('canvas_open', {
  description: '打开当前 Codex 任务独立的多图分层画布。返回右侧浏览器网址，不新建对话。', inputSchema: task,
}, ({ taskId }) => call(() => client.open(taskId)));

server.registerTool('canvas_import', {
  description: '把当前对话已生成或用户授权的原始本地图片、PSD、SVG导入当前画布。保留原文件；不能凭空指定未产生的生图文件。',
  inputSchema: { ...task, path: z.string().describe('实际存在的本地绝对原文件路径。') },
}, ({ taskId, path }) => call(async () => {
  const doc = await client.document(taskId);
  return client.request(`/api/document/${encodeURIComponent(doc.id)}/import-path`, 'POST', { path, taskId });
}));

server.registerTool('canvas_get_document', {
  description: '读取当前画布的所有图片、图层顺序、全图意见及各层意见和标注。图层数组从底到顶。', inputSchema: task,
}, ({ taskId }) => call(() => client.document(taskId)));

server.registerTool('canvas_wait_requests', {
  description: '在当前对话等待画布按钮提交的规划、分层、修改、Codex 网页矢量化、PS/AI请求，最多50秒。返回队列不等于开始或完成。',
  inputSchema: { ...task, timeoutMs: z.number().int().min(0).max(50000).default(50000), excludeJobIds: z.array(z.string()).default([]) },
}, ({ taskId, timeoutMs, excludeJobIds }) => call(() => client.wait(taskId, timeoutMs, excludeJobIds)));

server.registerTool('canvas_claim_request', {
  description: '领取属于当前对话的排队请求并读取冻结输入交接包。只在准备实际执行时领取；完成需回传真实产物。', inputSchema: job,
}, ({ taskId, jobId }) => call(async () => {
  await client.mutateJob(taskId, jobId, 'claim');
  return client.packet(taskId, jobId);
}));

server.registerTool('canvas_get_request', {
  description: '读取当前任务请求的原图本地路径、输入版本、各层素材及全部修改意见；用于恢复处理中断和验证。generationPlan可只读计算合并框/改尺寸后的坐标；不修改冻结任务。', inputSchema: {...job,generationPlan:z.object({groups:z.array(z.array(z.string()).min(1)).max(300).optional(),width:z.number().int().positive().optional(),height:z.number().int().positive().optional()}).optional()},
}, ({ taskId, jobId,generationPlan }) => call(() => client.packet(taskId, jobId,generationPlan)));

server.registerTool('canvas_apply_plan', {
  description: '提交底到顶的名称、对象画幅box、role和意见。模式3只规划框，禁止调用生图、抠图或提交图片；模式2/4/5由服务运行本地模型生成预览。提交后停止等待用户确认真实重建。',
  inputSchema: { ...job, baseVersion: z.number().int(), message: z.string().optional(),
    layers: z.array(z.object({ name: z.string().min(1).max(300), box: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[x,y,width,height]图片局部像素坐标；模式3是重建画幅，需整数，为发丝阴影留白。'), role: z.enum(['foreground','background']).optional().describe('背景默认整图画幅并标记background。'), opinion: z.string().optional() }).strict()).min(1).max(100),
  },
}, ({ taskId, jobId, ...input }) => call(() => client.mutateJob(taskId, jobId, 'plan', input)));

server.registerTool('canvas_prepare_cutouts', {
  description: '已停用：真实分层不再运行或提供精细抠图素材。粗抠/精抠均仅用于用户预览；请读取任务包 generationInputs，使用干净原图与坐标意见生成重建。调用此旧工具返回明确错误。',
  inputSchema: {...job,baseVersion:z.number().int(),layers:z.array(z.object({id:z.string(),box:z.tuple([z.number(),z.number(),z.number(),z.number()]),role:z.enum(['foreground','background']).optional()})).min(1).max(100).optional()},
},({taskId,jobId,...input})=>call(()=>client.mutateJob(taskId,jobId,'cutouts',input)));

server.registerTool('canvas_complete_request', {
  description: '仅在完成真实生成/编辑并检查一致性后提交实际产物。结果新建来源关联节点；输入后有新意见时标记基于旧版，取消请求拒绝应用。不能把预览、排队或提示词标为生成完成。',
  inputSchema: { ...job, stageOnly:z.boolean().optional().describe('逐层暂存并适配，不完成任务、不新建节点；检查后再提交全部原始文件正式完成。'), baseVersion: z.number().int(), width: z.number().int().min(1).max(30000).optional().describe('总图输出像素宽度，尺寸变化时与height一起提供。'), height: z.number().int().min(1).max(30000).optional(), message: z.string().optional(), vectorSvg: z.string().optional(), artifactPath: z.string().optional().describe('实际保存并检查过的 PSD、SVG 或原生 AI 绝对路径。AI 建议同时回传 SVG 供画布预览。'),
    layers: z.array(z.object({ id: z.string().optional(), sourceLayerIds:z.array(z.string()).min(1).max(300).optional().describe('合并图层时包含全部来源图层ID，输出画幅使用这些冻结frame的并集。'), name: z.string(), path: z.string().optional().describe('实际生图原始文件。frameContract存在时服务按实际尺寸及1%比例容差等比放大/缩小。不要自行拉伸或删细节。'), url: z.string().optional(), sourceCrop:z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive()}).optional().describe('仅确认多余全透明留白时声明原始文件像素裁切框；裁掉任何非零alpha会拒绝。不能自动裁物体包围盒。'), x: z.number().default(0), y: z.number().default(0), width: z.number(), height: z.number(), kind: z.enum(['raster','text','vector']).default('raster'), opacity: z.number().min(0).max(1).default(1), visible: z.boolean().default(true), disposition: z.enum(['keep','rebuild']).default('keep'), opinion: z.string().default(''), textDirty: z.boolean().optional(), psdStyle: psdStyle.optional(), text: z.object({ value: z.string(), fontFamily: z.string(), fontSize: z.number(), color: z.string(), x: z.number(), y: z.number() }).optional() })).optional(),
  },
}, ({ taskId, jobId, ...input }) => call(async () => {
  if (!input.vectorSvg && !input.layers?.length && !input.artifactPath) throw new Error('必须提供实际矢量内容、完成的图层或真实导出文件。');
  if ((input.width === undefined) !== (input.height === undefined)) throw new Error('输出尺寸变化需要同时提供 width 和 height。');
  return client.mutateJob(taskId, jobId, 'apply', input);
}));

server.registerTool('canvas_fail_request', {
  description: '明确记录请求失败/当前能力不可用原因，保留原图及先前结果。不得以提示词或假产物冒充完成。',
  inputSchema: { ...job, message: z.string().min(1) },
}, ({ taskId, jobId, message }) => call(() => client.mutateJob(taskId, jobId, 'fail', { message })));

server.registerTool('canvas_adobe', {
  description: '执行当前已授权 PS/AI 交接请求。先 inspect 获取实际连接和工具清单；call 只调用清单中工具；native_script 可执行本次交接目录内明确 JSX 并验证新输出存在。执行不等于完成，必须验证产物后 canvas_complete_request。',
  inputSchema: {...job, action:z.enum(['inspect','call','native_script']), tool:z.string().optional(), arguments:z.record(z.unknown()).optional(), scriptPath:z.string().optional(), expectedOutputs:z.array(z.string()).optional()},
},({taskId,jobId,...input})=>call(()=>client.mutateJob(taskId,jobId,'adobe',input)));

server.registerTool('canvas_web_vector', {
 description:'Codex 在可见网页完成上传和转换后，download 以当前公开 reviewUrl 接收已有 SVG 并创建画布矢量节点，不重新上传或转换。已获得本地 SVG 可用 complete 回传。status 的 verification/blocked 阶段说明验证或下载受阻，保留任务。',
 inputSchema:{...job,action:z.enum(['status','download','complete']),message:z.string().optional(),phase:z.enum(['working','verification','blocked']).optional(),reviewUrl:z.string().optional().describe('从当前可见网页读取的公开 /review/ 结果页完整地址；download 接收已有结果并回传画布，不重新上传或转换。'),baseVersion:z.number().int().optional(),files:z.array(z.object({layerId:z.string(),path:z.string()})).max(300).optional()},
},({taskId,jobId,...input})=>call(()=>client.mutateJob(taskId,jobId,'web-vector',input)));
await server.connect(new StdioServerTransport());
