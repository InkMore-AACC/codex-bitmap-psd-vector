import fs from 'node:fs';
import path from 'node:path';
import { AdobeConnector, type AdobeApp } from '../server/adobe.js';

// Reuse the reviewed isolated-document JSX fixtures, not the old PowerShell runner.
// Every actual Adobe call here goes through AdobeConnector.executeScript.
const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'scripts', 'adobe-smoke.ps1'), 'utf8');
function literal(name: string) {
  const startMarker = `$${name}=@'`, start = template.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing reviewed JSX fixture: ${name}`);
  const body = template.indexOf('\n', start) + 1, end = template.indexOf("\n'@", body);
  if (end < 0) throw new Error('Invalid fixture delimiter');
  return template.slice(body, end).replace(/\r\n/g, '\n');
}
const directory = path.join(root, 'docs', 'evidence', 'adobe-connectors', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(directory, { recursive: false });
const connector = new AdobeConnector(root, path.join(root, 'data'));
const results: Record<string, unknown>[] = [];
try {
  for (const app of ['photoshop', 'illustrator'] as AdobeApp[]) {
    const script = literal('jsonUtility') + '\n' + literal(app).replace('__DIRECTORY__', JSON.stringify(directory.replace(/\\/g, '/'))).replace(/LayerCanvas-Isolated-/g, 'LayerCanvas-Connector-');
    const scriptPath = path.join(directory, app + '.jsx'); fs.writeFileSync(scriptPath, script);
    const expectedOutputs = (app === 'photoshop'
      ? ['native-layers.psd', 'native-layers-preview.png']
      : ['native-vectors.ai', 'native-vectors.svg', 'native-vectors-preview.png']).map(file => path.join(directory, file));
    const before = await connector.nativeProbe(app), started = Date.now();
    console.log(`Running NEW connector channel: ${app}`);
    try {
      const response = await connector.executeScript(app, scriptPath, directory, expectedOutputs);
      const inspection = JSON.parse(response.execution.result);
      const fileHeaderValid = app === 'photoshop'
        ? fs.readFileSync(expectedOutputs[0]).subarray(0, 4).toString('ascii') === '8BPS'
        : fs.readFileSync(expectedOutputs[0]).subarray(0, 4).toString('ascii') === '%PDF';
      const svg = app === 'illustrator' ? fs.readFileSync(expectedOutputs[1], 'utf8') : '';
      const nativeStructureValid = app === 'photoshop'
        ? inspection.layerCount === 2 && inspection.textEditable && inspection.editRoundTrip && inspection.nativeDropShadow && inspection.warpBend === 15
        : inspection.layerCount === 2 && inspection.pathCount === 2 && inspection.textCount === 1 && inspection.editRoundTrip && /<text\b/.test(svg) && !/<image\b/i.test(svg);
      const verified = Boolean(inspection.ok && fileHeaderValid && nativeStructureValid && inspection.documentsBefore === inspection.documentsAfter && inspection.dialogsRestored && !inspection.closeError);
      const result = { app, channel: 'AdobeConnector.executeScript', elapsedSeconds: (Date.now() - started) / 1000, before, after: await connector.nativeProbe(app), inspection, fileHeaderValid, verified, artifacts: response.artifacts, visualConsistencyOfArbitraryImagesTested: false };
      results.push(result); fs.writeFileSync(path.join(directory, app + '-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      const result = { app, channel: 'AdobeConnector.executeScript', elapsedSeconds: (Date.now() - started) / 1000, verified: false, error: String(error) };
      results.push(result); fs.writeFileSync(path.join(directory, app + '-result.json'), JSON.stringify(result, null, 2)); console.error(JSON.stringify(result));
    }
  }
} finally {
  await connector.close(); fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(`Evidence: ${directory}`);
if (results.some(result => !result.verified)) process.exitCode = 1;
