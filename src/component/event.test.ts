import { afterEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

afterEach(() => vi.unstubAllEnvs());

test.each([
  "https://example.convex.site/workflow",
  "https://example.convex.site/workflow/",
  "https://example.convex.site",
  "https://example.convex.site/",
])("webhook URL preserves the mount path for %s", async (siteUrl) => {
  vi.stubEnv("CONVEX_SITE_URL", siteUrl);
  const t = initConvexTest();
  const workflowId = await t.run((ctx) =>
    ctx.db.insert("workflows", {
      name: "webhook URL",
      workflowHandle: "function://;workflow.test:noop",
      args: {},
      generationNumber: 0,
    }),
  );
  const webhook = await t.mutation(api.event.createWebhook, {
    workflowId,
    name: "callback",
  });
  const url = new URL(webhook.url);
  expect(url.pathname).toBe(
    siteUrl.includes("/workflow") ? "/workflow/webhook" : "/webhook",
  );
  expect(url.searchParams.get("uuid")).toBe(webhook.uuid);
  // convex-test serves the component router directly, without its mount prefix.
  const response = await t.fetch(`/webhook?${url.searchParams}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "succeeded" }),
  });
  expect(response.status).toBe(200);
  const event = await t.run((ctx) => ctx.db.get("events", webhook.eventId));
  expect(event?.state).toMatchObject({
    kind: "sent",
    result: {
      kind: "success",
      returnValue: { body: { status: "succeeded" } },
    },
  });
  const duplicate = await t.fetch(`/webhook?${url.searchParams}`, {
    method: "POST",
    body: "duplicate",
  });
  expect(await duplicate.json()).toMatchObject({ alreadyProcessed: true });
});
