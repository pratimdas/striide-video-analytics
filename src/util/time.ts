export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new Error('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60); const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
}
