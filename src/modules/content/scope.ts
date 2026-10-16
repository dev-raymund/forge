/**
 * The organization and the site a content operation works in (M7-2): a member's resolved `SiteContext`, or, for the
 * scheduled publish job, the ids it reads from the entry's own row in its organization's tenant transaction. The
 * helpers that only scope their queries (paths, references, terms, the tree) take this; anything that decides who
 * may do what still takes a `SiteContext`.
 */
export type SiteScope = { readonly org: { readonly id: string }; readonly site: { readonly id: string } };
