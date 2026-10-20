import { feedback } from "@withgauge/api-schemas";
import { type Command, Option } from "commander";
import { createClient } from "../lib/client";
import { readConfig } from "../lib/config";
import { resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";

export function register(program: Command): void {
  program
    .command("feedback")
    .description(
      "Send feedback about this CLI to the Gauge team: friction you hit, missing commands or flags, bugs",
    )
    .requiredOption("-m, --message <text>", "what happened")
    .addOption(
      new Option("--kind <kind>", "feedback type")
        .choices([...feedback.FEEDBACK_KINDS])
        .default("other"),
    )
    .option("--command <command>", "the gauge command the feedback is about")
    .action(
      async (
        opts: {
          message: string;
          kind: feedback.FeedbackKind;
          command?: string;
        },
        cmd: Command,
      ) => {
        const { org } = cmd.optsWithGlobals<{ org?: string }>();
        const client = createClient({ authOptional: true });
        const body: feedback.CreateFeedbackBody = {
          message: opts.message,
          kind: opts.kind,
          command: opts.command,
          org: client.signedIn ? (org ?? readConfig().defaultOrg) : undefined,
        };
        const res = await client.post<feedback.CreateFeedbackResponse>(
          "/api/v1/feedback",
          body,
        );
        if (resolveOutput(cmd) === "json") printJson(res);
        else
          console.log(
            `Feedback sent (${res.id}${client.signedIn ? "" : ", anonymous"}). Thank you.`,
          );
      },
    );
}
