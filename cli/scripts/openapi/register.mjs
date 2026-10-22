// Registers hooks.mjs so the API's modules load under Node, outside workerd.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
