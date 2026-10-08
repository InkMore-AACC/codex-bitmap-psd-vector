/** Keep executable instructions intact; omit repeated logs from completed operations. */
export function compactGenerationResponse(action: string, value: unknown): unknown {
  if (!['register', 'derive-packed-alpha', 'render-native-text', 'render-native-geometry', 'align', 'auto-align', 'review'].includes(action)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result: any = structuredClone(value);
  let omitted = false;
  const compactProposal = (proposal: any) => {
    if (!proposal || typeof proposal !== 'object') return;
    if (Array.isArray(proposal.points)) {
      proposal.measuredPointCount = proposal.points.length;
      delete proposal.points;
      omitted = true;
    }
    for (const attempt of proposal.attempts || []) compactProposal(attempt);
  };
  const compactRecord = (record: any) => {
    if (!record || typeof record !== 'object') return;
    if (record.receipt?.prompt) {
      record.receipt.promptRecorded = true;
      delete record.receipt.prompt;
      omitted = true;
    }
    if (Array.isArray(record.alignment?.points)) {
      record.alignment.measuredPointCount = record.alignment.points.length;
      delete record.alignment.points;
      omitted = true;
    }
    compactProposal(record.autoAlignment?.proposal);
  };
  compactRecord(result);
  compactRecord(result.record);
  compactProposal(result.proposal);
  if (omitted)
    result.detailsNote =
      '完整提示词和测量点仍保存在本任务generation/registry.json；此响应省略重复记录，保留素材、位置、置信及对比证据。';
  return result;
}
