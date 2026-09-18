import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import type {Layer} from './types.js';
const SVGNS='http://www.w3.org/2000/svg';
export function parseSvg(svg:string){
 if(svg.length>40_000_000||/<\?(?!xml\s)/i.test(svg))throw new Error('SVG 内容超出限制或含不允许的声明');
 // Illustrator emits an SVG 1.1 doctype with literal namespace entities. Never resolve a DTD.
 const namespaceEntities=new Map<string,string>();
 svg=svg.replace(/<!DOCTYPE\s+svg\b[^\[>]*(?:\[([\s\S]*?)\]\s*)?>/gi,(_declaration,subset:string|undefined)=>{
  let rest=subset||'';rest=rest.replace(/<!ENTITY\s+(ns_[a-z0-9_]+)\s+["'](https?:\/\/[^"'<>&\s]+)["']\s*>/gi,(_all,name:string,value:string)=>{namespaceEntities.set(name,value);return ''});
  if(rest.trim())throw new Error('SVG 不允许一般实体声明');return '';
 });
 for(const [name,value] of namespaceEntities)svg=svg.replaceAll(`&${name};`,value);
 if(/<!DOCTYPE|<!ENTITY/i.test(svg))throw new Error('SVG 不允许实体声明');
 const doc=new DOMParser({onError:(level:string,msg:string)=>{if(level==='fatalError'||level==='error')throw new Error(msg)}}).parseFromString(svg,'image/svg+xml');
 const root=doc.documentElement;if(!root||root.localName!=='svg')throw new Error('不是 SVG 文件');
 // Drop only Illustrator's non-rendered private editability payload; keep its ordinary SVG fallback.
 const adobe='http://ns.adobe.com/AdobeIllustrator/10.0/';
 for(const element of Array.from(root.getElementsByTagName('*'))){
  const privateObject=element.localName==='foreignObject'&&element.getAttribute('requiredExtensions')===adobe&&Array.from(element.childNodes).every(n=>n.nodeType===3&&!n.nodeValue?.trim()||n.nodeType===1&&(n as any).namespaceURI===adobe&&(n as any).localName==='aipgfRef');
  if(privateObject||element.namespaceURI===adobe&&element.localName==='aipgf')element.parentNode?.removeChild(element);
 }
 const elements=Array.from(root.getElementsByTagName('*')) as any[];elements.unshift(root);
 for(const node of elements){if(['script','foreignobject','image','iframe','audio','video','style','animate','animatetransform','set'].includes(node.localName.toLowerCase()))throw new Error(`纯矢量不允许 ${node.localName} 元素`);
 for(const a of Array.from(node.attributes||[]) as any[]){if(/^on/i.test(a.name))throw new Error('SVG 不允许事件脚本');if(/^(?:href|xlink:href)$/i.test(a.name)&&a.value&&!a.value.startsWith('#'))throw new Error('SVG 不允许外部资源');if(/@import|javascript:/i.test(a.value))throw new Error('SVG 不允许外部链接或脚本');for(const match of a.value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)){if(!match[2].trim().startsWith('#'))throw new Error('SVG 不允许外部资源')}}}
 return doc;
}
export const cleanSvg=(svg:string)=>new XMLSerializer().serializeToString(parseSvg(svg));
export function splitSvgLayers(svg:string){
 const doc=parseSvg(svg);
 const groups=(d:ReturnType<typeof parseSvg>)=>{const r=d.documentElement!;let container:any=r;const sw=Array.from(r.childNodes).find((n:any)=>n.localName==='switch') as any;if(sw){const g=Array.from(sw.childNodes).find((n:any)=>n.localName==='g') as any;if(g)container=g}
 const visible=Array.from(container.childNodes).filter((n:any)=>n.nodeType===1&&!['defs','title','desc','metadata','font'].includes(n.localName)) as any[];return visible.length>1&&visible.every(n=>n.localName==='g')?visible:[]};
 const originals=groups(doc);if(!originals.length)return [{name:'矢量图',svg:new XMLSerializer().serializeToString(doc)}];
 return originals.map((original,index)=>{const clone=parseSvg(new XMLSerializer().serializeToString(doc));groups(clone).forEach((g,i)=>{if(i!==index)g.parentNode.removeChild(g)});return {name:original.getAttribute('inkscape:label')||original.getAttribute('data-layer-name')||original.getAttribute('id')||`图层 ${index+1}`,svg:new XMLSerializer().serializeToString(clone)}});
}
export function combineSvg(width:number,height:number,layers:Layer[],read:(url:string)=>string){
 const out=new DOMParser().parseFromString(`<svg xmlns="${SVGNS}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`,'image/svg+xml');const root=out.documentElement!;
 for(const [i,l] of layers.entries()){
  const g=out.createElementNS(SVGNS,'g');g.setAttribute('id',`layer-${i}`);g.setAttribute('data-layer-name',l.name);g.setAttribute('inkscape:groupmode','layer');g.setAttribute('inkscape:label',l.name);g.setAttribute('opacity',String(l.opacity));if(!l.visible)g.setAttribute('display','none');
  if(l.kind==='text'&&l.text){const t=out.createElementNS(SVGNS,'text');t.setAttribute('x',String(l.text.x));t.setAttribute('y',String(l.text.y));t.setAttribute('font-family',l.text.fontFamily);t.setAttribute('font-size',String(l.text.fontSize));t.setAttribute('fill',l.text.color);if(l.psdStyle?.stroke){t.setAttribute('stroke',l.psdStyle.stroke.color);t.setAttribute('stroke-width',String(l.psdStyle.stroke.size*2));t.setAttribute('paint-order','stroke fill')}if(l.psdStyle?.shadow){const shadow=l.psdStyle.shadow;const defs=out.createElementNS(SVGNS,'defs'),filter=out.createElementNS(SVGNS,'filter'),drop=out.createElementNS(SVGNS,'feDropShadow');filter.setAttribute('id',`text-shadow-${i}`);filter.setAttribute('x','-100%');filter.setAttribute('y','-100%');filter.setAttribute('width','300%');filter.setAttribute('height','300%');drop.setAttribute('dx',String(shadow.offsetX));drop.setAttribute('dy',String(shadow.offsetY));drop.setAttribute('stdDeviation',String(shadow.blur/2));drop.setAttribute('flood-color',shadow.color);drop.setAttribute('flood-opacity',String(shadow.opacity));filter.appendChild(drop);defs.appendChild(filter);g.appendChild(defs);t.setAttribute('filter',`url(#text-shadow-${i})`)}for(const [lineIndex,line] of l.text.value.split('\n').entries()){const span=out.createElementNS(SVGNS,'tspan');span.setAttribute('x',String(l.text.x));span.setAttribute('dy',lineIndex?'1.2em':'0');span.appendChild(out.createTextNode(line));t.appendChild(span)}g.appendChild(t)}else{
   if(l.kind!=='vector')throw new Error(`图层「${l.name}」还没有矢量化`);
   const src=parseSvg(l.svg||read(l.url));const e=src.documentElement!;const nodes=[e,...Array.from(e.getElementsByTagName('*'))];const ids=new Map<string,string>();for(const n of nodes){const id=n.getAttribute('id');if(id)ids.set(id,`v${i}_${id}`)}
   for(const n of nodes){for(const a of Array.from(n.attributes)){let value=a.value;if(a.name==='id'&&ids.has(value))value=ids.get(value)!;for(const [old,replacement]of ids){value=value.replace(/url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g,(whole,quote,ref)=>ref===old?`url(#${replacement})`:whole);if((a.name==='href'||a.name==='xlink:href')&&value===`#${old}`)value=`#${replacement}`}n.setAttribute(a.name,value)}}
   e.setAttribute('x',String(l.x));e.setAttribute('y',String(l.y));e.setAttribute('width',String(l.width));e.setAttribute('height',String(l.height));g.appendChild(out.importNode(e,true));
  }root.appendChild(g);
 }
 return new XMLSerializer().serializeToString(out);
}
