import type { Command } from "commander";
import { gaugeState } from "../lib/gaugeState";
import {
  instructions,
  isTopic,
  topicForCommand,
  TOPIC_NAMES,
} from "../instructions";

export function register(program: Command): void {
  program
    .command("instructions [topic]")
    .description(
      `Instructions for a coding agent using this CLI. Run before your first gauge command; a topic loads the full workflow guidance: ${TOPIC_NAMES.join(", ")}. Topics are workflows, not a page per command: run \`gauge <command> -h\` for flags`,
    )
    .option("--list", "print the topic names only")
    .action(
      (
        requested: string | undefined,
        opts: { list?: boolean },
        cmd: Command,
      ) => {
        if (opts.list) {
          for (const name of TOPIC_NAMES) console.log(name);
          return;
        }
        const name = requested?.trim().toLowerCase();
        const command =
          name && !isTopic(name)
            ? cmd.parent?.commands.find(
                (c) => c.name() === name || c.aliases().includes(name),
              )
            : undefined;
        const topic = (command && topicForCommand(command.name())) ?? requested;
        if (command && topic === requested) {
          const help = `gauge ${command.name()} -h`;
          process.stdout.write(
            `"${command.name()}" is a command, not an instructions topic. Topics: ${TOPIC_NAMES.join(", ")}. Its help (\`${help}\`):\n${command.helpInformation()}`,
          );
          return;
        }
        process.stdout.write(instructions(topic, gaugeState(cmd)));
      },
    );
}
