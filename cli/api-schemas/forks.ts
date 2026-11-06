import { z } from "zod";

const seq = z.number().int().positive();
const pageEdits = z
  .array(z.object({ find: z.string().min(1), replace: z.string() }).strict())
  .min(1);

export const forkRunBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_again"), beforeSeq: seq }).strict(),
  z
    .object({
      kind: z.literal("new_message"),
      beforeSeq: seq,
      message: z.string().trim().min(1).max(20_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mock_page"),
      url: z.url(),
      edits: pageEdits.optional(),
      body: z.string().min(1).optional(),
      contentType: z.string().trim().min(1).optional(),
    })
    .strict()
    .refine((b) => (b.edits ? 1 : 0) + (b.body !== undefined ? 1 : 0) === 1, {
      message: "Pass edits or body, not both",
    }),
]);
export type ForkRunBody = z.infer<typeof forkRunBodySchema>;

export type ForkRunResponse = {
  runId: string;
  sourceRunId: string;
  forkedBefore: number;
  mockId?: string;
  change?: {
    linesBefore: number;
    linesAfter: number;
    retainedPercent: number | null;
    hunks: string;
  };
};

export const runPageQuerySchema = z.object({
  url: z.url(),
  view: z.enum(["text", "raw"]).default("raw"),
  query: z.string().min(1).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(200_000).default(200_000),
});
