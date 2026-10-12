import { atomBlock } from "../node-html";
import { embed } from "./schema";

export const EmbedNode = atomBlock("embed", { provider: null, url: null, ...embed.defaults });
