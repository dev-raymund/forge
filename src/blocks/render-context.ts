/**
 * What a block's renderer is told about the site it is drawn for (M5-5; the
 * public renderer, M5-6, provides it): where an `entry:{id}` link goes now,
 * and which hosts may not be framed (the app's own). Nothing else: a renderer
 * reads no database and no session.
 */
export type BlockRenderContext = {
  resolveEntryHref: (entryId: string) => string | undefined;
  blockedHosts?: readonly string[];
};
