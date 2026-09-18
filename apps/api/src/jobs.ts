/**
 * Adjudication runs in the background.
 *
 * A dispute makes three model calls per claim plus screening, and on a
 * rate-limited key that adds up to a minute or more. Holding an HTTP request
 * open that long means the browser times out on work that is quietly
 * succeeding — which looks exactly like a server error and is the worst
 * possible failure to show someone waiting on a deposit.
 *
 * So the request starts the job and returns immediately; the UI polls.
 *
 * In-memory, which is the right size for this: a process restart mid-dispute
 * loses the job record, but never the outcome — the verdict is written to the
 * database and the chain before the job is marked done, and re-running a
 * resolved dispute is refused. A lost job is a lost progress bar, not lost money.
 */
export type JobStatus = "running" | "done" | "failed";

export interface Job {
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Set when done. */
  result?: Record<string, unknown>;
  /** Set when failed — shown to the user, so it has to be readable. */
  error?: string;
  /** Rough progress, for something better than an indefinite spinner. */
  step?: string;
}

const jobs = new Map<string, Job>();

/** Jobs older than this are cleared so the map cannot grow without bound. */
const TTL_MS = 30 * 60 * 1000;

export function getJob(key: string): Job | undefined {
  sweep();
  return jobs.get(key);
}

export function isRunning(key: string): boolean {
  return getJob(key)?.status === "running";
}

export function setStep(key: string, step: string): void {
  const job = jobs.get(key);
  if (job) job.step = step;
}

/**
 * Starts a job unless one is already running for this key.
 *
 * Returns the existing job on a double-submit rather than starting a second
 * adjudication — two panels ruling on the same dispute would both try to submit
 * a verdict, and the loser would fail confusingly on a nonce the contract has
 * already burned.
 */
export function startJob(
  key: string,
  work: (progress: (step: string) => void) => Promise<Record<string, unknown>>
): Job {
  const existing = getJob(key);
  if (existing?.status === "running") return existing;

  const job: Job = { status: "running", startedAt: Date.now(), step: "Starting" };
  jobs.set(key, job);

  void work((step) => setStep(key, step))
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.finishedAt = Date.now();
    })
    .catch((err: unknown) => {
      job.status = "failed";
      job.error = (err as Error)?.message ?? "Adjudication failed";
      job.finishedAt = Date.now();
      console.error(`[job ${key}] failed:`, err);
    });

  return job;
}

export function clearJob(key: string): void {
  jobs.delete(key);
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(key);
  }
}
