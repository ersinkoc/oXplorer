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
