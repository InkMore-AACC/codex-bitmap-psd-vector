/** Existing tests exercise persisted v1/v2 jobs. New v3 behavior is covered in
 * generation.test.ts with production defaults and no fixture downgrade. */
export async function persistedLegacyJob(route: string, value: any) {
  if (!route.match(/\/jobs$/) || !value?.id || !value?.type) return;
  const store = await import('../server/store.js');
  const j = store.getJob(value.id);
  delete j.reconstructionVersion;
  delete j.reconstructionWorkflowVersion;
  store.saveJob(j);
}
