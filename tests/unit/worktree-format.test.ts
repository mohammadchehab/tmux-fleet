import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { humanAge, humanSize, slugifyTopic } from "../../src/domain/worktree/format.ts";

describe("humanSize", () => {
  test("gigabytes carry one decimal", () => {
    assert.equal(humanSize(4_302_899), "4.1G");
    assert.equal(humanSize(1_048_576), "1.0G");
  });

  test("megabytes are whole and truncate", () => {
    assert.equal(humanSize(1_024), "1M");
    assert.equal(humanSize(1_535), "1M");
    assert.equal(humanSize(1_048_575), "1023M");
  });

  test("kilobytes stay kilobytes", () => {
    assert.equal(humanSize(1_023), "1023K");
    assert.equal(humanSize(0), "0K");
  });

  test("an unmeasured size prints a dash", () => {
    assert.equal(humanSize(null), "-");
  });
});

describe("humanAge", () => {
  const now = 1_700_000_000;

  test("days, hours and minutes round down", () => {
    assert.equal(humanAge(now - 3 * 86_400 - 3600, now), "3d");
    assert.equal(humanAge(now - 5 * 3_600 - 60, now), "5h");
    assert.equal(humanAge(now - 12 * 60, now), "12m");
  });

  test("under a minute is 0m, and an unknown time is a dash", () => {
    assert.equal(humanAge(now - 30, now), "0m");
    assert.equal(humanAge(0, now), "-");
  });
});

describe("slugifyTopic", () => {
  test("keeps the characters a folder name may hold", () => {
    assert.equal(slugifyTopic("feature/x-1_2.3"), "feature-x-1_2.3");
  });

  test("turns everything else into a dash", () => {
    assert.equal(slugifyTopic("Fleet: worktrees!"), "Fleet--worktrees-");
  });

  test("works byte-wise, like tr", () => {
    // "é" is two UTF-8 bytes, so it becomes two dashes, not one.
    assert.equal(slugifyTopic("café"), "caf--");
  });

  test("an empty branch name stays empty", () => {
    assert.equal(slugifyTopic(""), "");
  });
});
