import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdobeConnector, scopedAdobePath, validateAdobeUrl } from '../server/adobe.js';
import { buildHandoffPrompt } from '../bridge/handoff.js';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

test('Adobe reports partial success by channel and never treats installation as script success', async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-adobe-status-'));const connector=new AdobeConnector(temp,temp);
 try{
  fs.mkdirSync(path.dirname(connector.photoshopEntry()),{recursive:true});fs.writeFileSync(connector.photoshopEntry(),'fixture');
  connector.nativeProbe=async()=>({installed:true,running:false,scriptConnected:false});connector.listTools=async()=>[];
  const partial=await connector.probe('photoshop');assert.equal(partial.status,'partial');assert.deepEqual(partial.channels.map(c=>c.status),['success','failed']);
  connector.nativeProbe=async()=>({installed:true,running:true,scriptConnected:true});assert.equal((await connector.probe('photoshop')).status,'success');
  connector.listTools=async()=>{throw new Error('technical fixture failure')};const fallback=await connector.probe('photoshop');assert.equal(fallback.status,'partial');assert.equal(fallback.route,'com');assert.equal(fallback.connected,true);
  await connector.configure({photoshop:{mode:'com'}});connector.nativeProbe=async()=>({installed:true,running:true,scriptConnected:false});assert.equal((await connector.probe('photoshop')).status,'failed');
 }finally{await connector.close();fs.rmSync(temp,{recursive:true})}
});

test('Adobe settings keep credential server-side and reject remote/credential-bearing endpoints', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-adobe-'));
  const connector = new AdobeConnector(temp, temp);
  try {
    const result = await connector.configure({ illustrator: { token: 'test-private-token', url: 'http://localhost:18412/v1/mcp' } });
    assert.equal(result.illustrator.hasToken, true); assert.ok(!JSON.stringify(result).includes('test-private-token'));
    assert.ok(!fs.readFileSync(path.join(temp, 'adobe-connections.json'), 'utf8').includes('test-private-token'));
    await connector.configure({ illustrator: { token: '' } });
    assert.equal(connector.publicSettings().illustrator.hasToken, true);
    assert.equal(new AdobeConnector(temp, temp).publicSettings().illustrator.hasToken, true);
    for (const url of ['https://evil.example/mcp', 'http://localhost@evil.example/mcp', 'http://user:pass@localhost/mcp', 'file:///etc/passwd', 'http://localhost/mcp?token=secret']) assert.throws(() => validateAdobeUrl(url));
    await assert.rejects(() => connector.configure({ illustrator: { url: 'https://evil.example' } }));
    assert.equal(connector.publicSettings().illustrator.url, 'http://localhost:18412/v1/mcp');
    await connector.configure({ illustrator: { clearToken: true } }); assert.equal(connector.publicSettings().illustrator.hasToken, false);
  } finally { await connector.close(); fs.rmSync(temp, { recursive: true }); }
});

test('Adobe submitted script and new output paths stay in job scope, including junctions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-adobe-scope-')), scope = path.join(temp, 'job'); fs.mkdirSync(scope);
  const script = path.join(scope, 'work.jsx'); fs.writeFileSync(script, 'true');
  try {
    assert.equal(scopedAdobePath(scope, script, true), fs.realpathSync(script));
    assert.equal(scopedAdobePath(scope, path.join(scope, 'new.psd')), path.join(fs.realpathSync(scope), 'new.psd'));
    assert.throws(() => scopedAdobePath(scope, path.join(temp, 'elsewhere.psd')));
    fs.symlinkSync(temp, path.join(scope, 'outside'), 'junction');
    assert.throws(() => scopedAdobePath(scope, path.join(scope, 'outside', 'escape.ai')));
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test('Unconfigured connectors do not quietly launch paid Adobe generation', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-adobe-policy-')); const connector = new AdobeConnector(temp, temp);
  try {
    await assert.rejects(() => connector.callTool('photoshop', 'photoshop_generative_fill', { prompt: 'test' }), /额度/);
    await connector.configure({ photoshop: { mode: 'disabled' } });
    await assert.rejects(() => connector.listTools('photoshop'), /未启用/);
    assert.match(buildHandoffPrompt('illustrator'), /坐标/);
    assert.match(buildHandoffPrompt('illustrator'), /COM\/ExtendScript/);
  } finally { await connector.close(); fs.rmSync(temp, { recursive: true }); }
});

test('Illustrator HTTP connector decrypts credential for MCP handshake and tool calls, without public echo', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-adobe-http-')), seenHeaders: string[] = [];
  const listener = http.createServer(async (req, res) => {
    seenHeaders.push(req.headers.authorization || '');
    if (req.headers.authorization !== 'Bearer fixture-secret') { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let input = ''; for await (const chunk of req) input += chunk;
    const mcp = new McpServer({ name: 'illustrator-fixture-not-real-adobe', version: '1.0' });
    mcp.registerTool('inspect_fixture', { description: 'Read fixture only', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'fixture document' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport); res.on('close', () => { void mcp.close(); });
    await transport.handleRequest(req, res, JSON.parse(input));
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const connector = new AdobeConnector(temp, temp);
  try {
    await connector.configure({ illustrator: { mode: 'mcp', url: `http://127.0.0.1:${port}/v1/mcp`, token: 'fixture-secret' } });
    const tools = await connector.listTools('illustrator'); assert.equal(tools[0].name, 'inspect_fixture');
    const result = await connector.callTool('illustrator', 'inspect_fixture', {});
    assert.match(JSON.stringify(result), /fixture document/); assert.ok(seenHeaders.length >= 3);
    assert.ok(seenHeaders.every(header => header === 'Bearer fixture-secret'));
    assert.ok(!JSON.stringify(connector.publicSettings()).includes('fixture-secret'));
  } finally { await connector.close(); await new Promise<void>((resolve, reject) => listener.close(e => e ? reject(e) : resolve())); fs.rmSync(temp, { recursive: true }); }
});
