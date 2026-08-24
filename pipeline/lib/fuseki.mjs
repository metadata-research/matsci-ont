// Starts a local Fuseki over the built store and waits until it answers.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, fusekiHome, loadPins } from "./tools.mjs";

const TEMPLATE = join(ROOT, "deploy/fuseki/matsci-ont-dev.ttl.template");

export async function writeConfig(storeLocation) {
  const template = await readFile(TEMPLATE, "utf8");
  await mkdir(join(ROOT, "build"), { recursive: true });
  const path = join(ROOT, "build/fuseki-config.ttl");
  await writeFile(path, template.replace("@@LOCATION@@", storeLocation));
  return path;
}

// Port 3030 is the local MatSci-SAM development store on a workstation that
// runs both, so MatSci-ONT takes the next port. In production the two are one
// Fuseki process serving two datasets, and neither takes a second port.
export const DEFAULT_PORT = Number(process.env.MATSCI_ONT_FUSEKI_PORT ?? 3031);

// Resolves once the server answers, or rejects after the timeout. The child
// is returned so the caller can stop it.
export async function startFuseki({ storeLocation, port = DEFAULT_PORT, timeoutMs = 90000 }) {
  const pins = await loadPins();
  const home = await fusekiHome();
  const javaHome = join(ROOT, "tools", pins.java.directory);
  const config = await writeConfig(storeLocation);

  const child = spawn(
    join(javaHome, "bin", "java"),
    ["-Xmx1g", "-jar", join(home, "fuseki-server.jar"), `--port=${port}`, `--config=${config}`],
    {
      env: {
        ...process.env,
        JAVA_HOME: javaHome,
        FUSEKI_BASE: join(ROOT, "build/fuseki-base"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));

  const base = `http://localhost:${port}/matsci-ont`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fuseki exited with ${child.exitCode}\n${log.join("")}`);
    }
    try {
      const response = await fetch(`${base}/query?query=${encodeURIComponent("ASK {}")}`, {
        headers: { Accept: "application/sparql-results+json" },
      });
      if (response.ok) return { child, base, log };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error(`fuseki did not answer within ${timeoutMs} ms\n${log.join("")}`);
}

export async function query(base, sparql, accept = "application/sparql-results+json") {
  const response = await fetch(`${base}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-query", Accept: accept },
    body: sparql,
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

export async function stopFuseki(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await new Promise((resolve) => {
    server.child.once("exit", resolve);
    setTimeout(resolve, 10000);
  });
}
