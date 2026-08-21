import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

/** Published package version shown in server metadata responses. */
export const SERVER_VERSION = typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";
