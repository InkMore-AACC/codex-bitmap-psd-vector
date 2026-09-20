// Preserve edits made while a save is in flight, while accepting the server's
// updated layer previews, versions and other fields that the user did not edit.
export function reconcileSaved<T>(base: T, current: T, saved: T): T {
  if (JSON.stringify(base) === JSON.stringify(current)) return structuredClone(saved);
  if (Array.isArray(base) && Array.isArray(current) && Array.isArray(saved)) {
    if (current.every((x) => x && typeof x === 'object' && typeof x.id === 'string')) {
      const merged = current.map((item) => {
        const before = base.find((x) => x.id === item.id);
        const after = saved.find((x) => x.id === item.id);
        return before && after ? reconcileSaved(before, item, after) : item;
      });
      for (const item of saved)
        if (!base.some((x) => x.id === item.id) && !current.some((x) => x.id === item.id))
          merged.push(item);
      return merged as T;
    }
    return current;
  }
  if (
    base &&
    current &&
    saved &&
    typeof base === 'object' &&
    typeof current === 'object' &&
    typeof saved === 'object' &&
    !Array.isArray(current)
  ) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(current), ...Object.keys(saved)])) {
      const b = (base as any)[key],
        c = (current as any)[key],
        s = (saved as any)[key];
      out[key] = reconcileSaved(b, c, s);
    }
    return out as T;
  }
  return current;
}

// Three-way merge for a task completing during a local edit. Conflicting values
// stay local and are reported: the caller must not write that result silently.
export function mergeConcurrent<T>(
  base: T,
  local: T,
  remote: T,
): { value: T; conflicts: string[] } {
  const conflicts: string[] = [];
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const merge = (b: any, l: any, r: any, at: string): any => {
    if (equal(l, b)) return structuredClone(r);
    if (equal(r, b) || equal(l, r)) return structuredClone(l);
    if (
      Array.isArray(b) &&
      Array.isArray(l) &&
      Array.isArray(r) &&
      [...b, ...l, ...r].every((x) => x && typeof x.id === 'string')
    ) {
      const ids = (list: any[]) => list.map((x) => x.id);
      const baseIds = new Set(ids(b));
      const localOrder = ids(l).filter((id) => baseIds.has(id) && r.some((x) => x.id === id));
      const remoteOrder = ids(r).filter((id) => baseIds.has(id) && l.some((x) => x.id === id));
      const remainingBase = ids(b).filter((id) => localOrder.includes(id));
      if (
        !equal(localOrder, remainingBase) &&
        !equal(remoteOrder, remainingBase) &&
        !equal(localOrder, remoteOrder)
      )
        conflicts.push(`${at}.order`);
      const order = equal(localOrder, remainingBase) ? ids(r) : ids(l);
      for (const id of [...ids(l), ...ids(r), ...ids(b)]) if (!order.includes(id)) order.push(id);
      return order
        .map((id) =>
          merge(
            b.find((x) => x.id === id),
            l.find((x) => x.id === id),
            r.find((x) => x.id === id),
            `${at}[${id}]`,
          ),
        )
        .filter((x) => x !== undefined);
    }
    if (
      b &&
      l &&
      r &&
      typeof b === 'object' &&
      typeof l === 'object' &&
      typeof r === 'object' &&
      !Array.isArray(b) &&
      !Array.isArray(l) &&
      !Array.isArray(r)
    ) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const value = merge(b[key], l[key], r[key], at ? `${at}.${key}` : key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    conflicts.push(at);
    return structuredClone(l);
  };
  return { value: merge(base, local, remote, ''), conflicts };
}
