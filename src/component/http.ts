import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";

const MAX_INLINE_SIZE = 256 * 1024; // 256KB
const SUPPORTED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const METHODS_WITH_BODY = new Set<string>(["POST", "PUT", "PATCH"]);

const http = httpRouter();

const handleWebhook = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const uuid = url.searchParams.get("uuid");
  if (!uuid) {
    return new Response("Missing uuid query parameter", { status: 400 });
  }

  const webhook = await ctx.runQuery(internal.event.getWebhookByUuid, {
    uuid,
  });
  if (!webhook) {
    return new Response("Webhook not found", { status: 404 });
  }

  if (webhook.eventState === "sent" || webhook.eventState === "consumed") {
    console.info(
      `Webhook for event ${webhook.eventId} already processed (state: ${webhook.eventState}, uuid: ${uuid})`,
    );
    return new Response(JSON.stringify({ ok: true, alreadyProcessed: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { settings } = webhook;
  const eventValue: Record<string, unknown> = {};

  if (settings.headers !== "discard") {
    const rawHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      rawHeaders[key] = value;
    });
    await processField(
      ctx,
      eventValue,
      "headers",
      rawHeaders,
      JSON.stringify(rawHeaders),
    );
  }

  if (settings.body !== "discard") {
    if (METHODS_WITH_BODY.has(req.method)) {
      const bodyText = await req.text();
      const contentType = req.headers.get("content-type") ?? "";
      let bodyValue: unknown;
      if (contentType.includes("application/json")) {
        try {
          bodyValue = JSON.parse(bodyText);
        } catch {
          bodyValue = bodyText;
        }
      } else {
        bodyValue = bodyText;
      }
      await processField(ctx, eventValue, "body", bodyValue, bodyText);
    } else {
      eventValue.body = null;
    }
  }

  console.info(
    `Webhook ${req.method} received for event ${webhook.eventId} (uuid: ${uuid})`,
  );

  await ctx.runMutation(api.event.send, {
    eventId: webhook.eventId,
    result: { kind: "success", returnValue: eventValue },
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

for (const method of SUPPORTED_METHODS) {
  http.route({ path: "/webhook", method, handler: handleWebhook });
}

async function processField(
  ctx: ActionCtx,
  eventValue: Record<string, unknown>,
  fieldName: string,
  value: unknown,
  serialized: string,
) {
  const size = new Blob([serialized]).size;
  if (size > MAX_INLINE_SIZE) {
    const blob = new Blob([serialized], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);
    eventValue[fieldName + "StorageId"] = storageId;
    console.debug(
      `${fieldName} exceeds ${MAX_INLINE_SIZE} bytes (${size}), stored in file storage: ${storageId}`,
    );
  } else {
    eventValue[fieldName] = value;
  }
}

export default http;
