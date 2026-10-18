import { z } from "zod";
import { defineTool, type AnyToolDef } from "./registry.js";

// ---------------------------------------------------------------------------
// post_message — POST /posts
// ---------------------------------------------------------------------------
const postMessage = defineTool({
  name: "post_message",
  title: "Post message",
  description: "Send a new message to a channel (POST /posts).",
  inputSchema: z.object({
    channel_id: z.string().describe("Channel to post in."),
    message: z.string().describe("Message text."),
    root_id: z.string().optional().describe("Thread root post id (makes this a reply)."),
    file_ids: z.array(z.string()).optional().describe("Attached file ids."),
    props: z.record(z.unknown()).optional().describe("Custom post properties."),
  }),
  write: true,
  resources: (args) => ({
    channelId: args.channel_id,
    postId: args.root_id || undefined,
    fileIds: args.file_ids,
  }),
  resultScope: "post",
  messageText: (args) => args.message,
  handler: (args, { session }) =>
    session.call((c) =>
      c.createPost({
        channel_id: args.channel_id,
        message: args.message,
        ...(args.root_id != null ? { root_id: args.root_id } : {}),
        ...(args.file_ids != null ? { file_ids: args.file_ids } : {}),
        ...(args.props != null ? { props: args.props } : {}),
      }),
    ),
});

// ---------------------------------------------------------------------------
// reply_thread — POST /posts (with root_id)
// ---------------------------------------------------------------------------
const replyThread = defineTool({
  name: "reply_thread",
  title: "Reply to thread",
  description: "Reply to an existing thread (POST /posts with root_id).",
  inputSchema: z.object({
    channel_id: z.string().describe("Channel the thread lives in."),
    root_id: z.string().describe("Root post id of the thread."),
    message: z.string().describe("Reply text."),
  }),
  write: true,
  resources: (args) => ({ channelId: args.channel_id, postId: args.root_id }),
  resultScope: "post",
  messageText: (args) => args.message,
  handler: (args, { session }) =>
    session.call((c) =>
      c.createPost({
        channel_id: args.channel_id,
        message: args.message,
        root_id: args.root_id,
      }),
    ),
});

// ---------------------------------------------------------------------------
// get_channel_posts — GET /channels/{id}/posts
// ---------------------------------------------------------------------------
const getChannelPosts = defineTool({
  name: "get_channel_posts",
  title: "Get channel posts",
  description: "Fetch posts from a channel (GET /channels/{id}/posts).",
  inputSchema: z
    .object({
      channel_id: z.string().describe("Channel id."),
      page: z.number().int().nonnegative().optional().describe("Page index (default 0)."),
      per_page: z.number().int().positive().optional().describe("Results per page (default 60)."),
      since: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Unix timestamp in ms — return posts modified since this time, up to 1000. Cannot be combined with before, after, page, or per_page; results may have gaps.",
        ),
      before: z
        .string()
        .min(1)
        .optional()
        .describe("Post id — return posts before this one (mutually exclusive with since/after)."),
      after: z
        .string()
        .min(1)
        .optional()
        .describe("Post id — return posts after this one (mutually exclusive with since/before)."),
    })
    .superRefine((args, ctx) => {
      if (
        args.since != null &&
        (args.before != null || args.after != null || args.page != null || args.per_page != null)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["since"],
          message: "since cannot be combined with before, after, page, or per_page",
        });
      }
      if (args.before != null && args.after != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["after"],
          message: "before and after are mutually exclusive",
        });
      }
    }),
  resources: (args) => ({ channelId: args.channel_id }),
  resultScope: "posts",
  handler: (args, { session }) => {
    const page = args.page ?? 0;
    const perPage = args.per_page ?? 60;
    if (args.since != null) {
      return session.call((c) => c.getPostsSince(args.channel_id, args.since!));
    }
    if (args.before != null) {
      return session.call((c) => c.getPostsBefore(args.channel_id, args.before!, page, perPage));
    }
    if (args.after != null) {
      return session.call((c) => c.getPostsAfter(args.channel_id, args.after!, page, perPage));
    }
    return session.call((c) => c.getPosts(args.channel_id, page, perPage));
  },
});

// ---------------------------------------------------------------------------
// get_thread — GET /posts/{id}/thread
// ---------------------------------------------------------------------------
const getThread = defineTool({
  name: "get_thread",
  title: "Get thread",
  description: "Fetch a full post thread (GET /posts/{id}/thread).",
  inputSchema: z.object({
    post_id: z.string().describe("Root post id."),
  }),
  resources: (args) => ({ postId: args.post_id }),
  resultScope: "posts",
  handler: (args, { session }) => session.call((c) => c.getPostThread(args.post_id)),
});

// ---------------------------------------------------------------------------
// get_post — GET /posts/{id}
// ---------------------------------------------------------------------------
const getPost = defineTool({
  name: "get_post",
  title: "Get post",
  description: "Fetch a single post by id (GET /posts/{id}).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id."),
  }),
  resources: (args) => ({ postId: args.post_id }),
  resultScope: "post",
  handler: (args, { session }) => session.call((c) => c.getPost(args.post_id)),
});

