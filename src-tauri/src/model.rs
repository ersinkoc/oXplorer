use serde::Serialize;

// 64-bit integers are exported as a plain `number` (via `type = u32`; f64 would add
// `| null` for NaN). Byte counts, epoch-ms timestamps and
// inode numbers all stay well below 2^53 in practice.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Dir,
    /// A directory macOS presents as a single document (`.app`, `.bundle`, …).
    Package,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkInfo {
    pub target: String,
    pub target_is_dir: bool,
    pub broken: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub symlink: Option<SymlinkInfo>,
    /// Logical length in bytes; 0 for directories (computed on demand).
    #[specta(type = u32)]
    pub size: u64,
    /// Bytes actually allocated on disk (`st_blocks * 512`).
    #[specta(type = u32)]
    pub allocated: u64,
    /// Unix epoch milliseconds.
    #[specta(type = u32)]
    pub modified_ms: i64,
    #[specta(type = Option<u32>)]
    pub created_ms: Option<i64>,
    #[specta(type = Option<u32>)]
    pub accessed_ms: Option<i64>,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    #[specta(type = u32)]
    pub inode: u64,
    /// Dot-prefixed or carrying the `UF_HIDDEN` flag.
    pub is_hidden: bool,
    /// Finder bookkeeping files (`.DS_Store`, AppleDouble `._*`, …) that stay
    /// hidden even when hidden files are shown.
    pub is_system_junk: bool,
    pub extension: Option<String>,
    /// Finder tags, in the order Finder shows them.
    pub tags: Vec<FinderTag>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FinderTag {
    pub name: String,
    /// Finder label color: 0 none, 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange.
    pub color: u8,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DirEvent {
    Batch {
        entries: Vec<FileEntry>,
    },
    Done {
        total: u32,
    },
    /// Follows `Done`: Finder tags for the entries that have any.
    Tags {
        entries: Vec<TaggedPath>,
    },
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaggedPath {
    pub path: String,
    pub tags: Vec<FinderTag>,
}

/// Pushed by the watcher for each watched directory whose children changed.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct DirChanged {
    pub dir: String,
    /// Created or modified children, freshly stat'ed.
    pub upserted: Vec<FileEntry>,
    /// Paths of children that no longer exist.
    pub removed: Vec<String>,
    /// Events were dropped (or the directory itself changed); re-list it.
    pub rescan: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub name: String,
    pub mount_point: String,
    #[specta(type = u32)]
    pub total_bytes: u64,
    #[specta(type = u32)]
    pub available_bytes: u64,
    pub file_system: String,
    pub is_root: bool,
    pub is_local: bool,
    pub is_read_only: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInfo {
    #[specta(type = u32)]
    pub total_bytes: u64,
    #[specta(type = u32)]
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StandardLocation {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FullDiskAccess {
    Granted,
    Denied,
    Unknown,
}

/// The Quick Look panel opened or closed (by the app or by the user).
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookState {
    pub visible: bool,
}

/// An arrow key pressed while the Quick Look panel has focus.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookKey {
    pub key: String,
    pub shift: bool,
}

/// Paths were handed to the app (second launch, `open -a`, Dock drop); fetch
/// them with `take_open_requests`.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequested {
    pub count: u32,
}
