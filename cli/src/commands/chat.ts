import { type Command, Help, type Option } from "commander";
import { CliError } from "../lib/client";
import {
  addPageOptions,
  type Category,
  categoryScope,
  chatPath,
  chatScope,
  fetchPages,
  type Page,
  type PageOptions,
  printPage,
  resolveTagIds,
  resolveTopicId,
  withCategory,
} from "../lib/chatApi";
import { readConfig, updateConfig } from "../lib/config";
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

function registerCategories(chat: Command): void {
  const categories = chat
    .command("categories")
    .description("Categories (markets) your organization tracks");
  categories
    .command("list", { isDefault: true })
    .description("List categories (* marks the chatCategory default)")
    .action(async (_opts: unknown, cmd: Command) => {
      const { client, org, chatOrg } = await chatScope(cmd);
      const { data } = await client.get<Page<Category>>(
        chatPath("orgs", org, "categories"),
      );
      const { chatCategory, chatCategoryOrg } = readConfig();
      const applies = chatCategoryOrg
        ? chatCategoryOrg === org
        : chatOrg.source === "config";
      const isDefault = (c: Category) =>
        applies && (chatCategory === c.slug || chatCategory === c.id);
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
      "Set the default category (slug or id) for the selected organization",
    )
    .action(async (category: string, _opts: unknown, cmd: Command) => {
      const { client, org, chatOrg } = await chatScope(cmd);
      const found = await client.get<Category>(
        chatPath("orgs", org, "categories", category),
      );
      updateConfig({ chatCategory: found.slug, chatCategoryOrg: org });
      done(
        cmd,
        { org, chatCategory: found.slug },
        `Default Chat category: ${found.slug} (org ${chatOrg.name ?? org})`,
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
    .description("Delete a tag (id or name); prompts are kept")
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

const CHAT_ORG_HELP =
  "organization slug or id (default: gauge.json orgId, then your saved default, else your only Chat org; an org API key implies its org)";

// Configure help before registering subcommands so they inherit these overrides.
function scopeGlobalOptions(program: Command, chat: Command): void {
  const isAgentsOnly = (option: Option) =>
    option.long === "--local" || option.long === "--hosted";
  chat.configureHelp({
    ...program.configureHelp(),
    visibleGlobalOptions(cmd: Command) {
      return Help.prototype.visibleGlobalOptions
        .call(this, cmd)
        .filter((option) => !isAgentsOnly(option));
    },
    optionDescription(option: Option) {
      return option.long === "--org" && program.options.includes(option)
        ? CHAT_ORG_HELP
        : Help.prototype.optionDescription.call(this, option);
    },
  });
  chat.hook("preAction", () => {
    const flag = program.options.find(
      (option) =>
        isAgentsOnly(option) &&
        program.getOptionValueSource(option.attributeName()) === "cli",
    );
    if (flag)
      throw new CliError(
        "usage",
        `${flag.long} applies only to Agents commands; gauge chat always uses the hosted Chat API. Remove ${flag.long}.`,
      );
  });
}

export function register(program: Command): void {
  const chat = program
    .command("chat")
    .description(
      "Gauge Chat AI visibility: prompts, topics, tags, answers, citations, queries",
    )
    .addHelpText(
      "after",
      `
Category-scoped commands take --category (slug or cat_ id; default: chatCategory
config, else the org's only category). Authenticate with \`gauge auth login\`,
or for scripts set GAUGE_API_TOKEN to an org API key (gauge_sk_…, created in
Settings → API Keys); GAUGE_API_TOKEN takes precedence over a login. --org takes
a slug or id and selects the same organization as Agents commands (default:
gauge.json orgId, then your saved default from \`gauge orgs use\`, else your only Chat org);
an org API key implies its own org, and --org may pick one of an agency key's
clients. Pass -o json for
machine-readable output; errors carry the API error code. Exit codes: 0 ok,
1 error, 2 invalid request, 3 plan limit.
Rate limits per token and organization: 600 requests/min, 60 queries/min.`,
    );
  scopeGlobalOptions(program, chat);
  registerCategories(chat);
  registerTopics(chat);
  registerPrompts(chat);
  registerTags(chat);
  registerBrands(chat);
  registerQuery(chat);
  registerData(chat);
}
