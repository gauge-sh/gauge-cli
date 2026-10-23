import type { Command } from "commander";
import { CliError } from "../lib/client";
import {
  addPageOptions,
  type Category,
  categoryScope,
  chatPath,
  chatScope,
  createChatApiClient,
  fetchPages,
  type Organization,
  type Page,
  type PageOptions,
  printPage,
  resolveChatOrg,
  resolveTagIds,
  resolveTopicId,
  withCategory,
} from "../lib/chatApi";
import { readConfig, updateConfig } from "../lib/config";
import { confirmOrAbort } from "../lib/confirm";
import { resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { registerData } from "./chatData";
import { registerPrompts } from "./chatPrompts";
import { registerQuery } from "./chatQuery";

type Topic = {
  id: string;
  slug: string;
  title: string;
  promptCount: number;
  createdAt: string;
};
type Tag = { id: string; name: string; color: string; promptCount: number };
type Brand = {
  id: string;
  name: string;
  slug: string;
  website: string;
  role: "owned" | "competitor";
};

function done(cmd: Command, value: unknown, text: string): void {
  if (resolveOutput(cmd) === "json") printJson(value);
  else console.log(text);
}

function registerWhoami(chat: Command): void {
  chat
    .command("whoami")
    .description(
      "Show the signed-in user and the token's kind, scopes and expiry",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const me = await createChatApiClient().me();
      if (resolveOutput(cmd) === "json") return printJson(me);
      console.log(`User: ${me.user.email || me.user.id} (${me.user.name})`);
      console.log(
        `Token: ${me.token.kind}; scopes ${me.token.scopes.join(", ") || "(none)"}; expires ${me.token.expiresAt}`,
      );
    });
}

function registerOrgs(chat: Command): void {
  const orgs = chat
    .command("orgs")
    .description("Organizations with Gauge Chat that you belong to");
  orgs
    .command("list", { isDefault: true })
    .description("List organizations (* marks the chatOrg default)")
    .action(async (_opts: unknown, cmd: Command) => {
      const { data } = await createChatApiClient().get<Page<Organization>>(
        chatPath("orgs"),
      );
      const { chatOrg } = readConfig();
      const rows = data.map((org) => ({
        ...org,
        isDefault: chatOrg === org.slug || chatOrg === org.id,
      }));
      if (resolveOutput(cmd) === "json") return printJson({ data: rows });
      printItems(
        rows.map(({ isDefault, ...org }) => ({
          default: isDefault ? "*" : "",
          ...org,
        })),
        "table",
      );
    });
  orgs
    .command("use <org>")
    .description("Set the default Chat organization (slug or id)")
    .action(async (org: string, _opts: unknown, cmd: Command) => {
      const found = await createChatApiClient().get<Organization>(
        chatPath("orgs", org),
      );
      const { chatOrg, chatCategory } = readConfig();
      const changed = chatOrg !== found.slug;
      updateConfig({
        chatOrg: found.slug,
        chatCategory: changed ? undefined : chatCategory,
      });
      done(
        cmd,
        { chatOrg: found.slug },
        `Default Chat organization: ${found.slug}${changed && chatCategory ? " (default category cleared)" : ""}`,
      );
    });
}

function registerCategories(chat: Command): void {
  const categories = chat
    .command("categories")
    .description("Categories (markets) your organization tracks");
  categories
    .command("list", { isDefault: true })
    .description("List categories (* marks the chatCategory default)")
    .action(async (_opts: unknown, cmd: Command) => {
      const { client, org } = await chatScope(cmd);
      const { data } = await client.get<Page<Category>>(
        chatPath("orgs", org, "categories"),
      );
      const { chatOrg, chatCategory } = readConfig();
      const isDefault = (c: Category) =>
        org === chatOrg && (chatCategory === c.slug || chatCategory === c.id);
      if (resolveOutput(cmd) === "json")
        return printJson({
          data: data.map((c) => ({ ...c, isDefault: isDefault(c) })),
        });
      printItems(
        data.map((c) => ({
          default: isDefault(c) ? "*" : "",
          id: c.id,
          slug: c.slug,
          name: c.name,
        })),
        "table",
      );
    });
  categories
    .command("use <category>")
    .description(
      "Set the default category (slug or id); also pins the org as chatOrg",
    )
    .action(async (category: string, _opts: unknown, cmd: Command) => {
      const client = createChatApiClient();
      const org = await resolveChatOrg(cmd, client);
      const found = await client.get<Category>(
        chatPath("orgs", org, "categories", category),
      );
      updateConfig({ chatOrg: org, chatCategory: found.slug });
      done(
        cmd,
        { chatOrg: org, chatCategory: found.slug },
        `Default Chat category: ${found.slug} (org ${org})`,
      );
    });
}

