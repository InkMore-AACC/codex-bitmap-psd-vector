import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationFitPoints, type RegistrationProposal } from '../server/generation-registration.js';
import {contourSearchSchema,contourSearchViewport} from '../shared/contour-search.js';

function proposal(): RegistrationProposal {
  const points = Array.from({ length: 64 }, (_, i) => {
    const source: [number, number] = [30 + Math.floor(i / 8) * 70, 30 + (i % 8) * 55];
    return { source, target: [source[0] * 0.8 + 15, source[1] * 0.8 + 20] as [number, number],
      role: i % 4 === 1 ? 'validation' as const : 'fit' as const, inlier: i % 4 !== 1, residual: 0 };
  });
  return { accepted: true, method: 'sift', reason: 'synthetic geometry fixture', scope: 'geometry only',
    sourceSize: [640, 480], referenceSize: [640, 480], featureCounts: [64,64], matchCount: 64, points,
    holdout: { version: 1, split: 'source-x-y-order-quarter-before-fit', trainingCount: 48,
      validationCount: 16, passingCount: 16, passingRatio: 1, sourceExtent: [600,440],
      sourceCoverage: [0.8,0.8], residualThreshold: 2, minimumPassingCount: 4,
      minimumPassingRatio: 0.6, minimumCoverage: 0.2, usedForFit: false } };
}
test('frozen contour scope maps only by uniform viewport scale and rejects out-of-frame or post-selected input fields',()=>{
  const scope={version:1 as const,box:[915,470,50,50] as [number,number,number,number],observation:'源图查看确认的上定位符范围，生成前冻结，不按候选调整'};
  assert.deepEqual(contourSearchViewport(scope,{x:610,y:420,width:390,height:540},[780,1080]),[610,100,100,100]);
  assert.throws(()=>contourSearchViewport(scope,{x:930,y:490,width:50,height:50},[50,50]),/冻结/);
  assert.throws(()=>contourSearchViewport(scope,{x:610,y:420,width:390,height:540},[780,540]),/统一比例/);
  assert.throws(()=>contourSearchSchema.parse({...scope,generationId:'late-output'}));
});
test('automatic registration excludes reserved pairs from the consumers refit', () => {
  const p = proposal(), points = registrationFitPoints(p);
  assert.equal(points.length,48); assert(points.every(p => p.role === 'fit'));
});
test('automatic registration remeasures held-out errors despite a claimed passing summary', () => {
  const p = proposal();
  for (const point of p.points!) if (point.role === 'validation') point.target[0] += 12;
  assert.throws(() => registrationFitPoints(p), /未参与拟合/);
});
test('automatic feature registration refuses missing or post-selected validation evidence', () => {
  const p = proposal(); delete p.holdout;
  assert.throws(() => registrationFitPoints(p), /缺少/);
  const changed = proposal();
  [changed.points![0].role,changed.points![1].role] = [changed.points![1].role,changed.points![0].role];
  [changed.points![0].inlier,changed.points![1].inlier] = [changed.points![1].inlier,changed.points![0].inlier];
  assert.throws(() => registrationFitPoints(changed), /划分/);
  const edge = proposal(); edge.method = 'edge'; delete edge.holdout;
  assert.equal(registrationFitPoints(edge).length,48);
});
