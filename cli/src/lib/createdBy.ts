import type { CreatedBy } from "@withgauge/api-schemas";
import type { MeResponse } from "@withgauge/api-schemas/me";
import type { RunTriggeredBy } from "@withgauge/api-schemas/runs";
import { createClient } from "./client";

export function creatorLabel(createdBy: CreatedBy): string {
  return createdBy?.name || createdBy?.email || "--";
}

export function triggeredByLabel(t: RunTriggeredBy | null | undefined): string {
  if (!t) return "";
  return t.email ? `${t.source} (${t.email})` : t.source;
}

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
