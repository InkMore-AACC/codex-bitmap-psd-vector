import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {reviewAddress,receiveInContext} from '../server/web-vector-download.js';

test('download receiver permits only official public review URLs',()=>{
 assert.equal(reviewAddress('https://vectorizer.com/review/0123456789abcdef'),'https://vectorizer.com/review/0123456789abcdef');
 for(const value of ['http://vectorizer.com/review/0123456789abcdef','https://evil.test/review/0123456789abcdef','https://vectorizer.com/api/result','https://vectorizer.com/review/0123456789abcdef?url=http://localhost'])assert.throws(()=>reviewAddress(value));
});
test('receiver maps reversed result rows, resumes downloads, rejects incomplete or bitmap output', {timeout:30000},async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({acceptDownloads:true});
 const output=path.resolve('test-output/receiver-'+Date.now());let downloads=0,mode='valid';
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path fill="#123456" d="M0 0H20V20H0Z"/></svg>';
 await context.route('https://vectorizer.com/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname.endsWith('.svg')){downloads++;return route.fulfill({contentType:'image/svg+xml',headers:{'Content-Disposition':`attachment; filename="${path.basename(pathname)}"`},body:mode==='bitmap'?'<svg><image href="data:image/png;base64,AAA"/></svg>':svg})}
  const names=mode==='incomplete'?['web-input-0']:['web-input-1','web-input-0'];
  return route.fulfill({contentType:'text/html',body:names.map(n=>`<div class="review"><input class="name-input" value="${n}" placeholder="${n}"><button onclick="location.href='/${n}.svg'">DOWNLOAD</button></div>`).join('')});
 });
 const inputs=[{layerId:'bottom',uploadPath:'/input/web-input-0.png'},{layerId:'top',uploadPath:'/input/web-input-1.png'}];
 const receive=(folder=output,signal=new AbortController().signal)=>receiveInContext(context,'https://vectorizer.com/review/0123456789abcdef',inputs,folder,signal,()=>{});
 try{
  const files=await receive();assert.deepEqual(files.map(f=>f.layerId),['bottom','top']);assert.equal(downloads,2);assert.match(await fs.readFile(files[0].path,'utf8'),/<path/);
  await receive();assert.equal(downloads,2,'resume must not redownload validated files');
  mode='incomplete';await assert.rejects(receive(),/数量/);
  mode='bitmap';await assert.rejects(receive(output+'-bitmap'),/不允许/);
  const controller=new AbortController();controller.abort();mode='valid';await assert.rejects(receive(output+'-cancel',controller.signal),/abort/i);
 }finally{await browser.close()}
});
