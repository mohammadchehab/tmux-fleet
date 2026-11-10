/**
 * The spellings the worktree inventory prints: sizes, ages, topics.
 *
 * These are frozen output (§4): `fleet wt ls`, `fleet wt summary` and the prune report
 * are grepped by the shell tests, so "4.1G", "12M", "3d" and the topic slug have to come
 * out byte for byte as the scripts printed them.
 */

/** Kilobyte count as the inventory shows it: 4.1G / 1024M / 512K, or "-" when not measured. */
export function humanSize(sizeKb: number | null): string {
  if (sizeKb === null) return "-";
  if (sizeKb >= 1_048_576) return `${(sizeKb / 1_048_576).toFixed(1)}G`;
  if (sizeKb >= 1_024) return `${Math.trunc(sizeKb / 1_024)}M`;
  return `${sizeKb}K`;
}

/** Epoch seconds as an age: 3d / 5h / 12m, or "-" when the time is unknown. */
export function humanAge(lastChange: number, now: number): string {
  if (lastChange === 0) return "-";
  const seconds = now - lastChange;
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 60)}m`;
}

/**
 * A branch name as the folder name of its worktree: every byte outside A-Za-z0-9._-
 * becomes "-". Byte-wise, like `tr`, so one non-ASCII character becomes several dashes
 * rather than one.
 */
export function slugifyTopic(branch: string): string {
  const bytes = new TextEncoder().encode(branch);
  let out = "";
  for (const byte of bytes) {
    const safe =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x2d; // -
    out += safe ? String.fromCharCode(byte) : "-";
  }
  return out;
}
