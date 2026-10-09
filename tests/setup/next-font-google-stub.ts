/**
 * `next/font/google` outside Next: its loaders exist only once Next's compiler
 * has rewritten the call. Tests get the same shape back (a class that defines
 * the font's CSS variable), and no font is fetched.
 */
type Options = { variable?: string };
const loader = (name: string) => (options: Options = {}) => ({
  className: `font-stub-${name}`,
  variable: `font-stub-${name}-variable`,
  style: { fontFamily: `'${name}'` },
  options,
});

export const Inter = loader("Inter");
export const DM_Sans = loader("DM Sans");
export const Manrope = loader("Manrope");
export const Source_Sans_3 = loader("Source Sans 3");
export const Work_Sans = loader("Work Sans");
export const Fraunces = loader("Fraunces");
export const Literata = loader("Literata");
export const Lora = loader("Lora");
export const Playfair_Display = loader("Playfair Display");
export const Source_Serif_4 = loader("Source Serif 4");
