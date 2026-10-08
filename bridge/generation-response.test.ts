import test from 'node:test';
import assert from 'node:assert/strict';
import { compactGenerationResponse } from './generation-response.js';

test('MCP keeps prepare instructions and does not mutate recorded generation evidence', () => {
  const input = { id: 'g', originalPath: '/original.png', comparisonHash: 'sha', placementFrame: { x: 1, y: 2, width: 10, height: 20 }, receipt: { tool: 'image_gen', prompt: 'actual prompt', referencePaths: ['/clean.png'] }, alignment: { points: [{ source: [1,2], target: [3,4] }], transform: { scale: 2 } }, autoAlignment: { proposal: { accepted: true, method: 'edge', points: [{ residual: 0.2 }], residualP95: 0.2 } } };
  assert.equal(compactGenerationResponse('prepare', input), input);
  const output: any = compactGenerationResponse('auto-align', input);
  assert.equal(output.originalPath, input.originalPath);
  assert.deepEqual(output.placementFrame, input.placementFrame);
  assert.equal(output.comparisonHash, 'sha');
  assert.equal(output.receipt.promptRecorded, true);
  assert.equal(output.receipt.prompt, undefined);
  assert.deepEqual(output.receipt.referencePaths, ['/clean.png']);
  assert.equal(output.autoAlignment.proposal.accepted, true);
  assert.equal(output.autoAlignment.proposal.residualP95, 0.2);
  assert.equal(output.autoAlignment.proposal.measuredPointCount, 1);
  assert.equal(input.receipt.prompt, 'actual prompt');
  assert.equal(input.alignment.points.length, 1);
  const failed: any = compactGenerationResponse('auto-align', { applied: false, reason: 'ambiguous', record: input, proposal: input.autoAlignment.proposal });
  assert.equal(failed.applied, false);
  assert.equal(failed.reason, 'ambiguous');
  assert.equal(failed.record.id, 'g');
  assert.equal(failed.proposal.points, undefined);
});
