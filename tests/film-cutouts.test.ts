import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateFilmCutouts,filmCutoutKnots,type FilmCutout} from '../shared/film-cutouts.js';
const frame={x:0,y:0,width:100,height:100},outer:[number,number][]=[[5,5],[95,5],[90,95],[10,90]],hole:FilmCutout={name:'manual ellipse',center:[50,50],radiusX:9,radiusY:11,angle:30};
test('analytic containment rejects escaping, overlapping and duplicated ellipse windows before creating any raster',()=>{
  assert.doesNotThrow(()=>validateFilmCutouts([hole],frame,outer));
  assert.throws(()=>validateFilmCutouts([{...hole,center:[94,50]}],frame,outer),/完整|内含/);
  assert.throws(()=>validateFilmCutouts([hole,{...hole,name:'other',center:[55,55]}],frame,outer),/相交/);
  assert.throws(()=>validateFilmCutouts([hole,hole],frame,outer),/唯一/);
  assert.throws(()=>validateFilmCutouts([hole],frame,[[5,5],[90,95],[95,5],[10,90]]),/凸四边形/);
  assert.throws(()=>validateFilmCutouts([{...hole,radiusX:0}],frame,outer));
  assert.equal(filmCutoutKnots(hole).length,4);assert.ok(filmCutoutKnots(hole).flat().every(Number.isFinite));
});

test('explicit polygon containment handles clipped corners and rejects stars, edge crossings and legacy widening',()=>{
  const polygon:[number,number][]=[[5,5],[100,5],[100,70],[70,100],[5,90]];
  assert.doesNotThrow(()=>validateFilmCutouts([hole],frame,polygon,'clipped-polygon'));
  assert.throws(()=>validateFilmCutouts([hole],frame,polygon),/四边形/);
  assert.throws(()=>validateFilmCutouts([{...hole,center:[85,85]}],frame,polygon,'clipped-polygon'),/内含/);
  assert.throws(()=>validateFilmCutouts([hole],frame,[[50,5],[76,90],[5,38],[95,38],[24,90]],'clipped-polygon'),/凸多边形/);
  assert.throws(()=>validateFilmCutouts([hole],frame,polygon.slice(0,4),'clipped-polygon'),/五至八/);
});
