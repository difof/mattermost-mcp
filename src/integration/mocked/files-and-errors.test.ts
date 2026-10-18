import { describe, expect, it } from "vitest";
import { ME, PEER, OK, useMattermost } from "./mattermost-http-fixture.js";

describe("file transfers and failures through MCP and HTTP", () => {
  const fixture = useMattermost();

  it("uploads binary multipart content, attaches it to a post, and retrieves it unchanged", async () => {
    const mm = fixture();
    const bytes = Buffer.from([0, 255, 13, 10, 65, 128]);
    const metadata = {
      id: "binary-file",
      name: "sample.bin",
      size: bytes.length,
      mime_type: "application/octet-stream",
      post_id: "",
    };
    mm.expect("POST", "/files", {
      inspectBody: async (body, headers) => {
        expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
        const form = await new Response(body, {
          headers: { "Content-Type": headers["content-type"]! },
        }).formData();
        expect([...form.keys()].sort()).toEqual(["channel_id", "files"]);
        expect(form.get("channel_id")).toBe("project-channel");
        const file = form.get("files");
        expect(file).toBeInstanceOf(Blob);
        if (file === null || typeof file === "string") throw new Error("Expected multipart file");
        expect(file.name).toBe("sample.bin");
        expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      },
      reply: { file_infos: [metadata], client_ids: [] },
    });
    const uploaded = await mm.call<{ id: string; name: string; size: number; mime_type: string }[]>(
      "upload_file",
      {
        channel_id: "project-channel",
        filename: "sample.bin",
        content_base64: bytes.toString("base64"),
      },
    );
    expect(uploaded).toEqual([
      { id: metadata.id, name: metadata.name, size: bytes.length, mime_type: metadata.mime_type },
    ]);
    const args = {
      channel_id: "project-channel",
      message: "Attached sample",
      file_ids: uploaded.map(({ id }) => id),
      root_id: "thread-root",
    };
    const post = { ...args, id: "file-post", user_id: ME.id };
    mm.expect("POST", "/posts", { body: args, reply: post });
    expect(await mm.call("post_message", args)).toEqual(post);
    const attachedMetadata = { ...metadata, post_id: post.id };
    mm.expect("GET", `/files/${metadata.id}/info`, { reply: attachedMetadata });
    expect(await mm.call("get_file_metadata", { file_id: metadata.id })).toEqual(attachedMetadata);
    mm.expect("GET", `/files/${metadata.id}`, { bytes });
    expect(await mm.call("get_file", { file_id: metadata.id, max_bytes: bytes.length })).toEqual({
      file_id: metadata.id,
      bytes: bytes.length,
      content_base64: bytes.toString("base64"),
    });
  });

  it("returns an empty file with the default limit", async () => {
    const mm = fixture();
    mm.expect("GET", "/files/empty-file", { bytes: Buffer.alloc(0) });
    expect(await mm.call("get_file", { file_id: "empty-file" })).toEqual({
      file_id: "empty-file",
      bytes: 0,
      content_base64: "",
    });
  });

  it.each([false, true])(
    "rejects an oversized download without retry (chunked=%s)",
    async (chunked) => {
      const mm = fixture();
      mm.expect("GET", "/files/oversized-file", { bytes: Buffer.alloc(32, 65), chunked });
      expect(await mm.error("get_file", { file_id: "oversized-file", max_bytes: 8 })).toContain(
        "file exceeds max_bytes (8)",
      );
    },
  );

  it("retries transient read failures at the HTTP boundary, including read-only POST search", async () => {
    const mm = fixture();
    mm.expect("GET", "/channels/project-channel", {
      status: 503,
      reply: { status_code: 503, id: "api.unavailable", message: "Temporarily unavailable" },
    });
    const channel = { id: "project-channel", team_id: "project-team", type: "O" };
    mm.expect("GET", "/channels/project-channel", { reply: channel });
    expect(await mm.call("get_channel", { channel_id: channel.id })).toEqual(channel);
    mm.expect("POST", "/users/search", {
      body: { term: "robin" },
      status: 429,
      reply: { status_code: 429, id: "api.rate_limit", message: "Rate limit exceeded" },
    });
    mm.expect("POST", "/users/search", { body: { term: "robin" }, reply: [PEER] });
    expect(await mm.call("search_users", { term: "robin" })).toEqual([PEER]);
    const metadata = { id: "retry-file", name: "sample.txt", size: 4 };
    mm.expect("GET", "/files/retry-file/info", {
      status: 503,
      reply: { status_code: 503, message: "Temporarily unavailable" },
    });
    mm.expect("GET", "/files/retry-file/info", { reply: metadata });
    expect(await mm.call("get_file_metadata", { file_id: metadata.id })).toEqual(metadata);
  });

  it("does not replay either step of send_dm after an ambiguous post failure", async () => {
    const mm = fixture();
    mm.expect("POST", "/channels/direct", {
      body: [ME.id, PEER.id],
      reply: { id: "existing-dm", type: "D", team_id: "" },
    });
    mm.expect("POST", "/posts", {
      body: { channel_id: "existing-dm", message: "One send attempt" },
      status: 503,
      reply: { status_code: 503, id: "api.unavailable", message: "Post result unavailable" },
    });
    const error = await mm.error("send_dm", { user_ids: [PEER.id], message: "One send attempt" });
    expect(error).toContain("503");
    expect(error).toContain("Post result unavailable");
    // No second channel-create or post expectation: an automatic resend fails the fixture.
    mm.expect("GET", "/users/me", { reply: ME });
    expect(await mm.call("get_me")).toEqual(ME);
  });

  it.each([
    {
      name: "revoked PAT",
      tool: "get_me",
      args: {},
      path: "/users/me",
      status: 401,
      message: "Invalid or expired token",
    },
    {
      name: "inaccessible post",
      tool: "get_post",
      args: { post_id: "private-post" },
      path: "/posts/private-post",
      status: 403,
      message: "You do not have permission to view this post",
    },
    {
      name: "missing file metadata",
      tool: "get_file_metadata",
      args: { file_id: "missing-file" },
      path: "/files/missing-file/info",
      status: 404,
      message: "File not found",
    },
    {
      name: "missing file download",
      tool: "get_file",
      args: { file_id: "missing-file" },
      path: "/files/missing-file",
      status: 404,
      message: "File not found",
    },
  ])(
    "surfaces $name with the original HTTP status and message",
    async ({ tool, args, path, status, message }) => {
      const mm = fixture();
      mm.expect("GET", path, {
        status,
        reply: { status_code: status, id: "api.permissions_or_missing", message },
      });
      const error = await mm.error(tool, args);
      expect(error).toContain(String(status));
      expect(error).toContain(message);
      expect(error).toContain("api.permissions_or_missing");
    },
  );

  it("refuses read-only writes and destructive operations before any HTTP request", async () => {
    const mm = fixture();
    mm.guardrails.readOnly = true;
    expect(
      await mm.error("post_message", { channel_id: "project-channel", message: "Blocked" }),
    ).toContain("read-only");
    expect(await mm.error("set_status", { status: "away" })).toContain("read-only");
    mm.guardrails.readOnly = false;
    expect(await mm.error("delete_post", { post_id: "post", confirm: true })).toContain(
      "MM_ALLOW_DESTRUCTIVE",
    );
    mm.guardrails.allowDestructive = true;
    expect(await mm.error("delete_post", { post_id: "post" })).toContain("confirm:true");
    mm.expect("GET", "/users/me", { reply: ME });
    expect(await mm.call("get_me")).toEqual(ME);
  });

  it("rejects invalid selectors and participants before contacting Mattermost", async () => {
    const mm = fixture();
    expect(
      await mm.error("get_channel_posts", { channel_id: "channel", since: 0, page: 0 }),
    ).toContain("since cannot be combined");
    expect(
      await mm.error("send_dm", { user_ids: [PEER.id, PEER.id], message: "Duplicate" }),
    ).toContain("unique participants");
    expect(await mm.error("send_dm", { user_ids: [ME.id], message: "Self" })).toContain(
      "other participants",
    );
    expect(await mm.error("get_user", { user_id: PEER.id, username: PEER.username })).toContain(
      "exactly one",
    );
    expect(await mm.error("not_a_tool")).toContain("unknown tool");
    expect(await mm.error("search_posts", { team_id: "", terms: "plan" })).toContain(
      "invalid arguments",
    );
  });

  it("rejects invalid custom-status expiration before contacting Mattermost", async () => {
    const mm = fixture();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const invalid: { duration: string; expires_at?: string }[] = [
      { duration: "today" },
      { duration: "one_hour", expires_at: "not-a-date" },
      { duration: "custom_date_time", expires_at: expiresAt },
      { duration: "", expires_at: expiresAt.replace("Z", "") },
      { duration: "", expires_at: expiresAt.replace("Z", "+0200") },
      { duration: "", expires_at: expiresAt.replace("Z", "+25:00") },
      { duration: "", expires_at: `${expiresAt.slice(0, 16)}Z` },
    ];
    for (const expiration of invalid) {
      const error = await mm.error("set_custom_status", {
        emoji: "calendar",
        text: "Planning",
        ...expiration,
      });
      expect(error, JSON.stringify(expiration)).toContain("invalid arguments");
      expect(error).toContain(
        expiration.duration === "custom_date_time" ? "duration" : "expires_at",
      );
    }
  });

  it("resolves file and thread provenance before allowing access to another channel", async () => {
    const mm = fixture();
    mm.guardrails.channelAllowlist = ["allowed-channel"];
    mm.expect("GET", "/files/hidden-file/info", {
      reply: { id: "hidden-file", post_id: "hidden-post" },
    });
    mm.expect("GET", "/posts/hidden-post", {
      reply: { id: "hidden-post", channel_id: "hidden-channel" },
    });
    expect(await mm.error("get_file", { file_id: "hidden-file" })).toContain(
      "MM_CHANNEL_ALLOWLIST",
    );
    mm.expect("GET", "/posts/hidden-post", {
      reply: { id: "hidden-post", channel_id: "hidden-channel" },
    });
    expect(
      await mm.error("reply_thread", {
        channel_id: "allowed-channel",
        root_id: "hidden-post",
        message: "Blocked",
      }),
    ).toContain("MM_CHANNEL_ALLOWLIST");
    expect(await mm.error("send_dm", { user_ids: [PEER.id], message: "Blocked" })).toContain(
      "opening or creating channels",
    );
  });

  it("filters restricted search results after parsing the real HTTP response", async () => {
    const mm = fixture();
    mm.guardrails.channelAllowlist = ["allowed-channel"];
    const allowed = { id: "allowed-post", channel_id: "allowed-channel", message: "Visible" };
    const hidden = { id: "hidden-post", channel_id: "hidden-channel", message: "Private" };
    mm.expect("POST", "/teams/project-team/posts/search", {
      body: { terms: "plan", is_or_search: false },
      reply: {
        order: [hidden.id, allowed.id],
        posts: { [hidden.id]: hidden, [allowed.id]: allowed },
        matches: { [hidden.id]: ["private"], [allowed.id]: ["plan"] },
        next_post_id: hidden.id,
      },
    });
    expect(await mm.call("search_posts", { team_id: "project-team", terms: "plan" })).toEqual({
      order: [allowed.id],
      posts: { [allowed.id]: allowed },
      matches: { [allowed.id]: ["plan"] },
      next_post_id: "",
    });
    // A permitted write still succeeds with the same policy; the guard is not a blanket block.
    mm.expect("POST", "/channels/members/me/view", {
      body: { channel_id: "allowed-channel", collapsed_threads_supported: true },
    });
    expect(await mm.call("mark_channel_read", { channel_id: "allowed-channel" })).toEqual(OK);
  });
});
