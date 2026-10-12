import type { Job } from './types';

export const JOB_HISTORY_PAGE_SIZE = 30;
export const isActiveJob = (job: Job) =>
  ['queued', 'waiting_codex', 'running'].includes(job.status);

const createdTime = (job: Job) => Date.parse(job.createdAt) || 0;

// API order is storage order. Apply presentation order after every update,
// including polling, submission and cancellation; never truncate active jobs.
export function jobList(jobs: Job[], historyLimit: number) {
  const sorted = [...jobs].sort(
    (a, b) => createdTime(b) - createdTime(a) || a.id.localeCompare(b.id),
  );
  const active = sorted.filter(isActiveJob);
  const history = sorted.filter((job) => !isActiveJob(job));
  return {
    active,
    visible: [...active, ...history.slice(0, historyLimit)],
    hiddenHistory: Math.max(0, history.length - historyLimit),
  };
}

export function jobTiming(job: Job, now = Date.now()) {
  const created = Date.parse(job.createdAt);
  if (!Number.isFinite(created)) return '';
  const submitted = `提交于 ${new Date(created).toLocaleString('zh-CN', { hour12: false })}`;
  if (!isActiveJob(job)) return submitted;
  const seconds = Math.max(0, Math.floor((now - created) / 1000));
  const elapsed = seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${submitted} · 提交后已过 ${elapsed}`;
}
