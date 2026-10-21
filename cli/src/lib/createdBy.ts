import type { CreatedBy } from "@withgauge/api-schemas";
import type { MeResponse } from "@withgauge/api-schemas/me";
import { createClient } from "./client";

/** Name, else email, else `--`. Absent (older server) reads as unknown. */
export function creatorLabel(createdBy: CreatedBy): string {
  return createdBy?.name || createdBy?.email || "--";
}

/** Client-side `--created-by <email|me>` filter; the server lists are unpaginated. */
export async function filterByCreator<T extends { createdBy?: CreatedBy }>(
  items: T[],
  createdBy: string | undefined,
): Promise<T[]> {
  if (createdBy === undefined) return items;
  const wanted = createdBy.trim().toLowerCase();
  if (wanted === "me") {
    const { user } = await createClient().get<MeResponse>("/api/v1/me");
    const email = user.email?.toLowerCase();
    return items.filter(
      (item) =>
        item.createdBy?.userId === user.id ||
        (email !== undefined && item.createdBy?.email?.toLowerCase() === email),
    );
  }
  return items.filter(
    (item) => item.createdBy?.email?.toLowerCase() === wanted,
  );
}
