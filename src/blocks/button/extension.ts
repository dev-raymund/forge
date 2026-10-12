import { atomBlock } from "../node-html";
import { button } from "./schema";

export const ButtonNode = atomBlock("button", { label: null, href: null, ...button.defaults });
