import { serializeJsonLd } from "@/modules/seo/shared";

/**
 * A page's structured data (M8-4): `<script type="application/ld+json">`. React writes a script's text as it is, so
 * the JSON is serialised with `<`, `>` and `&` escaped (`serializeJsonLd`): no value, however it was typed, can close
 * the script or open a tag. No `dangerouslySetInnerHTML`.
 */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json">{serializeJsonLd(data)}</script>;
}
