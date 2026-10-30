/** Names checksum lists usually have: `x.iso.sha256`, `SHA256SUMS`, `checksums.txt`, … */
const LIST =
  /(\.(md5|sha1|sha256|sha512)(sums?)?|^(md5|sha1|sha256|sha512)sums(\.txt)?|^checksums?(\.txt)?)$/i;

export function isChecksumList(name: string): boolean {
  return LIST.test(name);
}

export type ChecksumAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

/** The name Create Checksum File picks (before a free variant): `SHA256SUMS`, or `x.iso.sha256` for one file. */
export function checksumListName(algorithm: ChecksumAlgorithm, names: readonly string[]): string {
  const [only] = names;
  return names.length === 1 && only ? `${only}.${algorithm}` : `${algorithm.toUpperCase()}SUMS`;
}
