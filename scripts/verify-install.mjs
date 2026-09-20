// Read-only capability checks, except an isolated write probe and the local report.
// No image generation, Adobe application launch, paid API call or user-canvas edit.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {createCanvas} from '@napi-rs/canvas';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=path.join(root,'data'),checks=[];
async function check(name,action){try{const message=await action();checks.push({name,status:'success',message});}catch(error){checks.push({name,status:'failed',message:String(error.message||error)});}}
await check('图像运行库',async()=>{
 const bytes=await sharp({create:{width:8,height:8,channels:4,background:'#8070c0'}}).png().toBuffer();
 if((await sharp(bytes).metadata()).width!==8||!createCanvas(8,8).toBuffer('image/png').length)throw new Error('真实 PNG 生成/回读失败');
 return '已生成并回读内存中的 PNG；未修改用户图片';
});
await check('数据目录',async()=>{
 fs.mkdirSync(data,{recursive:true});const probe=path.join(data,`.install-write-${crypto.randomUUID()}`);
 try{fs.writeFileSync(probe,'probe',{flag:'wx'});if(fs.readFileSync(probe,'utf8')!=='probe')throw new Error('无法读取写入内容');}finally{if(fs.existsSync(probe))fs.unlinkSync(probe);}
 return '当前用户可保存数据';
});
await check('插件 MCP 工具',async()=>{
 const configuration=JSON.parse(fs.readFileSync(path.join(root,'plugins/layer-canvas/.mcp.json'),'utf8')).mcpServers.layer_canvas;
 if(path.resolve(configuration.env.LAYER_CANVAS_ROOT)!==root)throw new Error('MCP 配置仍指向其他安装目录，请重新安装');
 const client=new Client({name:'canvas-install-check',version:'0.1.0'});
 const transport=new StdioClientTransport({command:configuration.command,args:configuration.args,env:{...process.env,...configuration.env},stderr:'pipe'});
 transport.stderr?.resume();
 try{
  await client.connect(transport,{timeout:15000});const list=await client.listTools(undefined,{timeout:15000});
  for(const name of ['canvas_open','canvas_adobe','canvas_prepare_cutouts'])if(!list.tools.some(t=>t.name===name))throw new Error(`缺少工具 ${name}`);
  return `成功读取 ${list.tools.length} 个工具；宿主加载和实际 Adobe 编辑另行验收`;
 }finally{await client.close();}
});
const report={status:checks.every(c=>c.status==='success')?'success':'failed',checkedAt:new Date().toISOString(),checks,notChecked:['Codex 桌面端的当前对话发送','Adobe 软件内的真实编辑','收费 API','本地模型实际推理']};
if(fs.existsSync(data))fs.writeFileSync(path.join(data,'install-verification.json'),JSON.stringify(report,null,2));
for(const c of checks)console.log(`${c.name}：${c.status==='success'?'成功':'失败'} — ${c.message}`);
if(report.status==='failed')process.exitCode=1;
