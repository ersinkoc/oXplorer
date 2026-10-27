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

const ZSHRC_HOOK: &str = r#"
__ox_report_cwd() {
  local p="${PWD//\%/%25}"
  p="${p// /%20}"
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
}
