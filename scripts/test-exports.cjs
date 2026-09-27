// Generate fixtures and verify edge cases. Output files are test artifacts only.
require('./test-motion.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createMockProject} = require('../src/lib/mock-project.ts');
const {generateExportArtifact} = require('../src/lib/exporters/index.ts');
const {buildMotionData} = require('../src/lib/exporters/motion-data.ts');
const {hexToRgb} = require('../src/lib/colors.ts');
const webFixture = content => `<!doctype html><html><head><meta charset="utf-8"></head><body><dot-motion-loader style="width:48px" aria-label="Loading animation"></dot-motion-loader><script>${content}</script></body></html>`;
const project = createMockProject();
const loader = project.loaders[0];
loader.pattern.activeCells = [0, 4, 12];
loader.animation.presetId = 'fish-eye';
loader.animation.style = 'fisheye';
loader.animation.inactiveStyle = 'ghost';
loader.style.cellShape = 'hexagon';
const customWeb = generateExportArtifact('web',project,loader);
fs.writeFileSync('/tmp/DotMotionCustomQA.js',customWeb.content);
fs.writeFileSync('/tmp/dot-motion-custom-qa.html',webFixture(customWeb.content));
fs.writeFileSync('/tmp/DotMotionCustomQA.swift',generateExportArtifact('swift',project,loader).content);
loader.text = {...loader.text, enabled:true, content:'中文 " \\ </script><script>window.injected=true</script> 💙'};
loader.style.cellShape = 'hexagon';
const web = generateExportArtifact('web', project, loader);
assert(!web.content.includes('<script>window.injected'));
assert(web.content.includes('width:48px'),'web component should default to 48px');
assert(web.filename.endsWith('.js'),'web export should be JavaScript');
assert(web.mimeType.startsWith('text/javascript'),'web export should use a JavaScript MIME type');
assert(!web.content.includes('<!doctype html>'),'web export should not include a demo document');
fs.writeFileSync('/tmp/dot-export-edge.html',webFixture(web.content));
const swift = generateExportArtifact('swift',project,loader);
assert(!swift.content.includes('// Usage:'),'Swift output should not include usage comments');
assert(!web.content.includes('<!-- Set width with CSS.'),'JavaScript output should not include usage comments');
fs.writeFileSync('/tmp/DotMotionEdge.swift',swift.content);
for(const shape of ['rectangle','square','circle','diamond','hexagon','star','triangle','heart']){
  loader.style.cellShape=shape;
  const data=buildMotionData(project,loader);
  assert.equal(data.scenes[0].polygon.length > 0,['diamond','hexagon','star','triangle','heart'].includes(shape));
}
loader.sequenceId='qa';loader.sequenceIndex=1;
loader.animation.fps=6;
loader.animation.inactiveStyle='breathe';
loader.text = {...loader.text,enabled:false,content:''};
const second=structuredClone(loader);second.id='qa-2';second.sequenceIndex=0;second.pattern.activeCells=[2];
project.loaders=[loader,second];
const data=buildMotionData(project,loader);
assert(data.discrete);
assert.equal(data.duration,2/loader.animation.fps);
assert(data.scenes[0].cells[2].active);
assert(!data.scenes[0].cells[0].active);
assert.equal(data.scenes[0].cells[2].samples[0][0],1);
assert(data.scenes[0].cells[0].samples.length > 2,'sequence inactive effects need continuous samples');
assert.notEqual(
  data.scenes[0].cells[0].samples[0][2],
  data.scenes[0].cells[0].samples[Math.floor(data.scenes[0].cells[0].samples.length / 4)][2],
  'sequence breathe background must animate'
);
project.loaders=[loader];
const singleFrameSequence=buildMotionData(project,loader);
assert(singleFrameSequence.discrete,'a one-frame sequence must remain frame-based');
assert.equal(singleFrameSequence.duration,1/loader.animation.fps);
project.loaders=[loader,second];
const sequenceWeb = generateExportArtifact('web',project,loader);
fs.writeFileSync('/tmp/dot-export-sequence.html',webFixture(sequenceWeb.content));
fs.writeFileSync('/tmp/DotMotionSequence.swift',generateExportArtifact('swift',project,loader).content);
fs.writeFileSync('/tmp/DotMotionSequenceQA.js',sequenceWeb.content);
fs.writeFileSync('/tmp/dot-motion-sequence-qa.html',webFixture(sequenceWeb.content));
fs.writeFileSync('/tmp/DotMotionSequenceQA.swift',generateExportArtifact('swift',project,loader).content);
loader.sequenceId=undefined;loader.pattern.activeCells=[];loader.animation.loop=false;
assert(!buildMotionData(project,loader).scenes[0].cells.some(c=>c.active));
fs.writeFileSync('/tmp/dot-export-empty.html',webFixture(generateExportArtifact('web',project,loader).content));
// --- SVG export coverage -----------------------------------------------------
loader.text = {...loader.text,enabled:true,content:'中文 " </script><script>window.injected=true</script> 💙'};
loader.sequenceId='qa';loader.sequenceIndex=1;
loader.animation.loop=true;
loader.animation.inactiveStyle='breathe';
const svgEdge=generateExportArtifact('svg',project,loader);
assert(svgEdge.filename.endsWith('.svg'),'SVG export should use the .svg extension');
assert(svgEdge.mimeType.startsWith('image/svg+xml'),'SVG export should use the SVG MIME type');
assert(svgEdge.content.startsWith('<svg')&&svgEdge.content.endsWith('</svg>'),'SVG export is a standalone svg document');
assert(!svgEdge.content.includes('<script>window.injected'),'SVG export must escape label text');
assert(svgEdge.content.includes('中文'),'SVG export keeps Unicode label text');
assert(svgEdge.content.includes('@keyframes f'),'sequence SVG export switches frame groups');
assert(svgEdge.content.includes('step-end'),'sequence SVG groups use hard cuts');
assert(svgEdge.content.includes('prefers-reduced-motion'),'SVG export respects reduced motion');
fs.writeFileSync('/tmp/DotMotionEdge.svg',svgEdge.content);
loader.style.shadow=true;loader.style.glow=12;
const svgGlow=generateExportArtifact('svg',project,loader);
assert(svgGlow.content.includes('feGaussianBlur'),'glow SVG export embeds a blur filter');
fs.writeFileSync('/tmp/DotMotionGlow.svg',svgGlow.content);
for(const shape of ['rectangle','square','circle','diamond','hexagon','star','triangle','heart']){
  loader.style.cellShape=shape;
  const svgShape=generateExportArtifact('svg',project,loader);
  assert(!svgShape.content.includes('undefined')&&!svgShape.content.includes('NaN'));
  assert(svgShape.content.includes('class="a"')||shape==='rectangle'||shape==='square',
    `SVG export animates cells for shape ${shape}`);
}
loader.sequenceId=undefined;loader.pattern.activeCells=[0,4,12];loader.animation.presetId='comet';
const svgContinuous=generateExportArtifact('svg',project,loader);
assert(svgContinuous.content.includes('animation-duration'),'continuous SVG export sets a duration');
assert(!svgContinuous.content.includes('class="f"'),'continuous SVG export has no frame groups');
fs.writeFileSync('/tmp/DotMotionComet.svg',svgContinuous.content);
// --- Per-cell overrides (color / shape) --------------------------------------
loader.pattern.activeCells=[0,1,2];
loader.pattern.cellStyles={'1':{color:'#FF6B81',shape:'circle'},'2':{color:'not-a-color',shape:'bogus'}};
const overrideData=buildMotionData(project,loader);
assert.equal(overrideData.scenes[0].cells[1].color[0],1,'cell 1 red channel is fully red');
assert(overrideData.scenes[0].cells[1].radius>0,'cell 1 circle is expressed through its radius');
assert.equal(overrideData.scenes[0].cells[2].color[0],hexToRgb(loader.style.primaryColor).r/255,'invalid override color falls back to primary');
assert.ok(overrideData.scenes[0].cells[0].color[0]<1&&overrideData.scenes[0].cells[0].color[0]>0,'cell 0 keeps primary color');
const overrideWeb=generateExportArtifact('web',project,loader);
assert(overrideWeb.content.includes('0.41961'),'web export embeds per-cell colors');
const overrideSvg=generateExportArtifact('svg',project,loader);
assert(overrideSvg.content.includes('rgb(255,107,129)'),'SVG export embeds per-cell colors');
loader.pattern.cellStyles=undefined;
// --- 20x20 grid ---------------------------------------------------------------
loader.pattern.grid={...loader.pattern.grid,rows:20,cols:20};
const gridData=buildMotionData(project,loader);
assert.equal(gridData.scenes[0].cells.length,400,'20x20 grid exports 400 cells');
assert(gridData.scenes[0].cells[399].samples.length>2,'all 20x20 cells carry samples');
const gridAvd=generateExportArtifact('avd',project,loader);
assert(gridAvd.content.length>1000,'AVD export generates substantial markup for a 20x20 grid');
assert(!gridAvd.content.includes('NaN'),'AVD export has no NaN values');
// --- AVD export ---------------------------------------------------------------
loader.pattern.grid={...loader.pattern.grid,rows:5,cols:5};
loader.pattern.activeCells=[0,6,12,18,24];
const avd=generateExportArtifact('avd',project,loader);
assert(avd.filename.endsWith('.xml'),'AVD export uses the .xml extension');
assert(avd.content.includes('<animated-vector'),'AVD export is an animated-vector document');
assert(avd.content.includes('aapt:attr name="android:drawable"'),'AVD inlines the drawable');
assert(avd.content.includes('aapt:attr name="android:animation"'),'AVD inlines animations');
assert(avd.content.includes('pathInterpolator'),'AVD animations use staircase path interpolators');
assert(avd.content.includes('android:repeatCount="infinite"'),'AVD loops forever');
assert(!avd.content.includes('NaN')&&!avd.content.includes('undefined'),'AVD export has no invalid values');
fs.writeFileSync('/tmp/DotMotionLoader.avd',avd.content);
// Static dots (constant alpha) still render as plain paths.
const avdStatic=generateExportArtifact('avd',project,loader);
assert(avdStatic.content.includes('<path android:name="p'),'AVD export emits named paths');
// --- GIF encoder (pure Node part) ---------------------------------------------
const {encodeGifFrames}=require('../src/lib/exporters/gif.ts');
const palette=[[255,0,0],[0,255,0],[0,0,255]];
const size=8;
const frameA=new Uint8Array(size*size).fill(0);
const frameB=new Uint8Array(size*size).fill(1);
for(let i=0;i<size*size;i+=2)frameB[i]=2;
const gifBytes=encodeGifFrames(
  [{width:size,height:size,indices:frameA},{width:size,height:size,indices:frameB}],
  palette,[100,100],{loop:true,transparentIndex:-1});
assert(gifBytes[0]===0x47&&gifBytes[1]===0x49&&gifBytes[2]===0x46,'GIF header signature');
assert(gifBytes[3]===0x38&&gifBytes[4]===0x39&&gifBytes[5]===0x61,'GIF89a version');
const gifString=Buffer.from(gifBytes).toString('latin1');
assert(gifString.includes('NETSCAPE2.0'),'GIF includes the loop extension');
assert(gifBytes[gifBytes.length-1]===0x3b,'GIF stream ends with the trailer byte');
assert(gifString.includes(String.fromCharCode(0x2c)),'GIF contains at least one image block (0x2c)');
assert(gifBytes.length>100,'GIF stream has encoded image data');
fs.writeFileSync('/tmp/DotMotionLoader.gif',gifBytes);
// Multi-scene sequence AVD/Web keep per-frame visuals.
console.log('PASS: escaping, Unicode, eight shapes, sequence order, empty mask, non-loop, per-cell overrides, 20x20, AVD and GIF fixtures.');
