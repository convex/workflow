import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Preserve the root project's Node version when changing directories.
const cwd = fileURLToPath(new URL("./", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../node_modules/convex/bin/main.js", import.meta.url),
    ),
    ...process.argv.slice(2),
  ],
  { cwd, stdio: "inherit" },
);
process.exit(result.status ?? 1);
