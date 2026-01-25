import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

type SessionStatus = "running" | "done" | "error";
type SessionMeta = {
  id: string;
  title: string;
  created_at_ms: number;
  cwd?: string | null;
  status: SessionStatus;
  events_path: string;
  stderr_path: string;
  conclusion_path: string;
};

type UiEvent = {
  session_id: string;
  ts_ms: number;
  stream: "stdout" | "stderr";
  raw: string;
  json: unknown | null;
};

type RunFinished = {
  session_id: string;
  ts_ms: number;
  exit_code: number | null;
  success: boolean;
};

type BlockKind = "plan" | "tool" | "message" | "error" | "result" | "event";
type Block = {
  id: string;
  kind: BlockKind;
  title: string;
  body: string;
  ts_ms: number;
};

type TodoItem = {
  text: string;
  done: boolean;
};

function eventToBlock(e: UiEvent): Block {
  const json = e.json as any;
  const type = typeof json?.type === "string" ? json.type : undefined;
  const kind: BlockKind =
    e.stream === "stderr"
      ? "error"
      : type?.includes("plan")
        ? "plan"
        : type?.includes("tool") || type?.includes("command")
          ? "tool"
          : type?.includes("final") || type?.includes("result")
            ? "result"
            : type
              ? "event"
              : "message";

  const title =
    e.stream === "stderr"
      ? "stderr"
      : type
        ? type
        : e.raw.trim().startsWith("{")
          ? "event"
          : "message";

  const body = json ? JSON.stringify(json, null, 2) : e.raw;

  return {
    id: crypto.randomUUID(),
    kind,
    title,
    body,
    ts_ms: e.ts_ms,
  };
}

function parseMarkdownTodos(text: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/);
    if (!m) continue;
    out.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
  }
  return out;
}

function extractStringsFromJson(value: any, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => extractStringsFromJson(v, depth + 1));
  if (typeof value !== "object") return [];

  const obj = value as Record<string, unknown>;
  const preferredKeys = ["todos", "todo", "plan", "steps", "items", "tasks"];
  const preferred = preferredKeys.flatMap((k) => extractStringsFromJson((obj as any)[k], depth + 1));
  if (preferred.length) return preferred;
  return Object.values(obj).flatMap((v) => extractStringsFromJson(v, depth + 1));
}

