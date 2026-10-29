/** Names checksum lists usually have: `x.iso.sha256`, `SHA256SUMS`, `checksums.txt`, … */
const LIST =
  /(\.(md5|sha1|sha256|sha512)(sums?)?|^(md5|sha1|sha256|sha512)sums(\.txt)?|^checksums?(\.txt)?)$/i;

export function isChecksumList(name: string): boolean {
  return LIST.test(name);
}
