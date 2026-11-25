import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

export async function getWorkflow(
  ctx: QueryCtx,
  workflowId: Id<"workflows">,
  expectedGenerationNumber: number,
) {
  const workflow = await ctx.db.get("workflows", workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  if (workflow.generationNumber !== expectedGenerationNumber) {
    throw new Error(
      `Invalid generation number: ${expectedGenerationNumber} for workflow ${workflow.name} (${workflowId})`,
    );
  }
  return workflow;
}

export async function deleteWebhook(
  ctx: MutationCtx,
  webhook: Doc<"webhookCallbacks">,
) {
  for (const id of [webhook.bodyStorageId, webhook.headersStorageId]) {
    if (id) await ctx.storage.delete(id);
  }
  await ctx.db.delete("webhookCallbacks", webhook._id);
}
