import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
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

async function setupWebhook() {
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site/workflow/");
  const t = initConvexTest();
  const workflowId = await t.run((ctx) =>
    ctx.db.insert("workflows", {
      workflowHandle: "function://;workflow.test:noop",
      args: {},
      generationNumber: 0,
    }),
  );
  const webhook = await t.mutation(api.event.createWebhook, {
    workflowId,
    name: "callback",
  });
  return { t, workflowId, webhook };
}

test("DELETE preserves its body and logs never include the bearer credential", async () => {
  const { t, webhook } = await setupWebhook();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await t.fetch(`/webhook?uuid=${webhook.uuid}`, {
            method: "DELETE",
            body: "deleted payload",
          })
        ).status,
      ).toBe(200);
    }
    const event = await t.run((ctx) => ctx.db.get("events", webhook.eventId));
    expect(event?.state).toMatchObject({
      kind: "sent",
      result: { returnValue: { body: "deleted payload" } },
    });
    expect(info.mock.calls.flat().join(" ")).not.toContain(webhook.uuid);
  } finally {
    info.mockRestore();
  }
});

test("concurrent callbacks succeed and deliver only one result", async () => {
  const { t, webhook } = await setupWebhook();
  const responses = await Promise.all(
    ["first", "second"].map((body) =>
      t.fetch(`/webhook?uuid=${webhook.uuid}`, { method: "POST", body }),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const results = await Promise.all(responses.map((r) => r.json()));
  expect(results.filter((r) => r.alreadyProcessed)).toHaveLength(1);
});

test("a timeout between lookup and completion wins without leaking the losing file", async () => {
  const { t, webhook } = await setupWebhook();
  expect(
    await t.query(internal.event.getWebhookByUuid, { uuid: webhook.uuid }),
  ).toMatchObject({ eventState: "created" });
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["late payload"])),
  );
  await t.mutation(internal.event.timeoutEvent, { eventId: webhook.eventId });
  expect(
    await t.mutation(internal.event.completeWebhook, {
      eventId: webhook.eventId,
      value: { bodyStorageId: storageId },
      bodyStorageId: storageId,
    }),
  ).toBe(false);
  expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
  const event = await t.run((ctx) => ctx.db.get("events", webhook.eventId));
  expect(event?.state).toMatchObject({
    kind: "sent",
    result: { kind: "failed", error: "Timeout" },
  });
});

test("spilled payloads can be retrieved and are removed with unawaited callbacks", async () => {
  vi.useFakeTimers();
  try {
    const { t, webhook, workflowId } = await setupWebhook();
    const body = JSON.stringify({ payload: "x".repeat(256 * 1024) });
    expect(
      (
        await t.fetch(`/webhook?uuid=${webhook.uuid}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
    ).toBe(200);
    const url = await t.query(api.event.getWebhookPayloadUrl, {
      eventId: webhook.eventId,
      field: "body",
    });
    expect(url).toEqual(expect.any(String));
    expect(
      await t.query(api.event.getWebhookPayloadUrl, {
        eventId: webhook.eventId,
        field: "headers",
      }),
    ).toBeNull();
    const callback = await t.query(internal.event.getWebhookByUuid, {
      uuid: webhook.uuid,
    });
    const storageId = callback!.bodyStorageId!;
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(storageId))!.text()),
    ).toBe(body);
    // Exercise continuation and callbacks never attached to a journal step.
    for (let i = 0; i < 65; i++) {
      await t.mutation(api.event.createWebhook, {
        workflowId,
        name: `unused-${i}`,
      });
    }
    await t.mutation(api.workflow.cleanup, { workflowId, force: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run((ctx) => ctx.db.query("webhookCallbacks").take(1)),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("events").take(1))).toEqual([]);
    expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
    expect(
      await t.query(api.event.getWebhookPayloadUrl, {
        eventId: webhook.eventId,
        field: "body",
      }),
    ).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("step cleanup deletes its callback and files immediately", async () => {
  const { t, workflowId, webhook } = await setupWebhook();
  await t.fetch(`/webhook?uuid=${webhook.uuid}`, {
    method: "POST",
    body: "x".repeat(256 * 1024 + 1),
  });
  await t.mutation(api.journal.startSteps, {
    workflowId,
    generationNumber: 0,
    steps: [
      {
        step: {
          kind: "event",
          name: "callback",
          inProgress: true,
          argsSize: 0,
          args: { eventId: webhook.eventId },
          startedAt: Date.now(),
        },
      },
    ],
  });
  const callback = await t.query(internal.event.getWebhookByUuid, {
    uuid: webhook.uuid,
  });
  expect(callback?.eventState).toBe("consumed");
  await t.mutation(internal.workflow.cleanupContinue, {
    workflowId,
    fromStepNumber: 0,
  });
  expect(
    await t.query(internal.event.getWebhookByUuid, { uuid: webhook.uuid }),
  ).toBeNull();
  expect(
    await t.run((ctx) => ctx.storage.get(callback!.bodyStorageId!)),
  ).toBeNull();
});
