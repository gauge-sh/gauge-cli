export type CliOptionOccurrence = {
  index: number;
  width: 1 | 2;
  value?: string;
};
export type CliParsedArguments = {
  positionals: string[];
  options: Map<string, CliOptionOccurrence>;
  endOptions: number;
};
export type CliParseResult =
  | { kind: "parsed"; value: CliParsedArguments }
  | {
      kind: "ambiguous";
      reason: "unknown_option" | "missing_value" | "unexpected_value";
    };

export function parseCliRuleArguments(
  argv: readonly string[],
  arity: Readonly<Record<string, 0 | 1>>,
): CliParseResult {
  const value: CliParsedArguments = {
    positionals: [],
    options: new Map(),
    endOptions: argv.length,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      value.endOptions = i;
      value.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      value.positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (
      !Object.hasOwn(arity, flag) ||
      (!flag.startsWith("--") && flag.length !== 2)
    )
      return { kind: "ambiguous", reason: "unknown_option" };
    if (arity[flag] === 0) {
      if (equal >= 0) return { kind: "ambiguous", reason: "unexpected_value" };
      value.options.set(flag, { index: i, width: 1 });
    } else if (equal >= 0) {
      value.options.set(flag, {
        index: i,
        width: 1,
        value: token.slice(equal + 1),
      });
    } else {
      if (i + 1 === argv.length || argv[i + 1] === "--")
        return { kind: "ambiguous", reason: "missing_value" };
      value.options.set(flag, { index: i, width: 2, value: argv[i + 1] });
      i++;
    }
  }
  return { kind: "parsed", value };
}
