import type { ListResponse } from "@withgauge/api-schemas";
import type { ApiClient, Query } from "./client";

export async function fetchAllPages<T>(
  client: ApiClient,
  path: string,
  query: Query = {},
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.get<ListResponse<T>>(path, {
      limit: 200,
      ...query,
      cursor,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
