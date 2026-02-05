import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

type StartedServer = {
  baseUrl: string;
  dataDir: string;
  codexHomeDir: string;
  distDir: string;
  stop: () => Promise<void>;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve((addr as net.AddressInfo).port));
    });
  });
}

async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      const text = await res.text().catch(() => "");
      if (res.ok && text.trim() === "ok") return;
      lastError = `unexpected /healthz response: ${res.status} ${text}`;
    } catch (e) {
      lastError = String(e);
    }
    await sleep(150);
  }
  throw new Error(`server not ready at ${baseUrl} (${lastError})`);
}

async function writeWarpSession(params: {
  dataDir: string;
  id: string;
  title: string;
  cwd: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  prompt: string;
  assistant: string;
  conclusion: string;
}): Promise<void> {
  const sessionDir = path.join(params.dataDir, "sessions", params.id);
  await mkdir(sessionDir, { recursive: true });

  const eventsPath = path.join(sessionDir, "events.jsonl");
  const stderrPath = path.join(sessionDir, "stderr.log");
  const conclusionPath = path.join(sessionDir, "conclusion.md");
  const metaPath = path.join(sessionDir, "meta.json");

  const promptEvent = {
    type: "app.prompt",
    prompt: params.prompt,
    _ts_ms: params.createdAtMs + 1,
  };
  const assistantEvent = {
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "agent-1", text: params.assistant } },
    _ts_ms: params.createdAtMs + 2,
  };
  await writeFile(eventsPath, `${JSON.stringify(promptEvent)}\n${JSON.stringify(assistantEvent)}\n`);
  await writeFile(stderrPath, "");
  await writeFile(conclusionPath, params.conclusion);

  const meta = {
    id: params.id,
    title: params.title,
    created_at_ms: params.createdAtMs,
    last_used_at_ms: params.lastUsedAtMs,
    cwd: params.cwd,
    status: "done",
    codex_session_id: null,
    context_window: null,
    context_used_tokens: null,
    context_left_pct: null,
    events_path: eventsPath,
    stderr_path: stderrPath,
    conclusion_path: conclusionPath,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

function resolveServerBinary(repoRoot: string): string {
  return path.join(repoRoot, "server", "target", "debug", "codex-warp-server");
}

export async function startFixtureServer(repoRoot: string): Promise<StartedServer> {
  const distDir = path.join(repoRoot, "dist");
  try {
    await access(path.join(distDir, "index.html"));
  } catch {
    throw new Error(`missing ${distDir}/index.html (run: npm run build)`);
  }

  const port = await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-warp-e2e-"));
  const codexHomeDir = await mkdtemp(path.join(tmpdir(), "codex-home-e2e-"));

  const now = Date.now();
  const sid1 = randomUUID();
  const sid2 = randomUUID();

  await writeWarpSession({
    dataDir,
    id: sid1,
    title: "Smoke Session A",
    cwd: "/tmp/project-a",
    createdAtMs: now - 2_000,
    lastUsedAtMs: now - 1_000,
    prompt: "Hello from A",
    assistant: "Here is a TODO:\n- [ ] alpha task\n\nDone.",
    conclusion: "# Conclusion A\n\n- ok\n",
  });

  await writeWarpSession({
    dataDir,
    id: sid2,
    title: "Smoke Session B",
    cwd: "/tmp/project-b",
    createdAtMs: now - 6_000,
    lastUsedAtMs: now - 5_000,
    prompt: "Hello from B",
    assistant: "No TODOs here.",
    conclusion: "# Conclusion B\n\n- ok\n",
  });

  const serverBin = resolveServerBinary(repoRoot);
  try {
    await access(serverBin);
  } catch {
    throw new Error(`missing ${serverBin} (run: cargo build --manifest-path server/Cargo.toml)`);
  }
  const args = [
    "--bind",
    `127.0.0.1:${port}`,
    "--data-dir",
    dataDir,
    "--codex-home",
    codexHomeDir,
    "--web-dist",
    distDir,
  ];

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const child = spawn(serverBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" },
  });
  child.stdout?.on("data", (buf) => {
    stdoutLines.push(String(buf));
    if (stdoutLines.length > 50) stdoutLines.shift();
  });
  child.stderr?.on("data", (buf) => {
    stderrLines.push(String(buf));
    if (stderrLines.length > 50) stderrLines.shift();
  });

  try {
    await waitForHealthz(baseUrl, 15_000);
  } catch (e) {
    child.kill("SIGKILL");
    throw new Error(
      [
        String(e),
        "--- stdout ---",
        stdoutLines.join(""),
        "--- stderr ---",
        stderrLines.join(""),
      ].join("\n"),
    );
  }

  return {
    baseUrl,
    dataDir,
    codexHomeDir,
    distDir,
    stop: async () => {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((r) => child.once("exit", () => r(true))),
        sleep(2_000).then(() => false),
      ]);
      if (!exited) child.kill("SIGKILL");
    },
  };
}