// ---------------------------------------------------------------------------
// search_posts — POST /teams/{id}/posts/search
// ---------------------------------------------------------------------------
const searchPosts = defineTool({
  name: "search_posts",
  title: "Search posts",
  description: "Search for posts in a team (POST /teams/{id}/posts/search).",
  inputSchema: z.object({
    team_id: z.string().describe("Team id to search within."),
    terms: z.string().describe("Search terms."),
    is_or_search: z
      .boolean()
      .default(false)
      .optional()
      .describe("Use OR logic between terms (default false)."),
  }),
  resources: (args) => ({ teamId: args.team_id }),
  resultScope: "posts",
  handler: (args, { session }) =>
    session.call((c) => c.searchPosts(args.team_id, args.terms, args.is_or_search ?? false)),
});

// ---------------------------------------------------------------------------
// edit_post — PUT /posts/{id}/patch
// ---------------------------------------------------------------------------
const editPost = defineTool({
  name: "edit_post",
  title: "Edit post",
  description: "Edit the text of an existing post (PUT /posts/{id}/patch).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id to edit."),
    message: z.string().describe("New message text."),
  }),
  write: true,
  resources: (args) => ({ postId: args.post_id }),
  resultScope: "post",
  messageText: (args) => args.message,
  handler: (args, { session }) =>
    session.call((c) => c.patchPost({ id: args.post_id, message: args.message })),
});

// ---------------------------------------------------------------------------
// delete_post — DELETE /posts/{id}
// ---------------------------------------------------------------------------
const deletePost = defineTool({
  name: "delete_post",
  title: "Delete post",
  description: "Delete a post (soft delete; DELETE /posts/{id}).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id to delete."),
    confirm: z.boolean().optional().describe("Must be true to authorize this destructive action."),
  }),
  destructive: true,
  resources: (args) => ({ postId: args.post_id }),
  handler: (args, { session }) => session.call((c) => c.deletePost(args.post_id)),
});

// ---------------------------------------------------------------------------
// send_dm — POST /channels/direct or /channels/group, then POST /posts
// ---------------------------------------------------------------------------
const sendDm = defineTool({
  name: "send_dm",
  title: "Send DM",
  description:
    "Open a direct (2-person) or group (3–8 person) channel and send a message (POST /channels/direct | /channels/group + POST /posts).",
  inputSchema: z.object({
    user_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(7)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "user_ids must contain unique participants",
      )
      .describe(
        "The OTHER participants, without duplicates or yourself (1 for DM, 2–7 for group).",
      ),
    message: z.string().describe("Message text."),
  }),
  write: true,
  resources: () => ({ createsChannel: true }),
  resultScope: "post",
  messageText: (args) => args.message,
  handler: async (args, { session }) => {
    if (args.user_ids.includes(session.userId)) {
      throw new Error(
        "invalid arguments for send_dm: user_ids must contain only other participants, not the authenticated user",
      );
    }
    const members = [session.userId, ...args.user_ids];
    const channel = await session.call((c) =>
      members.length === 2 ? c.createDirectChannel(members) : c.createGroupChannel(members),
    );
    return session.call((c) => c.createPost({ channel_id: channel.id, message: args.message }));
  },
});

// ---------------------------------------------------------------------------
// pin_post — POST /posts/{id}/pin
// ---------------------------------------------------------------------------
const pinPost = defineTool({
  name: "pin_post",
  title: "Pin post",
  description: "Pin a post to its channel (POST /posts/{id}/pin).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id to pin."),
  }),
  write: true,
  resources: (args) => ({ postId: args.post_id }),
  handler: (args, { session }) => session.call((c) => c.pinPost(args.post_id)),
});

// ---------------------------------------------------------------------------
// unpin_post — POST /posts/{id}/unpin
// ---------------------------------------------------------------------------
const unpinPost = defineTool({
  name: "unpin_post",
  title: "Unpin post",
  description: "Unpin a post from its channel (POST /posts/{id}/unpin).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id to unpin."),
  }),
  write: true,
  resources: (args) => ({ postId: args.post_id }),
  handler: (args, { session }) => session.call((c) => c.unpinPost(args.post_id)),
});

// ---------------------------------------------------------------------------
// add_reaction — POST /reactions
// ---------------------------------------------------------------------------
const addReaction = defineTool({
  name: "add_reaction",
  title: "Add reaction",
  description: "Add an emoji reaction to a post (POST /reactions).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id."),
    emoji_name: z.string().describe("Emoji name without colons (e.g. thumbsup)."),
  }),
  write: true,
  resources: (args) => ({ postId: args.post_id }),
  handler: (args, { session }) =>
    session.call((c) => c.addReaction(session.userId, args.post_id, args.emoji_name)),
});

// ---------------------------------------------------------------------------
// remove_reaction — DELETE /users/{uid}/posts/{pid}/reactions/{emoji}
// ---------------------------------------------------------------------------
const removeReaction = defineTool({
  name: "remove_reaction",
  title: "Remove reaction",
  description:
    "Remove an emoji reaction from a post (DELETE /users/{uid}/posts/{pid}/reactions/{emoji}).",
  inputSchema: z.object({
    post_id: z.string().describe("Post id."),
    emoji_name: z.string().describe("Emoji name without colons (e.g. thumbsup)."),
  }),
  write: true,
  resources: (args) => ({ postId: args.post_id }),
  handler: (args, { session }) =>
    session.call((c) => c.removeReaction(session.userId, args.post_id, args.emoji_name)),
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const messagingTools: AnyToolDef[] = [
  postMessage,
  replyThread,
  getChannelPosts,
  getThread,
  getPost,
  searchPosts,
  editPost,
  deletePost,
  sendDm,
  pinPost,
  unpinPost,
  addReaction,
  removeReaction,
];
