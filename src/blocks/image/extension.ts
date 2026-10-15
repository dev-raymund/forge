import { atomBlock } from "../node-html";
import { image } from "./schema";

export const ImageNode = atomBlock("image", { mediaId: null, ...image.defaults });
