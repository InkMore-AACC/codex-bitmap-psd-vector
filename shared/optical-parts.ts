import { z } from 'zod';

/** Explicit new-plan ownership, never inferred from a material name or old preview. */
export const opticalPartSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  assemblyId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  kind: z.enum(['thin-film', 'opaque-structure', 'surface-detail']),
}).strict();
export type OpticalPart = z.infer<typeof opticalPartSchema>;
export const opticalPartError = (message: string) => Object.assign(new Error(message), { status: 400 });

export type OpticalMember = {
  ids: string[];
  elements: string[];
  part?: OpticalPart;
  checks?: { kind: string }[];
  anchors?: { name: string; point: [number, number]; observation: string }[];
  allowed: boolean;
};
type Relation = { layerIds: string[]; kind: string };

/** Validate declared assemblies only. Numeric/visual checks still happen on actual output. */
export function validateOpticalParts(members: OpticalMember[], relations: Relation[]) {
  const assemblies = new Map<string, OpticalMember[]>();
  for (const member of members) if (member.part) {
    const part = opticalPartSchema.parse(member.part);
    if (!member.allowed || member.ids.length !== 1)
      throw opticalPartError('光学分件仅支持新v4独立normal透明前景；不与背景、光效、预抠或matte载体混用');
    if (!member.checks?.some(c => c.kind === 'clear'))
      throw opticalPartError('光学分件须冻结本件之外的clear区域');
    const solid = member.checks.some(c => c.kind === 'occupied' || c.kind === 'opaque');
    const film = member.checks.some(c => c.kind === 'transmissive');
    if (part.kind === 'thin-film' && (!film || solid))
      throw opticalPartError('连续薄膜须有transmissive区域，实边印字的occupied/opaque须分到实体件');
    if (part.kind === 'opaque-structure' && (!solid || film))
      throw opticalPartError('实体边框/印字须有occupied/opaque区域，不能同时归属连续薄膜');
    const group = assemblies.get(part.assemblyId) || [];
    group.push(member); assemblies.set(part.assemblyId, group);
  }
  for (const group of assemblies.values()) {
    if (group.filter(m => m.part!.kind === 'thin-film').length !== 1 ||
        !group.some(m => m.part!.kind === 'opaque-structure'))
      throw opticalPartError('每个光学组件须有且仅有一个薄膜件，另有独立实体边框/印字件');
    const ids = group.map(m => m.ids[0]);
    if (new Set(ids).size !== ids.length) throw opticalPartError('光学分件来源ID重复');
    const elements = group.flatMap(m => m.elements.map(e => e.trim().toLowerCase()));
    if (new Set(elements).size !== elements.length) throw opticalPartError('光学分件不能重复归属同一元素');
    if (group.some(m => m.part!.version === 2)) {
      if (group.some(m => m.part!.version !== 2))
        throw opticalPartError('同一光学组件不能混用v1/v2定位规则');
      const canonical = (m: OpticalMember) => [...(m.anchors || [])].sort((a, b) => a.name.localeCompare(b.name));
      const anchors = canonical(group[0]);
      if (anchors.length < 3 || new Set(anchors.map(a => a.name)).size !== anchors.length ||
          new Set(anchors.map(a => JSON.stringify(a.point))).size !== anchors.length)
        throw opticalPartError('v2光学组件须事前冻结至少三个名称和位置均独立的共同源定位点');
      const [a, b] = anchors.map(a => a.point);
      if (!anchors.slice(2).some(({ point: c }) =>
        Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) >= 1))
        throw opticalPartError('v2光学组件共同源定位点不能全部共线');
      const binding = JSON.stringify(anchors);
      if (group.some(m => JSON.stringify(canonical(m)) !== binding))
        throw opticalPartError('v2同组件各件须冻结相同名称、坐标和观察的共同源定位点');
    }
    // Connected frozen alignment/occlusion edges, including assemblies larger than a relation.
    const connected = new Set([ids[0]]);
    let previous = 0;
    while (connected.size !== previous) {
      previous = connected.size;
      for (const r of relations) if (['alignment', 'occlusion'].includes(r.kind)) {
        const local = r.layerIds.filter(id => ids.includes(id));
        if (local.some(id => connected.has(id))) local.forEach(id => connected.add(id));
      }
    }
    if (connected.size !== ids.length)
      throw opticalPartError('同一光学组件的每个分件须由冻结alignment/occlusion关系相连');
  }
}

export function opticalPartPrompts(members: OpticalMember[], ids: string[]) {
  const owner = members.find(m => JSON.stringify(m.ids) === JSON.stringify(ids));
  if (!owner?.part) return [];
  const others = members.filter(m => m.part?.assemblyId === owner.part!.assemblyId && m !== owner);
  return [
    `冻结光学唯一归属：组件${owner.part.assemblyId}，本件${owner.part.kind}，仅拥有${owner.elements.join('；')}。`,
    ...(owner.part.version === 2 ? ['同组件各件共用生成前冻结的源定位点；参照其他件的特征定位本件，但不绘制或复制其他件。相同画幅不是轮廓相合的证据，膜边、框边与表面细节仍须原位组合核验。'] : []),
    `同组件排除件：${JSON.stringify(others.map(m => ({ layerId: m.ids[0], kind: m.part!.kind, elements: m.elements })))}。这些件只用于定位，不能烘焙到本层或因排除而改变其原位置。`,
    owner.part.kind === 'thin-film'
      ? '只保留连续薄膜本体的固有色与厚薄变化；移除分属其他件的印字、实体边框、水滴和划痕。移除透见的背景RGB，但薄膜覆盖仍连续，不能把背景轮廓变成薄膜碎孔；外部真空隙才清空。不要虚构物理透射率。'
      : owner.part.kind === 'opaque-structure'
        ? '只保留本件实体边框与印字；固有黑墨不能因颜色深而删除。其余薄膜区域完全清空，不绘制薄膜填充、水滴、划痕或透见背景。'
        : '只保留本件明确列出的表面水滴、划痕或固有反射细节；不填充薄膜底色，不重复实体边框、印字、背景或独立光效。',
    '分件声明和区域alpha规则不是像素归属或视觉一致性证明；最终仍须核对实际分层及整图。',
  ];
}
