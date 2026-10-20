export type OutputFormat = "table" | "json";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["table", "json"];

export function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0";
  return (
    stream.isTTY === true &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb"
  );
}

export function style(
  code: string,
  stream: NodeJS.WriteStream = process.stdout,
): (text: string) => string {
  const on = colorEnabled(stream);
  return (text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export type Column<T> = {
  key: keyof T & string;
  header?: string;
};

export function printItems<T extends Record<string, unknown>>(
  items: T[],
  format: OutputFormat,
  columns?: Column<T>[],
): void {
  if (format === "json") {
    printJson(items);
    return;
  }
  if (items.length === 0) {
    console.log("(no results)");
    return;
  }

  const cols: Column<T>[] =
    columns ??
    (Object.keys(items[0]) as Array<keyof T & string>).map((key) => ({ key }));
  const headers = cols.map((col) => col.header ?? col.key);
  const rows = items.map((item) => cols.map((col) => cell(item[col.key])));
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );

  const line = (values: string[]) =>
    values
      .map((value, i) => value.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
