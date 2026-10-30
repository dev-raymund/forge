import { z } from "zod";
import { fieldErrorsFrom, validationError } from "@/platform/errors";
import { REDIRECT_PATH_MAX, REDIRECT_STATUSES, REDIRECT_URL_MAX, type RedirectStatus } from "./redirects";

/**
 * What the redirects page sends (M8-5): the shapes only. The addresses' own rules (decoding, reserved paths, what the
 * site serves, loops) are the service's (./redirects.ts, ./redirects.service.ts), so each refusal says which rule.
 */

const address = (max: number) => z.string().max(max * 3, `Use at most ${max} characters.`);
const status = z.coerce
  .number("Choose a status code.")
  .refine((value): value is RedirectStatus => (REDIRECT_STATUSES as readonly number[]).includes(value), "Choose 301, 302, 307 or 308.");

export const createRedirectSchema = z.strictObject({
  source: address(REDIRECT_PATH_MAX),
  destination: address(REDIRECT_URL_MAX),
  statusCode: status,
});
export type CreateRedirectInput = z.input<typeof createRedirectSchema>;

export const updateRedirectSchema = z.strictObject({
  destination: address(REDIRECT_URL_MAX).optional(),
  statusCode: status.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateRedirectInput = z.input<typeof updateRedirectSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Input → its schema's output, or `Validation` with each field's messages (as in the other modules). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(fieldErrorsFrom(result.error));
  return result.data;
}
