import {
  cp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generated = path.join(root, "experiments/workpool/generated");
// The Convex CLI looks for tsc in the app's own node_modules directory.
await symlink(
  "../../node_modules",
  path.join(root, "experiments/workpool/node_modules"),
  "dir",
).catch(async (error) => {
  if (error.code !== "EEXIST") throw error;
  if (
    (await realpath(path.join(root, "experiments/workpool/node_modules"))) !==
    (await realpath(path.join(root, "node_modules")))
  ) {
    throw new Error(
      "The benchmark's node_modules must link to the repository's node_modules",
    );
  }
});
const modes = [
  "baseline",
  "prFiltered",
  "filtered",
  "transactional",
  "allMutations",
];

// Generate real workflow components from this checkout, so the experiment does
// not need a maintained fork or change the library's shipped implementation.
await rm(generated, { recursive: true, force: true });
for (const mode of modes) {
  const dest = path.join(generated, mode);
  await mkdir(dest, { recursive: true });
  await cp(path.join(root, "src"), dest, {
    recursive: true,
    filter: (file) => !file.endsWith(".test.ts") && !file.endsWith("/test.ts"),
  });
  if (!["baseline", "filtered"].includes(mode)) {
    // Swap the runtime implementation and its component API. Keep the library's
    // existing public result validators/types fixed across all variants.
    for (const name of ["pool.ts", "convex.config.ts", "_generated/api.ts"]) {
      const file = path.join(dest, "component", name);
      const source = await readFile(file, "utf8");
      await writeFile(
        file,
        source.replaceAll(
          "@convex-dev/workpool",
          "@convex-dev/workpool-transactional",
        ),
      );
    }
  }
  for (const name of ["pool.ts", "workflow.ts"]) {
    const file = path.join(dest, "component", name);
    const source = await readFile(file, "utf8");
    const needle = 'onCompleteExcludeKinds: ["success"],';
    const expected = name === "pool.ts" ? 1 : 2;
    if (source.split(needle).length - 1 !== expected)
      throw new Error(`Update benchmark transform for ${name}`);
    // The base PR already excludes ignored success callbacks. Undo only that
    // option for the released control; preserve it for every other variant.
    const transformed =
      mode === "baseline"
        ? source.replaceAll(needle, "")
        : ["transactional", "allMutations"].includes(mode)
          ? source.replaceAll(
              needle,
              `${needle} completeTransactionally: true,`,
            )
          : source;
    await writeFile(file, transformed);
  }
  if (mode === "allMutations") {
    const file = path.join(dest, "component/journal.ts");
    const source = await readFile(file, "utf8");
    // Locate only the mutation case. Query/action success callbacks must remain.
    const start = source.indexOf("workId = await workpool.enqueueMutation(");
    const end = source.indexOf("break;", start);
    if (start < 0 || end < 0)
      throw new Error("Update benchmark journal transform");
    const section = source.slice(start, end);
    if (!section.includes("{ context, onComplete, name, ...schedulerOptions }"))
      throw new Error("Update benchmark mutation enqueue options transform");
    await writeFile(
      file,
      source.slice(0, start) +
        section.replace(
          "{ context, onComplete, name, ...schedulerOptions }",
          "{ context, onComplete, name, ...schedulerOptions, completeTransactionally: true }",
        ) +
        source.slice(end),
    );
  }
  await writeFile(
    path.join(dest, "component/tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../../convex/tsconfig.json",
        include: ["../**/*.ts"],
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(`Prepared ${modes.length} workflow variants in ${generated}`);
