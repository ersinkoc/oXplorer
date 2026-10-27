import { create } from "zustand";
import type { FileEntry } from "@/lib/ipc";

export interface JobConflict {
  source: FileEntry;
  existing: FileEntry;
}

export interface JobView {
  id: string;
  label: string;
  startedAt: number;
  totalBytes: number;
  totalItems: number;
  doneBytes: number;
  doneItems: number;
  current: string;
  conflict: JobConflict | null;
}

interface JobsState {
  jobs: Record<string, JobView>;
  update: (id: string, patch: Partial<JobView>) => void;
  remove: (id: string) => void;
}

export const useJobs = create<JobsState>()((set) => ({
  jobs: {},
  update: (id, patch) =>
    set((s) => {
      const prev = s.jobs[id];
      if (!prev) return s;
      return { jobs: { ...s.jobs, [id]: { ...prev, ...patch } } };
    }),
  remove: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.jobs;
      return { jobs: rest };
    }),
}));

/** Fraction done in [0, 1]; byte-based when sizes are known, else by item count. */
export function jobProgress(j: JobView): number {
  if (j.totalBytes > 0) return Math.min(1, j.doneBytes / j.totalBytes);
  if (j.totalItems > 0) return Math.min(1, j.doneItems / j.totalItems);
  return 0;
}
