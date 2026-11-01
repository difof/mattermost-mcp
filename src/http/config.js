import { readSecretFile } from "../service/secret.js";

function integer(value, name, max) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  }
  return n;
}

export function httpSettings(env = process.env) {
  if (Boolean(env.MM_HTTP_TOKEN) === Boolean(env.MM_HTTP_TOKEN_FILE)) {
    throw new Error("Set exactly one of MM_HTTP_TOKEN or MM_HTTP_TOKEN_FILE");
  }
  const token = env.MM_HTTP_TOKEN || readSecretFile(env.MM_HTTP_TOKEN_FILE);
  if (!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(token)) {
    throw new Error("Use a randomly generated HTTP bearer token of at least 32 characters");
  }
  if (env.MM_EVENTS_ENABLED && !["true", "false"].includes(env.MM_EVENTS_ENABLED)) {
    throw new Error("MM_EVENTS_ENABLED must be true or false");
  }
  return {
    token,
    port: integer(env.MM_HTTP_PORT || "8766", "MM_HTTP_PORT", 65535),
    maxBodyBytes: integer(
      env.MM_HTTP_MAX_BODY_BYTES || "4194304",
      "MM_HTTP_MAX_BODY_BYTES",
      256 * 1024 * 1024,
    ),
    eventsEnabled: env.MM_EVENTS_ENABLED === "true",
  };
}
