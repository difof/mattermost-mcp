import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { readSecretFile } from "../service/secret.js";
import { notificationTemplate } from "./templates.js";

const sessionId = /^ses_[A-Za-z0-9]{1,100}$/;
const loopback = (u) => ["127.0.0.1", "[::1]"].includes(u.hostname);
function endpoint(raw) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("Invalid callback URL");
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(u.protocol === "https:" || (u.protocol === "http:" && loopback(u)))
  )
    throw new Error(
      "Callbacks require HTTPS or loopback HTTP without credentials, query or fragment",
    );
  return u;
}
const basic = (value) => "Basic " + Buffer.from("opencode:" + value).toString("base64");

/** Only operators grant callback destinations and credentials. Never follow redirects. */
export function callbackTargets(env = process.env) {
  const hooks = new Map(),
    secretFiles = new Set();
  if (env.MM_CALLBACK_TARGETS_FILE) {
    const entries = JSON.parse(readSecretFile(env.MM_CALLBACK_TARGETS_FILE));
    if (!Array.isArray(entries)) throw new Error("Callback targets must be a JSON array");
    for (const { url, bearer_file: file, receipt = false, template } of entries) {
      const key = endpoint(url).href;
      if (hooks.has(key)) throw new Error("Duplicate callback destination");
      const secret = file && isAbsolute(file) ? readSecretFile(file) : null;
      if (
        (file && (!secret || /[\r\n]/.test(secret))) ||
        typeof receipt !== "boolean" ||
        (receipt && !secret)
      )
        throw new Error("Invalid callback bearer or receipt configuration");
      if (file) secretFiles.add(file);
      hooks.set(key, {
        kind: "webhook",
        url: key,
        headers: secret ? { authorization: "Bearer " + secret } : {},
        receipt,
        template: notificationTemplate(template),
      });
    }
  }
  let oc;
  if (env.MM_OPENCODE_URL || env.MM_OPENCODE_PASSWORD_FILE) {
    const u = endpoint(env.MM_OPENCODE_URL);
    if (
      !loopback(u) ||
      u.protocol !== "http:" ||
      u.pathname !== "/" ||
      !env.MM_OPENCODE_PASSWORD_FILE
    )
      throw new Error("Configure OpenCode with its loopback HTTP origin and private password file");
    secretFiles.add(env.MM_OPENCODE_PASSWORD_FILE);
    const password = readSecretFile(env.MM_OPENCODE_PASSWORD_FILE);
    if (!password || /[\r\n]/.test(password)) throw new Error("Invalid OpenCode password file");
    oc = { origin: u.origin, headers: { authorization: basic(password) } };
  }
  function resolve({ session_id: sid, callback_url: raw }) {
    if (Boolean(sid) === Boolean(raw))
      throw new Error("Provide exactly one of session_id or callback_url");
    if (sid && (!oc || !sessionId.test(sid)))
      throw new Error("A configured OpenCode destination and valid session ID are required");
    const u = endpoint(sid ? oc.origin + "/api/session/" + sid + "/synthetic" : raw);
    const match = /^\/api\/session\/(ses_[A-Za-z0-9]{1,100})\/synthetic$/.exec(u.pathname);
    if (oc && u.origin === oc.origin && match)
      return {
        kind: "opencode",
        url: u.href,
        sessionId: match[1],
        headers: oc.headers,
        template: notificationTemplate(),
      };
    const hook = hooks.get(u.href);
    if (!hook) throw new Error("Callback destination is not enabled on this service");
    return hook;
  }
  return { resolve, secretFiles };
}

export function prepareCallback(target, subscriptionId, account, post, accountId = account) {
  // Preserve existing IDs for uncertain deliveries during multi-account activation.
  const digest = createHash("sha256")
    .update(JSON.stringify([account, subscriptionId, post.postId]))
    .digest("hex");
  const id = "msg_" + digest.slice(0, 32);
  const event = {
    type: "mattermost.message",
    accountId,
    eventId: createHash("sha256")
      .update(JSON.stringify([account, post.postId, "posted"]))
      .digest("hex"),
    eventType: "posted",
    subscriptionId,
    postId: post.postId,
    channelId: post.channelId,
    senderId: post.senderId,
    rootId: post.rootId,
    createdAt: post.createdAt,
    channelType: post.channelType,
    direction: post.direction,
    isMention: post.isMention,
  };
  const template = target.template ?? notificationTemplate();
  const text = template.render({ ...event, message: post.message });
  const payload =
    target.kind === "webhook"
      ? { id: digest, ...event, text, templateRevision: template.revision }
      : {
          id,
          delivery: "queue",
          resume: true,
          description: "Subscribed Mattermost message",
          text,
          metadata: {
            source: "mattermost",
            mattermost: event,
            templateRevision: template.revision,
          },
        };
  return {
    digest,
    payload,
    kind: target.kind,
    sessionId: target.sessionId,
    receipt: target.receipt === true,
  };
}
async function receiptBody(response) {
  const reader = response.body?.getReader(),
    chunks = [];
  let bytes = 0;
  if (!reader) throw new Error("Missing callback receipt");
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error("Oversized callback receipt");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString());
}
export async function deliverCallback(target, subscriptionId, account, post, signal, prepared) {
  const delivery = prepared ?? prepareCallback(target, subscriptionId, account, post);
  const { digest, payload } = delivery;
  if (
    delivery.kind !== target.kind ||
    (delivery.sessionId && delivery.sessionId !== target.sessionId)
  )
    throw new Error("Callback target changed during a pending delivery");
  const response = await fetch(target.url, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: { "content-type": "application/json", "idempotency-key": digest, ...target.headers },
    body: JSON.stringify(payload),
  });
  if (!response.ok || (target.kind === "webhook" && !delivery.receipt)) {
    await response.body?.cancel();
    if (!response.ok) throw new Error("Callback returned HTTP " + response.status);
    return;
  }
  const body = await receiptBody(response);
  if (target.kind === "webhook") {
    if (body?.id !== payload.id || body.accepted !== true)
      throw new Error("Consumer admission receipt mismatch");
  } else {
    const receipt = body.data;
    if (
      receipt?.id !== payload.id ||
      receipt.sessionID !== target.sessionId ||
      receipt.type !== "synthetic"
    )
      throw new Error("OpenCode admission receipt mismatch");
  }
}
