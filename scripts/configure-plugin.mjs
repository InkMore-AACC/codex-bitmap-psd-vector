import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const plugin=path.join(root,'plugins','layer-canvas');
fs.mkdirSync(path.join(plugin,'.codex-plugin'),{recursive:true});
fs.writeFileSync(path.join(plugin,'.mcp.json'),JSON.stringify({mcpServers:{layer_canvas:{command:process.execPath,args:['--import',pathToFileURL(path.join(root,'node_modules','tsx','dist','loader.mjs')).href,path.join(root,'bridge','mcp.ts')],env_vars:['CODEX_APP_TOOLS_PIPE_PATH'],env:{LAYER_CANVAS_ROOT:root,LAYER_CANVAS_DATA:path.join(root,'data')}}}},null,2));
fs.writeFileSync(path.join(plugin,'.codex-plugin','plugin.json'),JSON.stringify({name:'layer-canvas',version:'0.1.0',description:'Windows 本地多图画布、PSD 分层与逐层矢量化。',author:{name:'InkMore'},skills:'./skills/',mcpServers:'./.mcp.json',interface:{displayName:'分层画布',shortDescription:'多图标注、PSD 分层、自动网页 / 官方 API / 302 矢量化',longDescription:'当前 Codex 对话独立画布；两种 PSD 分层方案，Vectorizer.com 自动网页、Vectorizer.AI 官方 API、Recraft 官方 API 和 302.AI 转接可选。支持 PSD 导入导出及 PS/AI 最终交接。',developerName:'InkMore',category:'Productivity',capabilities:['Read','Write'],defaultPrompt:['打开分层画布','把刚生成的图片导入分层画布','处理画布请求']}},null,2));
console.log('Configured plugin for '+root);
