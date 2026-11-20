import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";
import { internal } from "./_generated/api.js";

const component = defineComponent("workflow", { init: internal.init.init });

component.use(workpool, {
  args: {
    maxParallelism: component.args.maxParallelism,
    logLevel: component.args.logLevel,
  },
});

export default component;