function extractTodos(blocks: Block[]): TodoItem[] {
  const candidates: TodoItem[] = [];
  for (const b of blocks) {
    candidates.push(...parseMarkdownTodos(b.body));

    if (b.body.trim().startsWith("{")) {
      try {
        const json = JSON.parse(b.body);
        const strs = extractStringsFromJson(json);
        for (const s of strs) {
          if (!s || s.length > 180) continue;
          candidates.push({ done: false, text: s });
        }
      } catch {
        // ignore
      }
    }
  }

  const dedup = new Map<string, TodoItem>();
  for (const t of candidates) {
    const key = t.text;
    const existing = dedup.get(key);
    if (!existing) dedup.set(key, t);
    else if (!existing.done && t.done) dedup.set(key, t);
  }
  return [...dedup.values()].slice(0, 100);
}

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [blocksBySession, setBlocksBySession] = useState<Record<string, Block[]>>({});
  const [conclusionBySession, setConclusionBySession] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("Build a GUI around codex CLI JSONL output.");
  const [cwd, setCwd] = useState("/Users/bba");
  const [rightTab, setRightTab] = useState<"todo" | "preview">("todo");

  const blocks = useMemo(
    () => blocksBySession[activeSessionId] ?? [],
    [activeSessionId, blocksBySession],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const todos = useMemo(() => extractTodos(blocks), [blocks]);
  const conclusion = useMemo(
    () => conclusionBySession[activeSessionId] ?? "",
    [activeSessionId, conclusionBySession],
  );

  async function loadSession(session: SessionMeta) {
    const [lines, conclusionText] = await Promise.all([
      invoke<string[]>("read_session_events", { session_id: session.id, max_lines: 2000 }).catch(
        () => [],
      ),
      invoke<string>("read_conclusion", { session_id: session.id }).catch(() => ""),
    ]);

    const blocks: Block[] = lines.map((raw, idx) => {
      let json: unknown | null = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }

      const evt: UiEvent = {
        session_id: session.id,
        ts_ms: session.created_at_ms + idx,
        stream: "stdout",
        raw,
        json,
      };
      return eventToBlock(evt);
    });

    setBlocksBySession((prev) => ({ ...prev, [session.id]: blocks }));
    setConclusionBySession((prev) => ({ ...prev, [session.id]: conclusionText }));
  }

  useEffect(() => {
    let unlistenEvent: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;

    (async () => {
      unlistenEvent = await listen<UiEvent>("codex_event", ({ payload }) => {
        if (!payload?.session_id) return;
        const block = eventToBlock(payload);
        setBlocksBySession((prev) => ({
          ...prev,
          [payload.session_id]: [...(prev[payload.session_id] ?? []), block],
        }));
      });

      unlistenFinished = await listen<RunFinished>("codex_run_finished", ({ payload }) => {
        if (!payload?.session_id) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === payload.session_id
              ? { ...s, status: payload.success ? "done" : "error" }
              : s,
          ),
        );

        const block: Block = {
          id: crypto.randomUUID(),
          kind: payload.success ? "result" : "error",
          title: payload.success ? "Run finished" : "Run failed",
          body: payload.exit_code == null ? "exit_code: null" : `exit_code: ${payload.exit_code}`,
          ts_ms: payload.ts_ms,
        };
        setBlocksBySession((prev) => ({
          ...prev,
          [payload.session_id]: [...(prev[payload.session_id] ?? []), block],
        }));

        void invoke<string>("read_conclusion", { session_id: payload.session_id })
          .then((text) =>
            setConclusionBySession((prev) => ({ ...prev, [payload.session_id]: text })),
          )
          .catch(() => {});
      });
    })();

    return () => {
      unlistenEvent?.();
      unlistenFinished?.();
    };
  }, []);

  useEffect(() => {
    void invoke<SessionMeta[]>("list_sessions")
      .then((loaded) => {
        setSessions(loaded);
        if (loaded.length > 0) {
          setActiveSessionId(loaded[0].id);
          void loadSession(loaded[0]);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRun() {
    const meta = await invoke<SessionMeta>("start_run", {
      prompt,
      cwd: cwd.trim() ? cwd.trim() : null,
    });
    setSessions((prev) => [meta, ...prev]);
    setActiveSessionId(meta.id);
    setBlocksBySession((prev) => ({ ...prev, [meta.id]: [] }));
  }

  async function renameActive() {
    if (!activeSession) return;
    const title = window.prompt("Rename session", activeSession.title);
    if (!title?.trim()) return;
    await invoke("rename_session", { session_id: activeSession.id, title: title.trim() });
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? { ...s, title: title.trim() } : s)),
    );
  }

  async function deleteActive() {
    if (!activeSession) return;
    if (!window.confirm(`Delete session "${activeSession.title}"?`)) return;
    await invoke("delete_session", { session_id: activeSession.id });

    setSessions((prev) => prev.filter((s) => s.id !== activeSession.id));
    setBlocksBySession((prev) => {
      const next = { ...prev };
      delete next[activeSession.id];
      return next;
    });
    setConclusionBySession((prev) => {
      const next = { ...prev };
      delete next[activeSession.id];
      return next;
    });

    const remaining = sessions.filter((s) => s.id !== activeSession.id);
    const nextActive = remaining[0];
    setActiveSessionId(nextActive?.id ?? "");
    if (nextActive) void loadSession(nextActive);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div className="appTitle">Codex Warp</div>
          <div className="sidebarActions">
            <button className="btn" type="button" onClick={startRun} disabled={!prompt.trim()}>
              New
            </button>
            <button className="btn" type="button" onClick={renameActive} disabled={!activeSessionId}>
              Rename
            </button>
            <button className="btn" type="button" onClick={deleteActive} disabled={!activeSessionId}>
              Delete
            </button>
          </div>
        </div>

        <div className="sidebarSectionTitle">Sessions</div>
        <div className="sessionList">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sessionRow ${s.id === activeSessionId ? "active" : ""}`}
              onClick={() => {
                setActiveSessionId(s.id);
                void loadSession(s);
              }}
            >
              <div className="sessionTitle">{s.title}</div>
              <div className="sessionMeta">
                <span className={`pill ${s.status}`}>{s.status}</span>
                <span className="muted">{s.cwd ?? ""}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="composer">
          <div className="composerLeft">
            <textarea
              className="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              rows={2}
              placeholder="Describe what you want Codex to do…"
            />
            <input
              className="cwd"
              value={cwd}
              onChange={(e) => setCwd(e.currentTarget.value)}
              placeholder="Working directory (optional)"
            />
          </div>
          <button className="btn primary" type="button" onClick={startRun} disabled={!prompt.trim()}>
            Run
          </button>
        </div>

        <div className="timeline">
          {blocks.map((b) => (
            <section key={b.id} className={`block ${b.kind}`}>
              <header className="blockHeader">
                <div className="blockTitle">{b.title}</div>
                <div className="muted mono">{new Date(b.ts_ms).toLocaleTimeString()}</div>
              </header>
              <pre className="blockBody mono">{b.body}</pre>
            </section>
          ))}
        </div>
      </main>

      <aside className="right">
        <div className="rightTabs">
          <button
            type="button"
            className={`tab ${rightTab === "todo" ? "active" : ""}`}
            onClick={() => setRightTab("todo")}
          >
            TODO
          </button>
          <button
            type="button"
            className={`tab ${rightTab === "preview" ? "active" : ""}`}
            onClick={() => setRightTab("preview")}
          >
            Preview
          </button>
        </div>

        {rightTab === "todo" ? (
          <div className="panel">
            <div className="panelTitle">TODO</div>
            {todos.length > 0 ? (
              <ul className="todoList">
                {todos.map((t) => (
                  <li key={t.text}>
                    {t.done ? "[x]" : "[ ]"} {t.text}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">No TODOs parsed yet.</div>
            )}
          </div>
        ) : (
          <div className="panel">
            <div className="panelTitle">Conclusion.md</div>
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {conclusion.trim() ? conclusion : "_No conclusion yet._"}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

export default App;
