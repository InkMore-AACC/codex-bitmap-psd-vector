import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {convertInContext} from '../server/vectorizer-browser.js';

test('browser route uploads using page input, downloads SVG, and stops on cancellation', {timeout:30000}, async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({acceptDownloads:true});let uploaded=false;
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0H20V20Z"/></svg>';
 try{
  await context.route('https://vectorizer.com/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/result.svg')return route.fulfill({contentType:'image/svg+xml',headers:{'Content-Disposition':'attachment; filename="layer.svg"'},body:svg});
   if(pathname.startsWith('/review/'))return route.fulfill({contentType:'text/html',body:'<button class="download-btn" onclick="location.href=\'/result.svg\'">DOWNLOAD</button>'});
   return route.fulfill({contentType:'text/html',body:`<input id="fileInput" type="file" onchange="document.querySelector('#reviewBtn').href='/review/fixture'"><a id="reviewBtn">REVIEW AND DOWNLOAD</a>`});
  });
  const result=await convertInContext(context,Buffer.from('fixture'),new AbortController().signal,text=>{if(text.includes('下载'))uploaded=true});
  assert.equal(uploaded,true);assert.match(result,/<path/);
  const controller=new AbortController();controller.abort();await assert.rejects(convertInContext(context,Buffer.from('fixture'),controller.signal,()=>{}),/取消/);
 }finally{await browser.close()}
});
