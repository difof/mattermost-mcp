import { readFileSync } from "node:fs";
import { z } from "zod";
import { writePrivateJson } from "../private-json.js";

const id = z.string().regex(/^[a-z0-9]{26}$/);
const timestamp = z.number().int().nonnegative().safe();
const eventSchema = z
  .object({
    kind: z.enum(["dm", "mention"]),
    postId: id,
    channelId: id,
    rootId: id,
    senderId: id,
    createdAt: timestamp,
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    checkpoint: timestamp.nullable(),
    pending: z.array(eventSchema),
    recent: z.array(id),
  })
  .strict();

/** One service owns this private file. Only IDs, types and times reach disk. */
export function openOutbox(file) {
  let state;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error("invalid format");
    state = parsed.data;
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Unreadable event state; refusing to discard pending deliveries");
    state = { version: 1, checkpoint: null, pending: [], recent: [] };
  }
  function save(next) {
    writePrivateJson(file, next);
    state = next;
  }
  return {
    getCheckpoint: () => state.checkpoint,
    checkpoint(time) {
      timestamp.parse(time);
      if (state.checkpoint === null || time > state.checkpoint)
        save({ ...state, checkpoint: time });
    },
    enqueue(input) {
      const event = eventSchema.parse(input);
      if (
        state.recent.includes(event.postId) ||
        state.pending.some((p) => p.postId === event.postId)
      )
        return;
      if (state.pending.length >= 10000)
        throw new Error("Event outbox is full; restore OpenCode delivery");
      save({ ...state, pending: [...state.pending, event] });
    },
    next: () => state.pending[0],
    acknowledge(postId) {
      if (state.pending[0]?.postId !== postId)
        throw new Error("Out-of-order event acknowledgement");
      save({
        ...state,
        pending: state.pending.slice(1),
        recent: [...state.recent.slice(-2047), postId],
      });
    },
  };
}
