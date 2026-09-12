import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";
import workpoolPr from "@convex-dev/workpool-transactional/convex.config";
import baseline from "../generated/baseline/component/convex.config.js";
import prFiltered from "../generated/prFiltered/component/convex.config.js";
import filtered from "../generated/filtered/component/convex.config.js";
import transactional from "../generated/transactional/component/convex.config.js";
import allMutations from "../generated/allMutations/component/convex.config.js";

const app = defineApp();
app.use(workpool, { name: "poolBaseline" });
app.use(workpoolPr, { name: "poolPr" });
app.use(baseline, { name: "baseline" });
app.use(prFiltered, { name: "prFiltered" });
app.use(filtered, { name: "filtered" });
app.use(transactional, { name: "transactional" });
app.use(allMutations, { name: "allMutations" });
export default app;
