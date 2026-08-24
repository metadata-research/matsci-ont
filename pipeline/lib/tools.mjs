// Locates the pinned Jena tools and Java runtime, downloading and verifying
// them into tools/ on first use. tools/ is not tracked.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const TOOLS_DIR = join(ROOT, "tools");

export async function loadPins() {
  return JSON.parse(await readFile(join(ROOT, "pipeline/tools.json"), "utf8"));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(path, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

// Downloads the tarball if the extracted directory is absent, verifies its
// digest, and extracts it. A digest mismatch is fatal and leaves nothing
// extracted.
async function ensureTarball(name, pin) {
  const directory = join(TOOLS_DIR, pin.directory);
  if (await exists(directory)) return directory;

  await mkdir(TOOLS_DIR, { recursive: true });
  const archive = join(TOOLS_DIR, `${name}-download.tar.gz`);
  process.stderr.write(`fetching ${name} ${pin.version}\n`);
  await download(pin.url, archive);

  const algorithm = pin.sha512 ? "sha512" : "sha256";
  const expected = pin.sha512 ?? pin.sha256;
  const actual = await hashFile(archive, algorithm);
  if (actual !== expected) {
    throw new Error(
      `${name} ${algorithm} mismatch\n  expected ${expected}\n  actual   ${actual}`,
    );
  }

  const result = spawnSync("tar", ["xzf", archive, "-C", TOOLS_DIR], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${name} failed to extract`);
  if (!(await exists(directory))) {
    throw new Error(`${name} extracted without ${pin.directory}`);
  }
  return directory;
}

// Returns the environment the Jena command-line tools need, installing the
// pinned tools on first use.
export async function jenaEnvironment() {
  const pins = await loadPins();
  const javaHome = await ensureTarball("java", pins.java);
  const jenaHome = await ensureTarball("jena", pins.jena);
  return {
    pins,
    javaHome,
    jenaHome,
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      JENA_HOME: jenaHome,
      PATH: `${join(javaHome, "bin")}:${join(jenaHome, "bin")}:${process.env.PATH}`,
    },
  };
}

export async function fusekiHome() {
  const pins = await loadPins();
  await ensureTarball("java", pins.java);
  return ensureTarball("fuseki", pins.fuseki);
}

// Runs a Jena command-line tool. Returns {status, stdout, stderr} and never
// throws on a nonzero exit, so callers decide what a failure means.
export function runJena(environment, tool, args, options = {}) {
  const result = spawnSync(join(environment.jenaHome, "bin", tool), args, {
    env: environment.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    ...options,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
