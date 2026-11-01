import { expect, it, vi } from "vitest";
import { readEventJson } from "./api.js";
import { recoverPosts } from "./recovery.js";

vi.mock("./api.js", () => ({ readEventJson: vi.fn() }));

const id = (n) => String(n).padStart(26, "0");
const me = { id: id(1), username: "operator" };

it.each([
  { count: 65, complete: true },
  { count: 205, complete: false },
])(
  "handles a changing burst of $count posts without claiming an unsafe offset scan is complete",
  async ({ count, complete }) => {
    const channels = new Map([1, 2].map((n) => [id(n), { id: id(n), type: "D" }]));
    const post = (n, time, c = 1) => ({
      id: id(n),
      channel_id: id(c),
      create_at: time,
      user_id: me.id,
      message: "test",
    });
    const burst = Array.from({ length: count }, (_, i) => post(i + 10, 50));
    const expired = post(900, 10),
      laterChannel = post(901, 30, 2);
    const history = new Map([
      [id(1), [...burst, expired]],
      [id(2), [laterChannel]],
    ]);
    const seen = new Set();
    const offsets = [];
    readEventJson.mockImplementation(async (_session, url) => {
      const rows = history.get(url.pathname.split("/")[2]);
      const size = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page") ?? 0);
      if (page) offsets.push(page);
      // The first tied row vanishes after the normal page is fetched. A cold cache
      // cannot detect another row silently skipped by OFFSET when the set shrinks.
      if (size === 200 && page === (complete ? 0 : 1) && rows[0]?.id === burst[0].id) {
        seen.delete(rows.shift().id); // matching live deletion
      }
      const before = url.searchParams.get("before");
      const cutoff = before ? rows.find((p) => p.id === before)?.create_at : Infinity;
      const batch = rows.filter((p) => p.create_at < cutoff).slice(page * size, (page + 1) * size);
      return {
        order: batch.map((p) => p.id),
        posts: Object.fromEntries(batch.map((p) => [p.id, p])),
      };
    });
    const cache = {
      cachedIds: () => [],
      enqueueBatch: (records) => {
        for (const r of records) seen.add(r.postId);
      },
    };
    const session = {
      client: { getChannelRoute: (channel) => "http://fixture.invalid/channels/" + channel },
    };
    expect(
      await recoverPosts({
        session,
        channels,
        me,
        since: 10,
        until: 100,
        cache,
        signal: new AbortController().signal,
      }),
    ).toBe(complete);
    expect(seen.has(expired.id)).toBe(false);
    expect(seen.has(burst[0].id)).toBe(false);
    expect(seen.has(laterChannel.id)).toBe(true);
    const unseen = burst.slice(1).filter((p) => !seen.has(p.id));
    expect(unseen).toEqual(complete ? [] : [burst[200]]);
    expect(offsets).toEqual(complete ? [] : [1]);
  },
);
