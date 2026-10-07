import { z } from "zod";
import { fieldErrorsFrom, validationError } from "@/platform/errors";
import { ASSIGNABLE_ROLES } from "./invitation-rules";
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

/** One spelling of an address: trimmed, lowercased, and shaped like one. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter an email address.")
  .max(254, "Enter a valid email address.")
  .pipe(z.email("Enter a valid email address."));

/** A role that can be given from the members page or by invitation: never Owner (./invitation-rules.ts). */
const assignableRole = z.enum(ASSIGNABLE_ROLES, "Choose a role.");

export const inviteMemberSchema = z.object({ email, role: assignableRole });
export const changeMemberRoleSchema = z.object({ role: assignableRole });

export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

/** Parses service input with one of the schemas above, or throws `Validation` with the messages by field. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(fieldErrorsFrom(result.error));
  return result.data;
}
