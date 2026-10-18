import { Blob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { useMattermost } from "./mattermost-http-fixture.js";

// Curated wire contracts, independent of the generated catalog/schema sampler.
// Sources: Mattermost 3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9,
// api/v4/source/{channels,posts,users,files,uploads,reports,saml}.yaml and
// server/channels/api4/{file,upload,saml,elasticsearch,channel_join_request}.go.
// These fixtures assert transport behavior; the real server owns permissions,
// licensing, configuration gates, and domain validation.
const CHANNEL = "c".repeat(26);
const USER = "u".repeat(26);
const PEER = "p".repeat(26);
const POST = "a".repeat(26);
const FILE = "f".repeat(26);
const UPLOAD = "x".repeat(26);

describe("generic API payload and response contracts through MCP and HTTP", () => {
  const fixture = useMattermost({
    user: { id: USER, username: "casey" },
    guardrails: { allowDestructive: true },
  });

  it("sends direct/group arrays and preserves rich JSON posts and bulk-list responses", async () => {
    const mm = fixture();
    for (const [kind, participants] of [
      ["direct", [USER, PEER]],
      ["group", [USER, PEER, "q".repeat(26)]],
    ]) {
      const channel = { id: CHANNEL, type: kind === "direct" ? "D" : "G", team_id: "" };
      mm.expect("POST", `/channels/${kind}`, { body: participants, status: 201, reply: channel });
      expect(
        await mm.call("api_call", {
          operation: `POST /api/v4/channels/${kind}`,
          body: participants,
        }),
      ).toMatchObject({ status: 201, data: channel });
    }
    const body = {
      channel_id: CHANNEL,
      message: "Plan with exact properties",
      props: { approved: false, count: 0, label: "", nested: [null, 1, "text"] },
    };
    const post = { ...body, id: POST, user_id: USER };
    mm.expect("POST", "/posts", { body, status: 201, reply: post });
    expect(await mm.call("api_call", { operation: "POST /api/v4/posts", body })).toMatchObject({
      status: 201,
      data: post,
    });
    mm.expect("POST", "/posts/ids", { body: [POST], reply: [post] });
    expect(
      await mm.call("api_call", { operation: "POST /api/v4/posts/ids", body: [POST] }),
    ).toMatchObject({ status: 200, data: [post] });
  });

  it("exposes global post search and both file-search routes as JSON requests", async () => {
    const mm = fixture();
    const postQuery = { terms: "launch", is_or_search: false, page: 0, per_page: 25 };
    const posts = { order: [], posts: {}, matches: {} };
    mm.expect("POST", "/posts/search", {
      body: postQuery,
      requestHeaders: { "content-type": "application/json" },
      reply: posts,
    });
    expect(
      await mm.call("api_call", { operation: "POST /api/v4/posts/search", body: postQuery }),
    ).toMatchObject({ data: posts });
    // The pinned OpenAPI labels these multipart; file.go decodes JSON SearchParams.
    const body = { terms: "planning", is_or_search: false, page: 0, per_page: 10 };
    for (const [operation, path, args] of [
      ["POST /api/v4/files/search", "/files/search", {}],
      [
        "POST /api/v4/teams/{team_id}/files/search",
        `/teams/${CHANNEL}/files/search`,
        { team_id: CHANNEL },
      ],
    ]) {
      const files = { order: [], file_infos: {} };
      mm.expect("POST", path, {
        body,
        requestHeaders: { "content-type": "application/json" },
        reply: files,
      });
      expect(await mm.call("api_call", { operation, path: args, body })).toMatchObject({
        data: files,
      });
    }
  });

  it("escapes path values and preserves optional zero/false/empty query values", async () => {
    const mm = fixture();
    const email = "casey+project@example.invalid";
    const user = { id: USER, email, username: "casey" };
    mm.expect("GET", "/users/email/casey%2Bproject%40example.invalid", { reply: user });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/users/email/{email}",
        path: { email },
      }),
    ).toMatchObject({ data: user });
    const query = {
      page: 0,
      per_page: 2,
      active: false,
      in_team: CHANNEL,
      sort: "",
      roles: "system_user,system_admin",
    };
    mm.expect("GET", "/users", { query, reply: [] });
    expect(await mm.call("api_call", { operation: "GET /api/v4/users", query })).toMatchObject({
      data: [],
    });
    // elasticsearch.go reads r.URL.Query()["index"] as repeated keys.
    mm.expect("POST", "/elasticsearch/purge_indexes", {
      query: { index: ["posts", "users"] },
      reply: { status: "OK" },
    });
    expect(
      await mm.call("api_call", {
        operation: "POST /api/v4/elasticsearch/purge_indexes",
        query: { index: ["posts", "users"] },
        confirm: true,
      }),
    ).toMatchObject({ data: { status: "OK" } });
  });

  it("uploads repeated multipart file fields with client IDs before the file bytes", async () => {
    const mm = fixture();
    const payloads = [Buffer.from([0, 255, 13, 10, 128]), Buffer.from("Planning\n")];
    const files = payloads.map((bytes, i) => ({
      field: "files",
      filename: i ? "notes.txt" : "sample.bin",
      content_base64: bytes.toString("base64"),
      content_type: i ? "text/plain" : "application/octet-stream",
    }));
    const body = { channel_id: CHANNEL, client_ids: ["first-client-id", "second-client-id"] };
    const reply = {
      file_infos: files.map((file, i) => ({
        id: i ? "g".repeat(26) : FILE,
        name: file.filename,
        size: payloads[i].length,
        post_id: "",
      })),
      client_ids: body.client_ids,
    };
    mm.expect("POST", "/files", {
      inspectBody: async (bytes, headers) => {
        expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
        const form = await new globalThis.Response(bytes, {
          headers: { "Content-Type": headers["content-type"] },
        }).formData();
        expect([...form.keys()]).toEqual([
          "channel_id",
          "client_ids",
          "client_ids",
          "files",
          "files",
        ]);
        expect(form.get("channel_id")).toBe(CHANNEL);
        expect(form.getAll("client_ids")).toEqual(body.client_ids);
        const uploaded = form.getAll("files");
        expect(uploaded).toHaveLength(2);
        for (let i = 0; i < uploaded.length; i++) {
          expect(uploaded[i]).toBeInstanceOf(Blob);
          expect(uploaded[i].name).toBe(files[i].filename);
          expect(uploaded[i].type).toBe(files[i].content_type);
          expect(Buffer.from(await uploaded[i].arrayBuffer())).toEqual(payloads[i]);
        }
      },
      status: 201,
      reply,
    });
    expect(
      await mm.call("api_call", { operation: "POST /api/v4/files", body, files }),
    ).toMatchObject({ status: 201, data: reply });
  });

  it("creates and resumes a raw upload, preserving a true 204 and final FileInfo", async () => {
    const mm = fixture();
    const bytes = Buffer.from([0, 255, 65, 66, 67, 128]);
    const body = { channel_id: CHANNEL, filename: "resumable.bin", file_size: bytes.length };
    const session = { ...body, id: UPLOAD, user_id: USER, file_offset: 0 };
    mm.expect("POST", "/uploads", { body, status: 201, reply: session });
    expect(await mm.call("api_call", { operation: "POST /api/v4/uploads", body })).toMatchObject({
      status: 201,
      data: session,
    });
    const args = {
      operation: "POST /api/v4/uploads/{upload_id}",
      path: { upload_id: UPLOAD },
      content_type: "application/octet-stream",
    };
    mm.expect("POST", `/uploads/${UPLOAD}`, {
      requestHeaders: { "content-type": "application/octet-stream" },
      inspectBody: (chunk) => expect(chunk).toEqual(bytes.subarray(0, 3)),
      status: 204,
    });
    expect(
      await mm.call("api_call", { ...args, body_base64: bytes.subarray(0, 3).toString("base64") }),
    ).toMatchObject({ status: 204, data: null });
    mm.expect("GET", `/uploads/${UPLOAD}`, { reply: { ...session, file_offset: 3 } });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/uploads/{upload_id}",
        path: { upload_id: UPLOAD },
      }),
    ).toMatchObject({ data: { file_offset: 3 } });
    const file = { id: FILE, name: body.filename, size: bytes.length, post_id: "" };
    mm.expect("POST", `/uploads/${UPLOAD}`, {
      requestHeaders: { "content-type": "application/octet-stream" },
      inspectBody: (chunk) => expect(chunk).toEqual(bytes.subarray(3)),
      reply: file,
    });
    // upload.go's completed upload writes JSON with the default 200 status.
    expect(
      await mm.call("api_call", { ...args, body_base64: bytes.subarray(3).toString("base64") }),
    ).toMatchObject({ status: 200, data: file });
  });

  it("preserves file HEAD, ranged binary downloads, and conditional 304 responses", async () => {
    const mm = fixture();
    const path = { file_id: FILE };
    mm.expect("HEAD", `/files/${FILE}`, {
      headers: { "Content-Type": "image/png", "Content-Length": "2000000", ETag: '"file-v1"' },
    });
    expect(
      await mm.call("api_call", { operation: "HEAD /api/v4/files/{file_id}", path }),
    ).toMatchObject({
      status: 200,
      data: null,
      headers: { "content-type": "image/png", "content-length": "2000000" },
    });
    const bytes = Buffer.from([0, 255, 128, 65]);
    mm.expect("GET", `/files/${FILE}`, {
      requestHeaders: { range: "bytes=0-3", "connection-id": "mock-websocket-connection" },
      bytes,
      status: 206,
      headers: { "Content-Type": "image/png", "Content-Range": "bytes 0-3/200" },
    });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/files/{file_id}",
        path,
        headers: { Range: "bytes=0-3", "Connection-Id": "mock-websocket-connection" },
        max_bytes: 4,
      }),
    ).toMatchObject({
      status: 206,
      body_base64: bytes.toString("base64"),
      bytes: 4,
      headers: { "content-range": "bytes 0-3/200" },
    });
    mm.expect("GET", `/files/${FILE}`, {
      requestHeaders: { "if-none-match": '"file-v1"' },
      status: 304,
      headers: { ETag: '"file-v1"' },
    });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/files/{file_id}",
        path,
        headers: { "If-None-Match": '"file-v1"' },
      }),
    ).toMatchObject({ status: 304, data: null, headers: { etag: '"file-v1"' } });
  });

  it("returns zero, explicit null, a JSON string, and XML text without changing their types", async () => {
    const mm = fixture();
    mm.expect("GET", "/reports/users/count", { reply: 0 });
    expect(
      await mm.call("api_call", { operation: "GET /api/v4/reports/users/count" }),
    ).toMatchObject({ status: 200, data: 0 });
    // Draft deletion via an empty-message upsert returns JSON null, not an object.
    const draft = { channel_id: CHANNEL, message: "" };
    mm.expect("POST", "/drafts", { body: draft, status: 201, reply: null });
    expect(
      await mm.call("api_call", { operation: "POST /api/v4/drafts", body: draft }),
    ).toMatchObject({ status: 201, data: null });
    const metadata =
      '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.invalid"/>';
    const body = { saml_metadata_url: "https://idp.example.invalid/metadata" };
    mm.expect("POST", "/saml/metadatafromidp", { body, reply: metadata });
    expect(
      await mm.call("api_call", {
        operation: "POST /api/v4/saml/metadatafromidp",
        body,
        confirm: true,
      }),
    ).toMatchObject({ status: 200, data: metadata });
    mm.expect("GET", "/saml/metadata", {
      bytes: Buffer.from(metadata),
      headers: {
        "Content-Type": "application/xml",
        "Content-Disposition": 'attachment; filename="metadata.xml"',
      },
    });
    expect(await mm.call("api_call", { operation: "GET /api/v4/saml/metadata" })).toMatchObject({
      status: 200,
      data: metadata,
      headers: { "content-type": "application/xml" },
    });
  });

  it("uses the seven source-derived join-request routes and their actual list wrappers", async () => {
    const mm = fixture();
    const request = {
      id: "r".repeat(26),
      channel_id: CHANNEL,
      user_id: USER,
      message: "Please add me to planning",
      status: "pending",
      denial_reason: "",
      create_at: 1000,
      update_at: 1000,
      reviewed_by: "",
      reviewed_at: 0,
    };
    const path = { channel_id: CHANNEL };
    mm.expect("POST", `/channels/${CHANNEL}/join_request`, {
      body: { message: request.message },
      status: 201,
      reply: request,
    });
    expect(
      await mm.call("api_call", {
        operation: "POST /api/v4/channels/{channel_id}/join_request",
        path,
        body: { message: request.message },
      }),
    ).toMatchObject({ status: 201, data: request });
    mm.expect("GET", `/channels/${CHANNEL}/join_request`, { reply: request });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/channels/{channel_id}/join_request",
        path,
      }),
    ).toMatchObject({ data: request });
    const page = { requests: [request], total_count: 1 };
    mm.expect("GET", `/users/${USER}/channel_join_requests`, {
      query: { status: "pending", page: 0, per_page: 2 },
      reply: page,
    });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/users/{user_id}/channel_join_requests",
        path: { user_id: USER },
        query: { status: "pending", page: 0, per_page: 2 },
      }),
    ).toMatchObject({ data: page });
    const withdrawn = { ...request, status: "withdrawn", update_at: 2000 };
    mm.expect("DELETE", `/channels/${CHANNEL}/join_request`, { reply: withdrawn });
    expect(
      await mm.call("api_call", {
        operation: "DELETE /api/v4/channels/{channel_id}/join_request",
        path,
        confirm: true,
      }),
    ).toMatchObject({ data: withdrawn });

    // A separate queue models the review response for a permitted channel manager.
    const managed = "m".repeat(26);
    const pending = { ...request, id: "s".repeat(26), channel_id: managed, user_id: PEER };
    mm.expect("GET", `/channels/${managed}/join_requests`, {
      query: { status: "pending", page: 0, per_page: 2 },
      reply: { requests: [pending], total_count: 1 },
    });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/channels/{channel_id}/join_requests",
        path: { channel_id: managed },
        query: { status: "pending", page: 0, per_page: 2 },
      }),
    ).toMatchObject({ data: { requests: [pending], total_count: 1 } });
    mm.expect("GET", `/channels/${managed}/join_requests/count`, { reply: { count: 1 } });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/channels/{channel_id}/join_requests/count",
        path: { channel_id: managed },
      }),
    ).toMatchObject({ data: { count: 1 } });
    const approved = {
      ...pending,
      status: "approved",
      reviewed_by: USER,
      reviewed_at: 3000,
      update_at: 3000,
    };
    mm.expect("PATCH", `/channels/${managed}/join_requests/${pending.id}`, {
      body: { status: "approved", denial_reason: null },
      reply: approved,
    });
    expect(
      await mm.call("api_call", {
        operation: "PATCH /api/v4/channels/{channel_id}/join_requests/{request_id}",
        path: { channel_id: managed, request_id: pending.id },
        body: { status: "approved", denial_reason: null },
        confirm: true,
      }),
    ).toMatchObject({ data: approved });
  });

  it("lets the caller request exact text or base64 and fails malformed explicit JSON", async () => {
    const mm = fixture();
    const bytes = Buffer.from('{ "status": "OK" }\n');
    for (const response_format of ["text", "base64"]) {
      mm.expect("GET", "/system/ping", { bytes, headers: { "Content-Type": "application/json" } });
      const result = await mm.call("api_call", {
        operation: "GET /api/v4/system/ping",
        response_format,
      });
      expect(result).toMatchObject(
        response_format === "text"
          ? { data: bytes.toString("utf8") }
          : { body_base64: bytes.toString("base64"), bytes: bytes.length },
      );
    }
    mm.expect("GET", "/system/ping", {
      bytes: Buffer.from("not valid JSON"),
      headers: { "Content-Type": "text/plain" },
    });
    expect(
      await mm.error("api_call", { operation: "GET /api/v4/system/ping", response_format: "json" }),
    ).toMatch(/JSON|json/);
  });

  it.each([
    { name: "declared binary", bytes: Buffer.alloc(65), headers: {}, chunked: false },
    {
      name: "chunked JSON",
      bytes: Buffer.from(JSON.stringify({ message: "x".repeat(100) })),
      headers: { "Content-Type": "application/json" },
      chunked: true,
    },
    {
      name: "decompressed binary",
      bytes: gzipSync(Buffer.alloc(1000)),
      headers: { "Content-Encoding": "gzip" },
      chunked: false,
    },
    {
      name: "oversized error",
      bytes: Buffer.from(JSON.stringify({ message: "x".repeat(100) })),
      headers: { "Content-Type": "application/json" },
      chunked: true,
      status: 503,
    },
  ])("bounds $name responses without retrying an already oversized transfer", async (exchange) => {
    const mm = fixture();
    const { name: _name, ...response } = exchange;
    mm.expect("GET", `/files/${FILE}`, response);
    expect(
      await mm.error("api_call", {
        operation: "GET /api/v4/files/{file_id}",
        path: { file_id: FILE },
        max_bytes: 64,
      }),
    ).toMatch(/max_bytes|exceeds|limit/i);
    // There is intentionally only one expectation, even for the 503 response.
  });
});
