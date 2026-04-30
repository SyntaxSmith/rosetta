import os from "node:os";
import path from "node:path";

let homeOverride: string | null = null;

/**
 * Test-only hook so vitest workers can isolate state without touching env.
 */
export function setHomeOverrideForTest(dir: string | null): void {
  homeOverride = dir;
}

/**
 * Cross-platform application home directory for rosetta.
 *
 * We use `~/.rosetta/` on all three platforms (Linux/macOS/Windows) for
 * symmetry — matches the `~/.oracle/` convention this project descends from.
 * `ROSETTA_HOME_DIR` env var takes precedence for users who want to relocate.
 */
export function getRosettaHomeDir(): string {
  return (
    homeOverride ?? process.env.ROSETTA_HOME_DIR ?? path.join(os.homedir(), ".rosetta")
  );
}
