/**
 * The pane command is assembled in TypeScript and handed to tmux, which runs it
 * through the user's default shell. If quoting is wrong a path with a space is split,
 * a `$` in a key is expanded, and a peer starts with the wrong arguments — silently.
 *
 * So the proof is a round trip through the real shells on this machine: build a word
 * with shellQuote, let bash/zsh parse it, and demand the same argv back. The golden
 * cases below pin the bytes against bash's own `printf '%q'` for the values the fleet
 * actually quotes (session names, state paths, model ids, flags, roles).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

import { shellQuote } from "../../src/domain/shell-quote.ts";

/** Values the fleet really puts on a pane command, plus the shapes that break naive quoting. */
const CORPUS: readonly string[] = [
  // what the fleet quotes today
  "",
  "engineer",
  "fleet-a-engineer-1",
  "=fleet-a-engineer:",
  "/Users/ada/.fleet-state/backlog-mcp.json",
  "/Users/ada Lovelace/.fleet-state/a",
  "openrouter/test-model",
  "vendor/Test-Model",
  "claude",
  "opencode",
  "--model",
  "/fleet engineer",
  "Ada Lovelace",
  "none",
  // shell metacharacters
  "a b",
  "a  b",
  "it's",
  'say "hi"',
  "back\\slash",
  'a\'b"c',
  "*.md",
  "a?b",
  "[x]",
  "{a,b}",
  "$HOME",
  "${HOME}",
  "$(id)",
  "`id`",
  "a&b",
  "a|b",
  "a;b",
  "a<b",
  "a>b",
  "(x)",
  "a#b",
  "#1",
  "~/x",
  "~",
  "!x",
  " leading",
  "trailing ",
  "\u00e9",
  "\u65e5\u672c\u8a9e",
  // control characters take the $'…' path
  "a\tb",
  "x\ty\rz",
  "\u001b[0m",
  "\u0001",
];

const shells = ["bash", "zsh"].filter((shell) => spawnSync(shell, ["-c", "exit 0"]).status === 0);

/** Word-split `value` exactly as `shell` would, and return the argv it produced. */
function argvAfterShellParses(shell: string, value: string): string[] {
  const script = `set -- ${shellQuote(value)}; printf '%s\\0' "$@"`;
  const result = spawnSync(shell, ["-c", script], { encoding: "buffer" });
  assert.equal(result.status, 0, `${shell} rejected the quoted word for ${JSON.stringify(value)}: ${result.stderr.toString()}`);
  const text = result.stdout.toString();
  return text.split("\0").slice(0, -1);
}

describe("shellQuote", () => {
  for (const shell of shells) {
    test(`round-trips through ${shell}`, () => {
      for (const value of CORPUS) {
        assert.deepEqual(argvAfterShellParses(shell, value), [value], `${shell} did not see ${JSON.stringify(value)} again`);
      }
    });

    test(`keeps separate values separate in ${shell}`, () => {
      // The real use: one command built from several values. A missing quote would
      // merge neighbours, so check the whole argv, not each word alone.
      const values = ["/tmp/a b", "", "*.md", "$HOME", "fleet-a-engineer"];
      const script = `set -- ${values.map(shellQuote).join(" ")}; printf '%s\\0' "$@"`;
      const result = spawnSync(shell, ["-c", script], { encoding: "buffer" });
      assert.equal(result.status, 0, result.stderr.toString());
      assert.deepEqual(result.stdout.toString().split("\0").slice(0, -1), values);
    });
  }

  test("matches bash's own printf %q for the values the fleet quotes", () => {
    // Byte parity on the ordinary surface keeps this port honest: same pane command,
    // same log line, same shell behaviour as the script it replaces.
    const golden: ReadonlyArray<readonly [string, string]> = [
      ["", "''"],
      ["engineer", "engineer"],
      // bash has no `=cmd` expansion so its %q leaves this bare; zsh does, so we escape it.
      ["=fleet-a-engineer:", "\\=fleet-a-engineer:"],
      ["openrouter/test-model", "openrouter/test-model"],
      ["Ada Lovelace", "Ada\\ Lovelace"],
      ["/fleet engineer", "/fleet\\ engineer"],
      ["a b", "a\\ b"],
      ["it's", "it\\'s"],
      ['say "hi"', 'say\\ \\"hi\\"'],
      ["back\\slash", "back\\\\slash"],
      ["*.md", "\\*.md"],
      ["a?b", "a\\?b"],
      ["[x]", "\\[x\\]"],
      ["$HOME", "\\$HOME"],
      ["`id`", "\\`id\\`"],
      ["a&b", "a\\&b"],
      ["a|b", "a\\|b"],
      ["a;b", "a\\;b"],
      ["(x)", "\\(x\\)"],
      ["~/x", "\\~/x"],
      ["a\tb", "$'a\\tb'"],
    ];

    for (const [value, expected] of golden) {
      assert.equal(shellQuote(value), expected, `quoting ${JSON.stringify(value)}`);
    }

    if (!shells.includes("bash")) return;
    // And once more against the real thing, so the table above cannot go stale.
    // Two values are quoted more strictly than bash would, on purpose:
    const stricterThanBash = new Map([
      ["a\tb", "bash drops to backslashes for every run but the control one; both forms round-trip"],
      ["=fleet-a-engineer:", "zsh reads a leading = as a command path, so it has to be escaped"],
    ]);
    for (const [value] of golden) {
      const result = spawnSync("bash", ["-c", 'printf %q "$1"', "_", value], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      if (stricterThanBash.has(value)) continue;
      assert.equal(shellQuote(value), result.stdout, `bash prints ${JSON.stringify(result.stdout)} for ${JSON.stringify(value)}`);
    }
  });
});
