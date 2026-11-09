//! Cancel flags of long-running work (searches, disk usage scans) by id. A
//! cancel can reach Rust before the work registers its id (the start command
//! still checks its folder): such ids are remembered, so the work starts
//! already cancelled instead of running to the end unseen.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// Early cancels kept; older ones belong to work that never started.
const EARLY: usize = 64;

#[derive(Default)]
pub struct Running(Mutex<State>);

#[derive(Default)]
struct State {
    /// Cancel flag and window label of each running job.
    jobs: HashMap<String, (String, Arc<AtomicBool>)>,
    /// Ids cancelled before they started.
    early: VecDeque<String>,
}

impl Running {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers `id` for `window`; work started again under one id replaces
    /// (and stops) the old run. The flag is already set if `id` was cancelled.
    pub fn start(&self, id: &str, window: &str) -> Arc<AtomicBool> {
        let mut s = self.state();
        let cancelled = s.early.iter().position(|e| e == id).map(|i| s.early.remove(i)).is_some();
        let flag = Arc::new(AtomicBool::new(cancelled));
        if let Some((_, old)) = s.jobs.insert(id.to_owned(), (window.to_owned(), Arc::clone(&flag))) {
            old.store(true, Ordering::Relaxed);
        }
        flag
    }

    pub fn cancel(&self, id: &str) {
        let mut s = self.state();
        if let Some((_, flag)) = s.jobs.get(id) {
            flag.store(true, Ordering::Relaxed);
        } else if !s.early.iter().any(|e| e == id) {
            if s.early.len() == EARLY {
                s.early.pop_front();
            }
            s.early.push_back(id.to_owned());
        }
    }

    /// Forgets `id` once its work ended, unless a newer run took the id over.
    pub fn finish(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut s = self.state();
        if s.jobs.get(id).is_some_and(|(_, f)| Arc::ptr_eq(f, flag)) {
            s.jobs.remove(id);
        }
    }

    /// Stops the work of a window that closed or reloaded.
    pub fn cancel_window(&self, label: &str) {
        for (window, flag) in self.state().jobs.values() {
            if window == label {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancel_before_the_start_still_counts() {
        let r = Running::default();
        // Control: a cancel after the start.
        let a = r.start("a", "main");
        assert!(!a.load(Ordering::Relaxed));
        r.cancel("a");
        assert!(a.load(Ordering::Relaxed));
        r.finish("a", &a);

        r.cancel("b");
        r.cancel("b");
        let b = r.start("b", "main");
        assert!(b.load(Ordering::Relaxed));
        r.finish("b", &b);
        // Used up: the id starting again later runs normally.
        assert!(!r.start("b", "main").load(Ordering::Relaxed));

        // A restart under the same id stops the old run; finishing the old one
        // doesn't forget the new one.
        let c1 = r.start("c", "main");
        let c2 = r.start("c", "main");
        assert!(c1.load(Ordering::Relaxed) && !c2.load(Ordering::Relaxed));
        r.finish("c", &c1);
        r.cancel("c");
        assert!(c2.load(Ordering::Relaxed));

        // Windows, and the cap on early cancels.
        let d = r.start("d", "window-2");
        r.cancel_window("window-2");
        assert!(d.load(Ordering::Relaxed));
        for i in 0..=EARLY {
            r.cancel(&format!("never-{i}"));
        }
        assert!(!r.start("never-0", "main").load(Ordering::Relaxed));
        assert!(r.start(&format!("never-{EARLY}"), "main").load(Ordering::Relaxed));
    }
}
