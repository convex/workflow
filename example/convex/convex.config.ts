import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";

const app = defineApp();
app.use(workflow, { httpPrefix: "/workflow/" });
export default app;
