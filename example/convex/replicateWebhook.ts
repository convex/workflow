import { v } from "convex/values";
import {
  createWebhookEvent,
  vWorkflowId,
  type EventId,
  type WebhookEvent,
  type WorkflowId,
} from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { workflow } from "./example";

const replicateResultValidator = v.object({
  body: v.object({
    id: v.string(),
    status: v.string(),
    output: v.optional(v.union(v.array(v.string()), v.string(), v.null())),
    error: v.optional(v.union(v.string(), v.null())),
  }),
});

export const createReplicateWebhook = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args): Promise<WebhookEvent> => {
    return await createWebhookEvent(ctx, components.workflow, {
      name: "replicate-prediction",
      workflowId: args.workflowId,
      timeoutMs: 5 * 60 * 1000,
    });
  },
});

export const startReplicatePrediction = internalAction({
  args: { prompt: v.string(), webhookUrl: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    if (!process.env.REPLICATE_API_TOKEN) {
      throw new Error(
        "REPLICATE_API_TOKEN not set. npx convex env set REPLICATE_API_TOKEN r8_****",
      );
    }
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version:
          "ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4",
        input: { prompt: args.prompt },
        webhook: args.webhookUrl,
        webhook_events_filter: ["completed"],
      }),
    });
    if (!res.ok) {
      throw new Error(`Replicate ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  },
});

export const generateImage = workflow
  .define({
    args: { prompt: v.string() },
    returns: v.object({ imageUrl: v.string() }),
  })
  .handler(async (step, args) => {
    const webhook = await step.runMutation(
      internal.replicateWebhook.createReplicateWebhook,
      { workflowId: step.workflowId },
    );
    await step.runAction(internal.replicateWebhook.startReplicatePrediction, {
      prompt: args.prompt,
      webhookUrl: webhook.url,
    });
    const result = await step.awaitEvent({
      id: webhook.eventId as EventId,
      validator: replicateResultValidator,
    });
    if (result.body.status !== "succeeded") {
      throw new Error(
        `Replicate failed: ${result.body.error ?? result.body.status}`,
      );
    }
    const output = result.body.output;
    const imageUrl = Array.isArray(output) ? output[0] : output;
    if (!imageUrl) throw new Error("Replicate returned no output");
    return { imageUrl };
  });

export const start = internalMutation({
  args: { prompt: v.string() },
  handler: async (ctx, args): Promise<WorkflowId> => {
    return await workflow.start(ctx, internal.replicateWebhook.generateImage, {
      prompt: args.prompt,
    });
  },
});
