#!/usr/bin/env bash
# Generates a directory for listing/scroll benchmarks.
#   scripts/gen-fixture.sh /tmp/ox-100k 100000
# Contents: N empty files with mixed names/extensions, some folders, hidden files,
# NFD-normalized unicode names, symlinks (incl. a loop and a broken one).
set -euo pipefail
dir=${1:?usage: gen-fixture.sh <dir> [count]}
count=${2:-10000}
mkdir -p "$dir"
cd "$dir"
python3 - "$count" <<'PY'
import os, sys, unicodedata
n = int(sys.argv[1])
exts = ["txt", "png", "rs", "ts", "pdf", "md", "jpg", "json", ""]
for i in range(n):
    ext = exts[i % len(exts)]
    name = f"file{i}" + (f".{ext}" if ext else "")
    open(name, "w").close()
for i in range(50):
    os.makedirs(f"Folder {i}", exist_ok=True)
for name in [".hidden-a", ".hidden-b", ".DS_Store"]:
    open(name, "w").close()
for name in ["Çalışma Dosyası.txt", "résumé.pdf", "Ünlü Şarkı.mp3"]:
    open(unicodedata.normalize("NFD", name), "w").close()
for link, target in [("link-to-folder", "Folder 0"), ("broken-link", "nope"), ("loop", "loop")]:
    if not os.path.lexists(link):
        os.symlink(target, link)
PY
echo "created $(ls -A | wc -l | tr -d ' ') entries in $dir"
