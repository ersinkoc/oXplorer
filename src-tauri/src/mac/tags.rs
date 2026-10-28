use std::io::Cursor;
use std::path::Path;

use crate::model::FinderTag;

const USER_TAGS: &str = "com.apple.metadata:_kMDItemUserTags";

/// Reads Finder tags without following symlinks. Missing/garbled attributes mean "no tags".
pub fn read_tags(path: &Path) -> Vec<FinderTag> {
    match xattr::get(path, USER_TAGS) {
        Ok(Some(raw)) => parse_tags(&raw),
        _ => Vec::new(),
    }
}

/// Replaces the tags of `path`. Finder reads only this attribute on current
/// macOS; an empty list removes it.
pub fn write_tags(path: &Path, tags: &[FinderTag]) -> std::io::Result<()> {
    if tags.is_empty() {
        return match xattr::remove(path, USER_TAGS) {
            Err(e) if e.raw_os_error() == Some(libc::ENOATTR) => Ok(()),
            other => other,
        };
    }
    let value = plist::Value::Array(
        tags.iter()
            .map(|t| {
                plist::Value::String(if t.color == 0 {
                    t.name.clone()
                } else {
                    format!("{}\n{}", t.name, t.color)
                })
            })
            .collect(),
    );
    let mut buf = Vec::new();
    value.to_writer_binary(&mut buf).map_err(std::io::Error::other)?;
    xattr::set(path, USER_TAGS, &buf)
}

/// Adds and removes tags (by name) on one item, keeping its other tags in order.
pub fn edit_tags(path: &Path, add: &[FinderTag], remove: &[String]) -> std::io::Result<()> {
    let mut tags: Vec<FinderTag> =
        read_tags(path).into_iter().filter(|t| !remove.contains(&t.name)).collect();
    for t in add {
        if !tags.iter().any(|x| x.name == t.name) {
            tags.push(t.clone());
        }
    }
    write_tags(path, &tags)
}

/// Colors of Finder's built-in tags, by the names Finder gives them.
const BUILTIN_COLORS: &[(&str, u8)] = &[
    ("Gray", 1),
    ("Grey", 1),
    ("Green", 2),
    ("Purple", 3),
    ("Blue", 4),
    ("Yellow", 5),
    ("Red", 6),
    ("Orange", 7),
    ("Gri", 1),
    ("Yeşil", 2),
    ("Mor", 3),
    ("Mavi", 4),
    ("Sarı", 5),
    ("Kırmızı", 6),
    ("Turuncu", 7),
];

/// The tags Finder lists in its sidebar (`FavoriteTagNames` in Finder's
/// preferences), falling back to the seven color tags.
pub fn favorite_tags() -> Vec<FinderTag> {
    let names: Vec<String> = dirs::home_dir()
        .map(|h| h.join("Library/Preferences/com.apple.finder.plist"))
        .and_then(|p| plist::Value::from_file(p).ok())
        .and_then(plist::Value::into_dictionary)
        .and_then(|mut d| d.remove("FavoriteTagNames"))
        .and_then(plist::Value::into_array)
        .map(|a| a.into_iter().filter_map(plist::Value::into_string).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let names = if names.is_empty() {
        ["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"].map(str::to_owned).to_vec()
    } else {
        names
    };
    names
        .into_iter()
        .map(|name| {
            let color = BUILTIN_COLORS.iter().find(|(n, _)| *n == name).map_or(0, |(_, c)| *c);
            FinderTag { name, color }
        })
        .collect()
}

/// The attribute is a binary plist array of strings like `"Red\n6"`; the color
/// suffix is absent for tags without a color.
fn parse_tags(raw: &[u8]) -> Vec<FinderTag> {
    let Ok(plist::Value::Array(items)) = plist::Value::from_reader(Cursor::new(raw)) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| v.as_string())
        .map(|s| match s.rsplit_once('\n') {
            Some((name, color)) => FinderTag {
                name: name.to_owned(),
                color: color.parse().ok().filter(|c| *c <= 7).unwrap_or(0),
            },
            None => FinderTag { name: s.to_owned(), color: 0 },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(tags: &[&str]) -> Vec<u8> {
        let value = plist::Value::Array(tags.iter().map(|t| plist::Value::String((*t).to_owned())).collect());
        let mut buf = Vec::new();
        value.to_writer_binary(&mut buf).unwrap();
        buf
    }

    #[test]
    fn edits_round_trip_through_the_attribute() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("f");
        std::fs::write(&f, "").unwrap();
        let red = FinderTag { name: "Red".into(), color: 6 };
        let work = FinderTag { name: "Work".into(), color: 0 };
        edit_tags(&f, &[red.clone(), work.clone()], &[]).unwrap();
        assert_eq!(read_tags(&f), vec![red.clone(), work.clone()]);
        edit_tags(&f, std::slice::from_ref(&red), &["Work".into()]).unwrap();
        assert_eq!(read_tags(&f), vec![red]);
        edit_tags(&f, &[], &["Red".into()]).unwrap();
        assert!(read_tags(&f).is_empty());
        assert!(xattr::get(&f, USER_TAGS).unwrap().is_none());
    }

    #[test]
    fn parses_names_and_colors() {
        let tags = parse_tags(&encode(&["Red\n6", "Work", "Odd\n99"]));
        assert_eq!(
            tags,
            vec![
                FinderTag { name: "Red".into(), color: 6 },
                FinderTag { name: "Work".into(), color: 0 },
                FinderTag { name: "Odd".into(), color: 0 },
            ]
        );
        assert!(parse_tags(b"garbage").is_empty());
    }

    #[test]
    fn round_trips_through_xattr() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        assert!(read_tags(tmp.path()).is_empty());
        xattr::set(tmp.path(), USER_TAGS, &encode(&["Blue\n4"])).unwrap();
        assert_eq!(read_tags(tmp.path()), vec![FinderTag { name: "Blue".into(), color: 4 }]);
    }
}
