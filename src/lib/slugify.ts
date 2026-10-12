/**
 * Text → slug: lowercase ASCII letters and digits in hyphen-separated groups
 * ("Über uns & Kontakt!" → "uber-uns-and-kontakt"). Pure and client-safe
 * (plan §18: `lib/` holds small pure helpers).
 *
 * Accents are dropped, a few letters that have no decomposition are spelled
 * out (ß → ss, æ → ae, ø → o, …), `&` becomes "and", and everything else that
 * is not a letter or digit separates words. Scripts with no Latin spelling
 * (中文, Ελληνικά, …) produce nothing: the caller decides what an empty slug
 * becomes. The result is at most `maxLength` characters and never ends with a
 * hyphen.
 */

const SPELLED: Readonly<Record<string, string>> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", þ: "th", ł: "l", ı: "i" };

export function slugify(text: string, maxLength: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[ßæœøđðþłı]/g, (letter) => SPELLED[letter] ?? letter)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, Math.max(0, maxLength)).replace(/-+$/g, "");
}
