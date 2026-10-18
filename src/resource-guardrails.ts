import type { Channel } from "@mattermost/types/channels";
import type { Post, PostSearchResults } from "@mattermost/types/posts";
import type { Team } from "@mattermost/types/teams";
import type { MattermostSession } from "./mattermost/types.js";
import { fetchFileMetadata } from "./mattermost/files.js";
import { GuardrailError, assertChannelAllowed, assertTeamAllowed } from "./guardrails.js";

/** All resource identifiers a tool can target, including indirect references. */
export interface ToolResources {
  teamId?: string;
  channelId?: string;
  postId?: string;
  fileId?: string;
  fileIds?: string[];
  createsChannel?: boolean;
}

export type ResultScope = "teams" | "channels" | "channelItems" | "post" | "posts";

/** Resolve resource IDs only when needed, with a cache limited to one tool call. */
export class ResourceGuard {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly session: MattermostSession) {}

  private get config() {
    return this.session.config.guardrails;
  }

  private async channel(id: string): Promise<Channel> {
    const cached = this.channels.get(id);
    if (cached) return cached;
    const channel = await this.session.call((c) => c.getChannel(id));
    this.channels.set(id, channel);
    return channel;
  }

  private async assertChannel(id: string): Promise<void> {
    assertChannelAllowed(id, this.config);
    if (this.config.teamAllowlist.length > 0) {
      const channel = await this.channel(id);
      assertTeamAllowed(channel.team_id, this.config);
    }
  }

  async assertResources(resources: ToolResources): Promise<void> {
    const { teamId, channelId, postId, fileId, fileIds, createsChannel } = resources;
    if (teamId != null) assertTeamAllowed(teamId, this.config);

    // A newly opened channel cannot be checked before the write. With a channel
    // restriction, callers must target an existing, explicitly allowed channel.
    if (createsChannel && this.config.channelAllowlist.length > 0) {
      throw new GuardrailError(
        "refused: opening or creating channels is disabled under MM_CHANNEL_ALLOWLIST; use an existing allowed channel_id",
      );
    }
    if (createsChannel && teamId == null && this.config.teamAllowlist.length > 0) {
      throw new GuardrailError("refused: direct/group messages have no team in MM_TEAM_ALLOWLIST");
    }
    if (channelId != null) await this.assertChannel(channelId);

    if (this.config.channelAllowlist.length === 0 && this.config.teamAllowlist.length === 0) {
      return;
    }
    if (postId != null) {
      const post = await this.session.call((c) => c.getPost(postId));
      await this.assertChannel(post.channel_id);
    }
    const files = new Set(fileIds ?? []);
    if (fileId != null) files.add(fileId);
    for (const id of files) {
      const file = await this.session.call((c) => fetchFileMetadata(c, id));
      if (file.channel_id) {
        await this.assertChannel(file.channel_id);
      } else if (file.post_id) {
        const post = await this.session.call((c) => c.getPost(file.post_id!));
        await this.assertChannel(post.channel_id);
      } else {
        throw new GuardrailError("refused: cannot resolve the file's channel for the allowlists");
      }
    }
  }

  private teamAllowed(id: string): boolean {
    return this.config.teamAllowlist.length === 0 || this.config.teamAllowlist.includes(id);
  }

  private async channelAllowed(id: string, known?: Channel): Promise<boolean> {
    if (this.config.channelAllowlist.length > 0 && !this.config.channelAllowlist.includes(id)) {
      return false;
    }
    if (this.config.teamAllowlist.length === 0) return true;
    return this.teamAllowed((known ?? (await this.channel(id))).team_id);
  }

  private async sanitizePost(post: Post): Promise<Post> {
    // A permalink preview can embed another channel's complete post. Omit this
    // optional enrichment under allowlists; the original message/link remains.
    const clean = { ...post };
    if (post.metadata?.embeds) {
      clean.metadata = {
        ...post.metadata,
        embeds: post.metadata.embeds.filter((embed) => embed.type !== "permalink"),
      };
    }
    if (post.user_activity_posts) {
      clean.user_activity_posts = [];
      for (const child of post.user_activity_posts) {
        if (await this.channelAllowed(child.channel_id)) {
          clean.user_activity_posts.push(await this.sanitizePost(child));
        }
      }
    }
    return clean;
  }

  /** Collection/search tools must not return data from disallowed resources. */
  async filterResult(scope: ResultScope, result: unknown): Promise<unknown> {
    if (this.config.channelAllowlist.length === 0 && this.config.teamAllowlist.length === 0) {
      return result;
    }
    if (scope === "teams") {
      return (result as Team[]).filter((team) => this.teamAllowed(team.id));
    }
    if (scope === "channels") {
      const allowed: Channel[] = [];
      for (const channel of result as Channel[]) {
        if (await this.channelAllowed(channel.id, channel)) allowed.push(channel);
      }
      return allowed;
    }
    if (scope === "channelItems") {
      const allowed: { channel_id: string }[] = [];
      for (const item of result as { channel_id: string }[]) {
        if (await this.channelAllowed(item.channel_id)) allowed.push(item);
      }
      return allowed;
    }
    if (scope === "post") return this.sanitizePost(result as Post);

    const source = result as PostSearchResults;
    const posts: PostSearchResults["posts"] = {};
    for (const [id, post] of Object.entries(source.posts)) {
      if (await this.channelAllowed(post.channel_id)) posts[id] = await this.sanitizePost(post);
    }
    const includes = (id: string) => Object.hasOwn(posts, id);
    const filtered = Object.keys(posts).length !== Object.keys(source.posts).length;
    return {
      ...source,
      posts,
      order: source.order.filter(includes),
      ...(source.matches
        ? {
            matches: Object.fromEntries(
              Object.entries(source.matches).filter(([id]) => includes(id)),
            ),
          }
        : {}),
      ...(filtered && source.next_post_id != null
        ? { next_post_id: includes(source.next_post_id) ? source.next_post_id : "" }
        : {}),
      ...(filtered && source.prev_post_id != null
        ? { prev_post_id: includes(source.prev_post_id) ? source.prev_post_id : "" }
        : {}),
    };
  }
}
