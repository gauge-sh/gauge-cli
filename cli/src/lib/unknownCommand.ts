import type { Command } from "commander";

type WithUnknownCommand = Command & { unknownCommand(): never };

export function rejectUnknownCommandHelp(program: Command): void {
  program.on("beforeAllHelp", ({ command }: { command: Command }) => {
    const [name] = command.args;
    if (
      name === undefined ||
      name.startsWith("-") ||
      command.commands.length === 0 ||
      command.registeredArguments.length > 0 ||
      command.commands.some(
        (sub) => sub.name() === name || sub.aliases().includes(name),
      )
    )
      return;
    (command as WithUnknownCommand).unknownCommand();
  });
}
