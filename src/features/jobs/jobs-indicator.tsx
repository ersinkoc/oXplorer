import { Pause, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cancelJob, pauseJob } from "@/commands/jobs";
import { useT } from "@/i18n";
import { formatSize } from "@/lib/format";
import { basename } from "@/lib/path";
import { type JobView, jobProgress, useJobs } from "@/stores/jobs-store";

/** Jobs shorter than this never show UI, so quick operations don't flicker. */
const SHOW_AFTER_MS = 400;

/** Toolbar progress ring with a popover listing running jobs. */
export function JobsIndicator() {
  const { t, tn } = useT();
  const jobs = useJobs((s) => s.jobs);
  const [now, setNow] = useState(() => performance.now());
  const [open, setOpen] = useState(false);
  const list = Object.values(jobs);

  useEffect(() => {
    if (list.length === 0) return;
    const timer = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(timer);
  }, [list.length]);

  const visible = list.filter((j) => now - j.startedAt >= SHOW_AFTER_MS);
  if (visible.length === 0) return null;
  const overall = visible.reduce((sum, j) => sum + jobProgress(j), 0) / visible.length;

  return (
    <div className="relative">
      <button
        type="button"
        title={t("Show progress")}
        aria-label={tn(visible.length, "{count} operation in progress", "{count} operations in progress")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-7 items-center justify-center rounded-md hover:bg-hover"
      >
        <Ring value={overall} />
      </button>
      {open && (
        <div className="absolute top-9 right-0 z-40 flex w-80 flex-col gap-3 rounded-xl border border-border bg-bg p-3 shadow-xl">
          {visible.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ job }: { job: JobView }) {
  const { t } = useT();
  const p = jobProgress(job);
  const detail =
    job.totalBytes > 0
      ? t("{done} of {total}", { done: formatSize(job.doneBytes), total: formatSize(job.totalBytes) })
      : t("{done} of {total} items", {
          done: job.doneItems.toLocaleString(),
          total: job.totalItems.toLocaleString(),
        });
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          {job.current
            ? t("{action} “{name}”", { action: t(job.label), name: basename(job.current) })
            : t(job.label)}
        </div>
        <div className="my-1 h-1.5 overflow-hidden rounded-full bg-hover">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${p * 100}%` }}
          />
        </div>
        <div className="text-fg-muted">
          {job.conflict ? t("Waiting for your decision…") : job.paused ? t("Paused") : detail}
        </div>
      </div>
      <button
        type="button"
        title={job.paused ? t("Resume") : t("Pause")}
        aria-label={job.paused ? t("Resume") : t("Pause")}
        onClick={() => pauseJob(job.id, !job.paused)}
        className="rounded-full p-0.5 text-fg-muted hover:bg-hover hover:text-fg"
      >
        {job.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
      </button>
      <button
        type="button"
        title={t("Stop")}
        aria-label={t("Stop {action}", { action: t(job.label) })}
        onClick={() => cancelJob(job.id)}
        className="rounded-full p-0.5 text-fg-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Ring({ value }: { value: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        strokeLinecap="round"
      />
    </svg>
  );
}
