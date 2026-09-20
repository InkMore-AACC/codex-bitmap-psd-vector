import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'node:crypto';
import http from 'node:http';

const run=promisify(execFile),root=path.resolve('.');
const ps=(script:string,env:NodeJS.ProcessEnv=process.env)=>run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:root,env,windowsHide:true,timeout:20000});
const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'";

test('installer preflight validates explicit runtimes without changing the host or project',async()=>{
 const files=['package-lock.json','plugins/layer-canvas/.mcp.json'];const before=files.map(f=>fs.existsSync(f)?fs.readFileSync(f):null);
 const {stdout}=await ps(`& ./scripts/install.ps1 -CheckOnly -SkipPluginInstall -SkipModels -NodePath ${quote(process.execPath)}`);
 const report=JSON.parse(stdout);assert.equal(report.mode,'check-only');assert.equal(report.node,process.execPath);assert.equal(report.photoshopMcp,true);
 for(const [i,file]of files.entries())assert.deepEqual(fs.existsSync(file)?fs.readFileSync(file):null,before[i]);
 await assert.rejects(()=>ps('& ./scripts/install.ps1 -CheckOnly -SkipPluginInstall -NodePath Z:\missing\node.exe'),/Node/);
});

test('custom Codex home and paths with Chinese, spaces and apostrophes are supported',async()=>{
 const temp=path.join(root,'test-output',"跨电脑 O'Name "+crypto.randomUUID());
 const helper=path.join(temp,'自定义 Codex','skills','.system','plugin-creator','scripts');fs.mkdirSync(helper,{recursive:true});
 for(const name of ['create_basic_plugin.py','read_marketplace_name.py','update_plugin_cachebuster.py'])fs.writeFileSync(path.join(helper,name),'# discovery fixture only');
 const env={...process.env,CODEX_HOME:path.join(temp,'自定义 Codex')};
 const {stdout}=await ps('. ./scripts/runtime-paths.ps1; Resolve-CanvasPluginHelper',env);
 assert.equal(stdout.trim(),path.join(helper,'create_basic_plugin.py'));
 // Parse every shipped PowerShell entrypoint under Windows PowerShell 5.1.
 await ps(`$ErrorActionPreference='Stop'; Get-ChildItem ./scripts/*.ps1 | ForEach-Object { $tokens=$null; $errors=$null; $null=[Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors | Out-String)} }`);
});

test('service rejects a different installation at a stale port and chooses an available port without stopping it',{timeout:30000},async()=>{
 const data=path.join(root,'test-output','portable-service-'+crypto.randomUUID());fs.mkdirSync(data,{recursive:true});
 const foreign=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({name:'layer-canvas',instanceId:'different-installation'}));});
 await new Promise<void>(resolve=>foreign.listen(0,'127.0.0.1',resolve));const port=(foreign.address() as {port:number}).port;
 fs.writeFileSync(path.join(data,'service.json'),JSON.stringify({port,token:'isolated-test-token-only',root,pid:process.pid}));
 const env:NodeJS.ProcessEnv={...process.env,LAYER_CANVAS_DATA:data,LAYER_CANVAS_ROOT:root};delete env.LAYER_CANVAS_PORT;
 let pid:number|undefined;
 try{
  const {stdout}=await run(process.execPath,['--import','tsx','--input-type=module','-e',"const {ensureService}=await import('./bridge/client.ts');const s=await ensureService();console.log(JSON.stringify({port:s.port,pid:s.pid}));"],{cwd:root,env,windowsHide:true,timeout:20000});
  const service=JSON.parse(stdout);pid=service.pid;assert.notEqual(service.port,port);assert.notEqual(pid,process.pid);
  const health:any=await(await fetch(`http://127.0.0.1:${service.port}/api/health`)).json();assert.equal(health.name,'layer-canvas');assert.notEqual(health.instanceId,'different-installation');
  assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/health`)).json() as any).instanceId,'different-installation');
 }finally{
  if(!pid&&fs.existsSync(path.join(data,'service.json'))){const s=JSON.parse(fs.readFileSync(path.join(data,'service.json'),'utf8'));if(s.pid!==process.pid&&s.root===root)pid=s.pid;}
  if(pid)try{process.kill(pid);}catch{}
  foreign.closeAllConnections();await new Promise<void>(resolve=>foreign.close(()=>resolve()));
 }
});
