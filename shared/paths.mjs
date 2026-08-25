// Where the repository is, and the directories both layers address.
//
// The build writes into these and the application reads from them, so the
// paths belong to neither layer alone.

import { join } from "node:path"

export const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

export const TOOLS_DIR = join(ROOT, "tools")
export const BUILD_DIR = join(ROOT, "build")
export const CACHE_DIR = join(ROOT, "cache")
export const MIRROR_DIR = join(CACHE_DIR, "mirror")
export const MANIFEST_DIR = join(ROOT, "manifest")
export const STORE = join(BUILD_DIR, "tdb2")
export const STAGING = join(BUILD_DIR, "tdb2.new")
