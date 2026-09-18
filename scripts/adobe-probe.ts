import path from 'node:path';
import fs from 'node:fs';
import { AdobeConnector } from '../server/adobe.js';
const root = path.resolve(import.meta.dirname, '..');
const connector = new AdobeConnector(root, path.join(root, 'data'));
try {
  const before = await connector.nativeProbe('photoshop');
  const photoshop = await connector.probe('photoshop');
  const tools = photoshop.route === 'mcp' && photoshop.connected ? await connector.listTools('photoshop') : [];
  const versionTool = tools.find(t => t.name === 'photoshop_get_version');
  const version = versionTool ? await connector.callTool('photoshop', versionTool.name, {}) : undefined;
  const illustrator = await connector.probe('illustrator');
  const after = await connector.nativeProbe('photoshop');
  const evidence = { at: new Date().toISOString(), before, photoshop, version, toolNames: tools.map(t => t.name), illustrator, after, scope: 'Read-only handshake, tool listing and registry-based version probe. No documents opened or modified.' };
  const directory = path.join(root, 'docs', 'evidence', 'adobe-connectors'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'probe.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await connector.close(); }
