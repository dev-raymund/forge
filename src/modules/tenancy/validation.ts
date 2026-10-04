import { z } from "zod";
import { checkOrgSlug } from "./slugs";

/** Zod schemas of the tenancy module, shared by forms (M3-3) and services. */

const name = z.string().trim().min(1, "Enter a name for the organization.").max(80, "Use at most 80 characters.");

/** Trimmed, lowercased, and held to the slug rules (./slugs.ts). */
const slug = z.string().transform((value, ctx) => {
  const checked = checkOrgSlug(value);
  if (checked.ok) return checked.slug;
  ctx.addIssue({ code: "custom", message: checked.message });
  return z.NEVER;
});

export const createOrganizationSchema = z.object({ name, slug });
export const updateOrganizationSchema = z
  .object({ name: name.optional(), slug: slug.optional() })
  .refine((value) => value.name !== undefined || value.slug !== undefined, { message: "Nothing to change." });

export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;
