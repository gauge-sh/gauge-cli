import { z } from "zod";

export const personaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Persona = z.infer<typeof personaSchema>;

export const listPersonasResponseSchema = z.object({
  items: z.array(personaSchema),
});
export type ListPersonasResponse = z.infer<typeof listPersonasResponseSchema>;

export const createPersonaBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1),
});
export type CreatePersonaBody = z.infer<typeof createPersonaBodySchema>;

export const updatePersonaBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).optional(),
});
export type UpdatePersonaBody = z.infer<typeof updatePersonaBodySchema>;
