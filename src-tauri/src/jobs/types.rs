use serde::{Deserialize, Serialize};

pub use super::archive::ArchiveFormat;
use crate::error::AppError;
use crate::model::FileEntry;

/// What the frontend asks for. Paths are absolute; `dest_dir` is a folder.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobSpec {
    Copy {
        sources: Vec<String>,
        dest_dir: String,
    },
    Move {
        sources: Vec<String>,
        dest_dir: String,
    },
    /// Copies next to the original as "name copy".
    Duplicate {
        sources: Vec<String>,
    },
    Trash {
        paths: Vec<String>,
    },
    /// Permanent; cannot be undone.
    Delete {
        paths: Vec<String>,
    },
    /// Creates one archive of `sources` (siblings) next to them.
    Compress {
        sources: Vec<String>,
        format: ArchiveFormat,
    },
    /// Extracts each archive next to itself.
    Extract {
        archives: Vec<String>,
    },
    /// Copies members out of one archive (`archive:` paths) into a folder.
    ExtractMembers {
        sources: Vec<String>,
        dest_dir: String,
    },
    /// Replays an `UndoAction` from an earlier job (undo and redo alike).
    Undo {
        action: UndoAction,
    },
}

/// Steps that reverse a finished job, in execution order. Running them is itself
/// a job whose outcome carries the steps to redo it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoAction {
    pub label: String,
    pub steps: Vec<UndoStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UndoStep {
    /// Move the item to the Trash (reverses a copy/creation).
    Trash { path: String },
    /// Move an item back (reverses a move, rename, or trashing).
    Move { from: String, to: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Replace,
    Skip,
    KeepBoth,
    Stop,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub choice: ConflictChoice,
    /// Use the same choice for every later conflict in this job.
    pub apply_to_all: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobFailure {
    pub path: String,
    pub error: AppError,
}

#[derive(Debug, Clone, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobOutcome {
    /// Top-level items that now exist (copies, moved items, restored items).
    pub created: Vec<FileEntry>,
    /// Top-level paths that no longer exist (moved away, trashed, deleted).
    pub removed: Vec<String>,
    pub undo: Option<UndoAction>,
    pub failures: Vec<JobFailure>,
    pub skipped: u32,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobEvent {
    Planned {
        #[specta(type = u32)]
        total_bytes: u64,
        total_items: u32,
    },
    Progress {
        #[specta(type = u32)]
        done_bytes: u64,
        done_items: u32,
        current: String,
    },
    /// The job is paused until `resolve_conflict` answers.
    Conflict {
        source: Box<FileEntry>,
        existing: Box<FileEntry>,
    },
    Finished {
        outcome: JobOutcome,
    },
}

#[derive(Debug, Clone, Copy, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SizeInfo {
    #[specta(type = u32)]
    pub bytes: u64,
    #[specta(type = u32)]
    pub allocated: u64,
    pub files: u32,
    pub folders: u32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MeasureEvent {
    Progress { size: SizeInfo },
    Done { size: SizeInfo },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact shapes `src/bindings.ts` produces must deserialize.
    #[test]
    fn frontend_wire_format() {
        let spec: JobSpec =
            serde_json::from_value(json!({ "kind": "copy", "sources": ["/a"], "destDir": "/b" })).unwrap();
        assert!(matches!(spec, JobSpec::Copy { ref dest_dir, .. } if dest_dir == "/b"));

        let spec: JobSpec = serde_json::from_value(json!({
            "kind": "undo",
            "action": { "label": "Rename", "steps": [
                { "kind": "move", "from": "/x/new", "to": "/x/old" },
                { "kind": "trash", "path": "/x/y" }
            ] }
        }))
        .unwrap();
        let JobSpec::Undo { action } = spec else { panic!() };
        assert_eq!(action.steps.len(), 2);

        let res: ConflictResolution =
            serde_json::from_value(json!({ "choice": "keepBoth", "applyToAll": true })).unwrap();
        assert_eq!(res.choice, ConflictChoice::KeepBoth);
        assert!(res.apply_to_all);

        let ev =
            serde_json::to_value(JobEvent::Progress { done_bytes: 5, done_items: 1, current: "/a".into() })
                .unwrap();
        assert_eq!(ev, json!({ "type": "progress", "doneBytes": 5, "doneItems": 1, "current": "/a" }));
    }
}
