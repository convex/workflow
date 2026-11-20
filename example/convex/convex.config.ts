import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";

const app = defineApp();
// Both args are passed because forwarding an optional arg the app omits is an
// error until convex/convex#62122.
app.use(workflow, { args: { maxParallelism: 20, logLevel: "WARN" } });
export default app;
