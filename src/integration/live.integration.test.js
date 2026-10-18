// Live integration tests against a real Mattermost instance.
//
// Skipped by default so `npm test` stays offline and green. Enable by setting
// MM_INTEGRATION=1 plus the usual MM_* connection/auth vars (see docker-compose.yml):
//
//   MM_INTEGRATION=1 MM_URL=http://localhost:8065 MM_AUTH_MODE=pat MM_TOKEN=... \
//     [MM_TEST_CHANNEL_ID=<id>] npm run test:integration
//
// The write round-trip (post -> get -> delete) runs only when MM_TEST_CHANNEL_ID
// is provided. It calls Client4 directly (not the guarded tool layer), so the
// guardrail env flags do not apply to it.
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../config.js";
import { createSession } from "../mattermost/client.js";
const LIVE = process.env.MM_INTEGRATION === "1";
const channelId = process.env.MM_TEST_CHANNEL_ID;
describe.skipIf(!LIVE)("live Mattermost integration", () => {
  let session;
  beforeAll(async () => {
    session = await createSession(loadConfig());
  });
  it("authenticates and returns the current user", async () => {
    const me = await session.call((c) => c.getMe());
    expect(me.id).toBeTruthy();
    expect(me.username).toBeTruthy();
  });
  it("lists the user's teams", async () => {
    const teams = await session.call((c) => c.getMyTeams());
    expect(Array.isArray(teams)).toBe(true);
  });
  it.skipIf(!channelId)("posts, reads back, and deletes a message", async () => {
    const stamp = `mattermost-mcp integration ${Date.now()}`;
    const posted = await session.call((c) =>
      c.createPost({ channel_id: channelId, message: stamp }),
    );
    expect(posted.id).toBeTruthy();
    const fetched = await session.call((c) => c.getPost(posted.id));
    expect(fetched.message).toBe(stamp);
    await session.call((c) => c.deletePost(posted.id));
  });
});