function registerTopics(chat: Command): void {
  const topics = chat
    .command("topics")
    .description("Topics group a category's prompts");
  addPageOptions(
    withCategory(
      topics.command("list", { isDefault: true }).description("List topics"),
    ),
  ).action(async (opts: PageOptions, cmd: Command) => {
    const scope = await categoryScope(cmd);
    const page = await fetchPages<Topic>(
      scope.client,
      chatPath(...scope.base, "topics"),
      {},
      opts,
    );
    printPage(page, resolveOutput(cmd), (t) => ({
      id: t.id,
      title: t.title,
      slug: t.slug,
      prompts: t.promptCount,
    }));
  });
  withCategory(topics.command("create <title>"))
    .description(
      "Create a topic; exits 0 with the existing topic when the title already exists (--if-exists)",
    )
    .option("--if-exists", "return the existing topic instead of failing")
    .action(
      async (title: string, opts: { ifExists?: boolean }, cmd: Command) => {
        const scope = await categoryScope(cmd);
        try {
          const topic = await scope.client.post<Topic>(
            chatPath(...scope.base, "topics"),
            { title },
          );
          done(cmd, topic, `Created topic ${topic.id} (${topic.title})`);
        } catch (error) {
          const id =
            error instanceof CliError && error.apiCode === "already_exists"
              ? error.details?.id
              : undefined;
          if (!opts.ifExists || typeof id !== "string") throw error;
          const topic = await scope.client.get<Topic>(
            chatPath(...scope.base, "topics", id),
          );
          done(
            cmd,
            topic,
            `Topic already exists: ${topic.id} (${topic.title})`,
          );
        }
      },
    );
  withCategory(topics.command("rename <topic> <title>"))
    .description("Rename a topic (id, slug, or title); its slug follows")
    .action(
      async (topic: string, title: string, _opts: unknown, cmd: Command) => {
        const scope = await categoryScope(cmd);
        const id = await resolveTopicId(scope, topic);
        const updated = await scope.client.patch<Topic>(
          chatPath(...scope.base, "topics", id),
          { title },
        );
        done(cmd, updated, `Renamed topic ${updated.id} to ${updated.title}`);
      },
    );
  withCategory(topics.command("delete <topic>"))
    .alias("rm")
    .description(
      "Delete a topic and all of its prompts and answers (runs in the background)",
    )
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (topic: string, opts: { yes?: boolean }, cmd: Command) => {
      const scope = await categoryScope(cmd);
      const id = await resolveTopicId(scope, topic);
      await confirmOrAbort(
        `Delete topic ${id} and every prompt in it?`,
        opts.yes,
      );
      const accepted = await scope.client.delete<{
        id: string;
        status: string;
      }>(chatPath(...scope.base, "topics", id));
      done(cmd, accepted, `Deleting topic ${id} (${accepted.status})`);
    });
}

function registerTags(chat: Command): void {
  const tags = chat.command("tags").description("Organization prompt tags");
  tags
    .command("list", { isDefault: true })
    .description("List tags")
    .action(async (_opts: unknown, cmd: Command) => {
      const { client, org } = await chatScope(cmd);
      const page = await client.get<Page<Tag>>(chatPath("orgs", org, "tags"));
      printPage(page, resolveOutput(cmd), (t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        prompts: t.promptCount,
      }));
    });
  tags
    .command("create <name>")
    .alias("add")
    .description("Create a tag")
    .option("--color <color>", "tag color")
    .action(async (name: string, opts: { color?: string }, cmd: Command) => {
      const { client, org } = await chatScope(cmd);
      const tag = await client.post<Tag>(chatPath("orgs", org, "tags"), {
        name,
        ...(opts.color ? { color: opts.color } : {}),
      });
      done(cmd, tag, `Created tag ${tag.id} (${tag.name})`);
    });
  tags
    .command("rename <tag> <name>")
    .description("Rename a tag (id or current name)")
    .option("--color <color>", "also change the color")
    .action(
      async (
        tag: string,
        name: string,
        opts: { color?: string },
        cmd: Command,
      ) => {
        const scope = await chatScope(cmd);
        const [id] = await resolveTagIds(scope, [tag]);
        const updated = await scope.client.patch<Tag>(
          chatPath("orgs", scope.org, "tags", id),
          { name, ...(opts.color ? { color: opts.color } : {}) },
        );
        done(cmd, updated, `Renamed tag ${updated.id} to ${updated.name}`);
      },
    );
  tags
    .command("delete <tag>")
    .alias("rm")
    .description("Delete a tag (id or name); prompts keep existing")
    .action(async (tag: string, _opts: unknown, cmd: Command) => {
      const scope = await chatScope(cmd);
      const [id] = await resolveTagIds(scope, [tag]);
      await scope.client.delete(chatPath("orgs", scope.org, "tags", id));
      done(cmd, { id, deleted: true }, `Deleted tag ${id}`);
    });
}

function registerBrands(chat: Command): void {
  withCategory(chat.command("brands"))
    .description("Owned and competitor brands tracked in the category")
    .action(async (_opts: unknown, cmd: Command) => {
      const scope = await categoryScope(cmd);
      const page = await scope.client.get<Page<Brand>>(
        chatPath(...scope.base, "brands"),
      );
      printPage(page, resolveOutput(cmd), (b) => ({
        id: b.id,
        role: b.role,
        name: b.name,
        website: b.website,
      }));
    });
}

export function register(program: Command): void {
  const chat = program
    .command("chat")
    .description(
      "Gauge Chat AI visibility: prompts, topics, tags, answers, citations, queries, exports",
    )
    .addHelpText(
      "after",
      `
Category-scoped commands take --category (slug or cat_ id; default: chatCategory
config, else the org's only category). Uses the Gauge Chat API on the Chat origin (authUrl). Authenticate with
\`gauge auth login\`, or set GAUGE_API_TOKEN to a personal access token
(gauge_pat_…). --org takes a slug or id (default: chatOrg config, else your
only Chat org). Pass -o json for machine-readable output; errors carry the
API error code. Exit codes: 0 ok, 1 error, 2 invalid request, 3 plan limit,
5 rerun (credentials busy).`,
    );
  registerWhoami(chat);
  registerOrgs(chat);
  registerCategories(chat);
  registerTopics(chat);
  registerPrompts(chat);
  registerTags(chat);
  registerBrands(chat);
  registerQuery(chat);
  registerData(chat);
}
