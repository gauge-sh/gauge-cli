import { z } from "zod";

const repoName = z.string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)
  .refine(name => !/\/(?:\.|\.\.)$|\.git$/i.test(name));

export const repoNamesSchema = z.array(repoName).max(100);

export const repoExampleSchema = z.strictObject({
  url: z.url(),
  languages: z.array(z.string().min(1)),
  commitCount: z.number().int().min(20),
  readme: z.string().min(1),
  languageBytes: z.record(z.string(), z.number().nonnegative()).optional(),
  defaultBranch: z.string().min(1).optional(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
});

export type RepoExample = z.infer<typeof repoExampleSchema>;
