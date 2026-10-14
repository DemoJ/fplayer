import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  }).sort();
}

const dataDir = mkdtempSync(path.join(tmpdir(), "fplayer-tests-"));
try {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles(path.join(root, "server")), ...testFiles(path.join(root, "src"))], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
