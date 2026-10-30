import "server-only";

/**
 * Public server API of the seo module's redirects (M8-5; plan §10, §19 `/…/seo/redirects`; ADR 0032). The rules are
 * client-safe in `./shared` (with M8-4's SEO resolver); the services, the forms and the redirects page are here.
 * Content changes call `redirectPathChanges` (and the reading settings `redirectBlogPath`) inside their own
 * transactions; the public site reads the redirect map itself (rendering's `loadRedirects`).
 */
export {
  createRedirect, deleteRedirect, getRedirects, NO_REDIRECT_CHANGES, redirectBlogPath, redirectEvents, redirectPathChanges, REDIRECTS_PAGE_SIZE, redirectUnpublished,
  setNotFoundPage, turnedOffNotice, updateRedirect,
} from "./redirects.service";
export type { RedirectChanges, RedirectNotice, RedirectSaved, RedirectsView, RedirectView } from "./redirects.service";
export { submitCreateRedirect, submitDeleteRedirect, submitSetNotFoundPage, submitUpdateRedirect } from "./redirect-forms";
export { canManageRedirects } from "./policies";
export { siteRedirectsPath } from "./paths";
export { RedirectsManager } from "./ui/redirects-manager";
export { NotFoundPageForm } from "./ui/not-found-page-form";
