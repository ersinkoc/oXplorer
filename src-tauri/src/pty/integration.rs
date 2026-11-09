//! zsh shell integration: reports the working directory with OSC 7 after every
//! command, so the file pane can follow `cd`. macOS only sets this up inside
//! Apple's Terminal, so we do it ourselves (the approach VS Code uses): zsh is
//! started with `ZDOTDIR` pointing at these files, each of which sources the
//! user's own file of the same name first.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The user's dotfile directory is passed in `OX_USER_ZDOTDIR`.
const SOURCE_USER: &str = r#"__ox_int="$ZDOTDIR"
ZDOTDIR="${OX_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/FILE" ]] && builtin source "$ZDOTDIR/FILE"
# The user's .zshenv may move their dotfiles elsewhere.
OX_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__ox_int"
unset __ox_int
"#;

/// macOS's /etc/zshrc (read just before `.zshrc`) sets `HISTFILE` from
/// `ZDOTDIR`, which still points here: the history goes back to the user's file.
const ZSHRC_HISTORY: &str = r#"[[ "$HISTFILE" == "$__ox_int/.zsh_history" ]] && HISTFILE="$ZDOTDIR/.zsh_history"
"#;

/// Every byte but letters, digits and `/._~-` is percent-encoded: a control
/// character in a folder name must not end the report or reach the terminal.
const ZSHRC_HOOK: &str = r#"
__ox_report_cwd() {
  emulate -L zsh
  setopt extended_glob no_multibyte
  local p="${PWD//(#m)[^A-Za-z0-9\/._~-]/%${(l:2::0:)$(( [##16] #MATCH ))}}"
  builtin printf '\e]7;file://%s%s\a' "${HOST}" "$p"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __ox_report_cwd
# Interactive non-login shells end here: hand ZDOTDIR back to the user.
[[ -o login ]] || ZDOTDIR="${OX_USER_ZDOTDIR:-$HOME}"
"#;

/// Login shells read `.zlogin` last; after it, ZDOTDIR is the user's again.
const ZLOGIN_TAIL: &str = "ZDOTDIR=\"${OX_USER_ZDOTDIR:-$HOME}\"\nunset OX_USER_ZDOTDIR\n";

fn script(file: &str) -> String {
    let mut s = SOURCE_USER.replace("FILE", file);
    if file == ".zshrc" {
        let at = s.find("[[ -f").unwrap_or(0);
        s.insert_str(at, ZSHRC_HISTORY);
    }
    match file {
        ".zshrc" => s.push_str(ZSHRC_HOOK),
        ".zlogin" => s.push_str(ZLOGIN_TAIL),
        _ => {}
    }
    s
}

/// Writes the integration files under `base` and returns their directory.
pub fn install_zsh(base: &Path) -> io::Result<PathBuf> {
    let dir = base.join("shell-integration").join("zsh");
    fs::create_dir_all(&dir)?;
    for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
        let path = dir.join(file);
        let body = script(file);
        if fs::read_to_string(&path).ok().as_deref() != Some(body.as_str()) {
            fs::write(&path, body)?;
        }
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_file_sources_the_users_own() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = install_zsh(tmp.path()).unwrap();
        for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let body = fs::read_to_string(dir.join(file)).unwrap();
            assert!(body.contains(&format!("source \"$ZDOTDIR/{file}\"")), "{file}");
        }
        assert!(fs::read_to_string(dir.join(".zshrc")).unwrap().contains("precmd __ox_report_cwd"));
    }

    /// Runs an interactive login zsh as the terminal starts it (HOME = `home`).
    fn zsh(home: &Path, integration: Option<&Path>, cwd: &Path, script: &str) -> Vec<u8> {
        let mut cmd = std::process::Command::new("/bin/zsh");
        cmd.args(["-l", "-i", "-c", script]).current_dir(cwd).env("HOME", home).env_remove("OX_USER_ZDOTDIR");
        cmd.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        match integration {
            Some(dir) => cmd.env("ZDOTDIR", dir),
            None => cmd.env_remove("ZDOTDIR"),
        };
        cmd.output().unwrap().stdout
    }

    #[test]
    fn the_history_stays_in_the_users_file() {
        let home = tempfile::tempdir().unwrap();
        let base = tempfile::tempdir().unwrap();
        let dir = install_zsh(base.path()).unwrap();
        let home_path = home.path();
        let print = "print -r -- $HISTFILE";
        // Control: zsh without the integration (macOS /etc/zshrc sets it).
        let plain = String::from_utf8(zsh(home_path, None, home_path, print)).unwrap();
        assert_eq!(plain.trim(), format!("{}/.zsh_history", home_path.display()));
        let ours = String::from_utf8(zsh(home_path, Some(&dir), home_path, print)).unwrap();
        assert_eq!(ours.trim(), plain.trim(), "history file inside the integration folder");
        // A HISTFILE the user sets stays theirs.
        fs::write(home_path.join(".zshrc"), "HISTFILE=~/custom_history\n").unwrap();
        let custom = String::from_utf8(zsh(home_path, Some(&dir), home_path, print)).unwrap();
        assert_eq!(custom.trim(), format!("{}/custom_history", home_path.display()));
        // Dotfiles in their own folder (the user's ZDOTDIR): the history goes there.
        fs::remove_file(home_path.join(".zshrc")).unwrap();
        let dots = home_path.join("dots");
        fs::create_dir(&dots).unwrap();
        let mut cmd = std::process::Command::new("/bin/zsh");
        cmd.args(["-l", "-i", "-c", print]).current_dir(home_path).env("HOME", home_path);
        cmd.env("ZDOTDIR", &dir).env("OX_USER_ZDOTDIR", &dots).stdin(std::process::Stdio::null());
        let out =
            String::from_utf8(cmd.stderr(std::process::Stdio::null()).output().unwrap().stdout).unwrap();
        assert_eq!(out.trim(), format!("{}/.zsh_history", dots.display()));
    }

    #[test]
    fn folder_names_never_end_the_cwd_report() {
        let home = tempfile::tempdir().unwrap();
        let base = tempfile::tempdir().unwrap();
        let dir = install_zsh(base.path()).unwrap();
        // Control: an ordinary name with a space and a percent sign.
        let plain = home.path().join("a b%c");
        fs::create_dir(&plain).unwrap();
        let out = zsh(home.path(), Some(&dir), &plain, "__ox_report_cwd");
        let text = String::from_utf8_lossy(&out);
        assert!(text.ends_with("/a%20b%25c\x07"), "{text:?}");

        let evil = home.path().join("x\x07\x1b[6n");
        fs::create_dir(&evil).unwrap();
        let out = zsh(home.path(), Some(&dir), &evil, "__ox_report_cwd");
        let bells = out.iter().filter(|&&b| b == 0x07).count();
        let escapes = out.iter().filter(|&&b| b == 0x1b).count();
        assert_eq!((bells, escapes), (1, 1), "raw control characters in {:?}", String::from_utf8_lossy(&out));
        assert!(
            String::from_utf8_lossy(&out).ends_with("/x%07%1B%5B6n\x07"),
            "{:?}",
            String::from_utf8_lossy(&out)
        );
        // Letters outside ASCII go as their UTF-8 bytes (decodeURIComponent reads them).
        let turkish = home.path().join("Görüntü ı");
        fs::create_dir(&turkish).unwrap();
        let out = zsh(home.path(), Some(&dir), &turkish, "__ox_report_cwd");
        assert!(String::from_utf8_lossy(&out).ends_with("/G%C3%B6r%C3%BCnt%C3%BC%20%C4%B1\x07"));
    }
}
