import type { Psd, Layer } from 'ag-psd';
/** The ordinary canvas flattens the group tree. Reject semantics it cannot render. */
export function assertPsdBlendSupported(psd: Psd) {
  const hasScreen = (nodes: Layer[]): boolean => nodes.some(n => n.blendMode === 'screen' || !!n.children && hasScreen(n.children));
  function walk(nodes: Layer[]) {
    for (const n of nodes) {
      const reject = () => { throw new Error(`「${n.name || '图层'}」含普通画布不能可靠合成的混合模式、剪贴或复杂组；请通过PS副本处理，原文件未修改`); };
      // Layer imageData excludes independent masks. Flattening without applying
      // them would reveal hidden pixels, including a full screen light carrier.
      if (n.mask || n.realMask || n.vectorMask) {
        throw new Error(`「${n.name || '图层'}」含独立蒙版，普通画布暂不能可靠合成；请通过PS副本处理，原文件未修改`);
      }
      if (n.clipping || (n.fillOpacity !== undefined && n.fillOpacity !== 1)) reject();
      if (n.children) {
        if (n.hidden || (n.opacity !== undefined && n.opacity !== 1) || n.effects ||
            (n.blendMode && !['normal', 'pass through'].includes(n.blendMode)) ||
            (n.blendMode !== 'pass through' && hasScreen(n.children))) reject();
        walk(n.children);
      } else if ((n.blendMode && !['normal', 'screen'].includes(n.blendMode)) ||
                 (n.blendMode === 'screen' && n.effects && !n.effects.disabled)) reject();
    }
  }
  walk(psd.children || []);
}
