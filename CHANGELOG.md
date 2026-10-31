# Changelog

## 0.1.0 — unreleased

The first public build of OXplorer.

### Browse

- Huge folders stream in: 100,000 items list in about a second, first rows in ~20 ms, with live updates.
- List, icon and column views (⌘1 / ⌘2 / ⌘3), Finder-style natural sorting and keyboard navigation. Bigger / Smaller Icons (⌘= / ⌘-) in icon view.
- Sort by Name, Kind, Date Modified, Date Created or Size from the View menu (⌃⌥⌘1 / 2 / 5 / 6 / 7), in every view; Keep Folders on Top can be turned off. Right-click the list header to choose columns (Date Created is one).
- Tabs in each pane, dual pane (⌘U), and your tabs and layout come back at launch. Reopen Closed Tab (⇧⌘T).
- More windows with New Window (⌘N) or Open in New Window on a folder or tab; a tab's menu also has Show in Finder and Copy Path.
- Right-click Back or Forward to jump several folders at once. Path bar folders open in a new tab with ⌘-click or a middle click, and right-click offers New Tab, New Window, Show in Finder and Copy Path. Go → Recent Folders lists the last 15 folders you opened.
- Each folder remembers its view and sorting, like Finder.

### Work with files

- Copy, move, duplicate, trash and delete with progress, pause, cancel, and undo / redo (⌘Z / ⇧⌘Z).
- Shared clipboard and drag and drop with Finder; F5 / F6 copy or move to the other pane.
- Spring-loaded folders: hold a dragged item over a folder to open it.
- Merge folders when a folder with the same name is already there (undo puts everything back).
- Compress to zip, tar.gz or tar.zst and extract archives. Zip with Password… makes an AES-256 encrypted zip; Extract Here asks for the password of encrypted zips, and so does opening, Quick Looking or copying out a file while browsing one (once per session; the password stays in memory only).
- Split File… cuts a big file into numbered parts (`name.001`, `.002`, …; presets for e-mail, CD, DVD and the FAT32 4 GB limit, or a custom size), into the same folder or the other pane. Combine Files joins them back (also 7-Zip / Total Commander parts). Both run as cancellable, undoable jobs.
- Verify Checksums… checks every file a checksum list names (`SHA256SUMS`, `.sha256`, `.md5`, …; GNU and BSD formats, MD5 / SHA-1 / SHA-256 / SHA-512) and shows which match, differ or are missing.
- Create Checksum File… hashes the selected files into `SHA256SUMS` (or `name.sha256` for one file; MD5, SHA-1 and SHA-512 too) beside them, never replacing an existing list; the job can be cancelled, paused and undone.
- Rotate Left / Rotate Right (File menu and the item menu for pictures) turn pictures in place; the original goes to the Trash, so Undo brings it back. The preview pane reloads a picture that changed in place.
- ⌘V with a copied picture or text (and no files) on the clipboard saves it into the folder as “Pasted Image.png” / “Pasted Text.txt” and starts renaming it; Undo removes it.
- Change Dates… (File menu and the item menu) sets the modified and/or created date of the selected items, with a Now button; Undo puts the old dates back.
- Extract to Other Pane (⌥F9; File menu and the item menu for archives) extracts the selected archives into the folder open in the other pane.
- Empty Trash… (⇧⌘⌫) permanently erases what's in the Trash after asking, as in Finder.
- Rename many items at once, edit Finder tags.
- Open With works on a folder too: editors and terminals that open folders, plus Terminal.
- New Folder with Selection (⌃⌘N), undone in one step.
- Make Alias (⌃⌘A) creates a symbolic link next to the item.
- Convert Image… makes JPEG, PNG, HEIF or TIFF copies of pictures, optionally scaled down, next to the originals (undo removes them).
- Select by pattern (Select Matching…, `*.jpg; *.png`), Invert Selection, Deselect All (⌥⌘A).
- Calculate Folder Sizes (⌥⌘S) shows folder totals in the list and sorts by them.
- Find Duplicates… lists files with the same contents and moves the extra copies to the Trash.

### Find

- Filter a folder (⌘F) by name or patterns like `*.jpg; *.png`, search names, contents or Spotlight (⇧⌘F) with kind, size and date filters (even without a name: "files over 1 GB"), Finder tags in the sidebar.
- Command palette (⌘K) with your most used folders.
- Go to Folder (⇧⌘G) completes folder names with Tab and the arrow keys.
- Finder's Go shortcuts: Documents (⇧⌘O), Desktop (⇧⌘D), Downloads (⌥⌘L), Applications (⇧⌘A), Utilities (⇧⌘U).
- Add folders, searches and server folders to the sidebar (⌃⌘T) or by dragging folders onto Favorites; ⌃1…⌃9 jump to the first nine.

### Look inside

- Preview pane (⇧⌘P) with syntax-highlighted code, Markdown, images, audio and video; shows image dimensions and playing time, and a hex dump of binary files (Show Hex).
- Quick Look (Space).
- Get Info (⌘I): SHA-256 checksum of a file and editable permissions, and Locked like Finder.

### Beyond Finder

- Browse zip and tar archives like folders and copy out of them.
- Servers in the sidebar: SFTP, FTP / FTPS, WebDAV and S3, passwords in the Keychain.
- Git status badges and the branch in the status bar.
- Compare Files: a line-by-line diff of two text files (two selected, or one in each pane).
- Synchronized Browsing: the other pane follows into same-named subfolders and back up.
- Compare Panes marks what differs between the two folders; Select Differences + F5 syncs.
- Synchronize Folders… compares the two panes' folders with their subfolders and copies the newer side over (both ways or one way, per item adjustable); replaced items go to the Trash and the whole run undoes in one step. Compare Contents reads same-size files so copies with other dates don't count.
- Disk Usage (⌥⌘D): a treemap of what takes space.
- "Open in OXplorer" in Finder's context menu and toolbar (Finder extension).

### Terminal

- Your login shell in a panel (⌃`), following the pane's folder in Link mode.

### Settings

- Appearance, Turkish and English, terminal options and customizable shortcuts (⌘,).
- Check for Updates… also works in beta builds: it points to a newer release on GitHub.
