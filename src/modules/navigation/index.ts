import "server-only";

/**
 * Public server API of the navigation module (M8-3; plan §7; ADR 0030): a site's header and footer menus, edited as
 * a whole on `/…/menus`. The public site reads them itself (rendering's `loadMenus`), through `./shared`.
 */
export { getMenus, MENU_CONFLICT, saveMenu } from "./menus.service";
export type { MenuSave, MenusForEditor } from "./menus.service";
export { submitSaveMenu } from "./menu-forms";
export { canManageMenus } from "./policies";
export { siteMenusPath } from "./paths";
export { MenuEditor } from "./ui/menu-editor";
