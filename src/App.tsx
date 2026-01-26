import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

type Settings = {
  codex_path?: string | null;
  default_cwd?: string | null;
};

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

type BlockKind = "assistant" | "command" | "thought" | "status" | "error" | "event";
type Block = {
  id: string;
  key: string;
  kind: BlockKind;
  title: string;
  subtitle?: string;
  body: string;
  ts_ms: number;
  status?: string;
  collapsed?: boolean;
};

function newId(): string {
  if ("crypto" in window && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type TodoItem = {
  text: string;
  done: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const max = 120;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function upsertBlock(blocks: Block[], next: Block): Block[] {
  const idx = blocks.findIndex((b) => b.key === next.key);
  if (idx === -1) return [...blocks, next];

  const prev = blocks[idx];
  const updated: Block = {
    ...prev,
    ...next,
    id: prev.id,
    key: prev.key,
    collapsed: prev.collapsed ?? next.collapsed,
  };

  const copy = blocks.slice();
  copy[idx] = updated;
  return copy;
}

function appendToBlock(
  blocks: Block[],
  key: string,
  create: () => Block,
  line: string,
  ts_ms: number,
): Block[] {
  const idx = blocks.findIndex((b) => b.key === key);
  if (idx === -1) return [...blocks, create()];

  const prev = blocks[idx];
  const body = prev.body ? `${prev.body}\n${line}` : line;
  const updated: Block = {
    ...prev,
    body,
    ts_ms,
  };
  const copy = blocks.slice();
  copy[idx] = updated;
  return copy;
}

function applyUiEventToBlocks(blocks: Block[], e: UiEvent): Block[] {
  if (e.stream === "stderr") {
    return appendToBlock(
      blocks,
      "stderr",
      () => ({
        id: newId(),
        key: "stderr",
        kind: "error",
        title: "stderr",
        body: e.raw,
        ts_ms: e.ts_ms,
        collapsed: true,
      }),
      e.raw,
      e.ts_ms,
    );
  }

  if (!isObject(e.json)) {
    return appendToBlock(
      blocks,
      "stdout_raw",
      () => ({
        id: newId(),
        key: "stdout_raw",
        kind: "event",
        title: "stdout",
        body: e.raw,
        ts_ms: e.ts_ms,
        collapsed: true,
      }),
      e.raw,
      e.ts_ms,
    );
  }

  const type = typeof e.json.type === "string" ? e.json.type : undefined;
  if (!type) {
    return [
      ...blocks,
      {
        id: newId(),
        key: `event:${e.ts_ms}:${Math.random()}`,
        kind: "event",
        title: "event",
        body: JSON.stringify(e.json, null, 2),
        ts_ms: e.ts_ms,
      },
    ];
  }

  if (type === "thread.started" || type === "turn.started") {
    return blocks;
  }

  if (type === "turn.completed") {
    const usage = isObject(e.json.usage) ? e.json.usage : null;
    const inputTokens =
      usage && typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
    const outputTokens =
      usage && typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
    const body = [
      "Turn completed.",
      inputTokens != null ? `input_tokens: ${inputTokens}` : null,
      outputTokens != null ? `output_tokens: ${outputTokens}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return upsertBlock(blocks, {
      id: "turn_summary",
      key: "turn_summary",
      kind: "status",
      title: "Usage",
      body,
      ts_ms: e.ts_ms,
    });
  }

  if (type === "error") {
    const message = typeof e.json.message === "string" ? e.json.message : "Unknown error";
    return [
      ...blocks,
      {
        id: newId(),
        key: `error:${e.ts_ms}:${Math.random()}`,
        kind: "error",
        title: "Error",
        body: message,
        ts_ms: e.ts_ms,
      },
    ];
  }

  if (type.startsWith("item.") && isObject(e.json.item)) {
    const item = e.json.item as Record<string, unknown>;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const itemType = typeof item.type === "string" ? item.type : "item";
    const key = itemId ? `item:${itemId}` : `item:${e.ts_ms}:${Math.random()}`;

    if (itemType === "agent_message") {
      const text = typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2);
      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "assistant",
        title: "Assistant",
        body: text,
        ts_ms: e.ts_ms,
      });
    }

    if (itemType === "reasoning") {
      const text = typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2);
      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "thought",
        title: "Thought",
        body: text,
        ts_ms: e.ts_ms,
        collapsed: true,
      });
    }

    if (itemType === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const status = typeof item.status === "string" ? item.status : undefined;
      const exitCode =
        typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";

      const autoCollapse =
        status && status !== "in_progress" && output.length > 1400 ? true : undefined;

      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "command",
        title: status === "in_progress" ? "Command (running)" : "Command",
        subtitle: `${summarizeCommand(command)}${exitCode}`,
        body: output,
        ts_ms: e.ts_ms,
        status,
        collapsed: autoCollapse,
      });
    }

    return upsertBlock(blocks, {
      id: key,
      key,
      kind: "event",
      title: itemType,
      body: JSON.stringify(item, null, 2),
      ts_ms: e.ts_ms,
    });
  }

  return [
    ...blocks,
    {
      id: newId(),
      key: `event:${type}:${e.ts_ms}:${Math.random()}`,
      kind: "event",
      title: type,
      body: JSON.stringify(e.json, null, 2),
      ts_ms: e.ts_ms,
    },
  ];
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
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>({});
  const [codexPathDraft, setCodexPathDraft] = useState("");
  const [defaultCwdDraft, setDefaultCwdDraft] = useState("");
  const [detectedCodexPaths, setDetectedCodexPaths] = useState<string[]>([]);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [blocksBySession, setBlocksBySession] = useState<Record<string, Block[]>>({});
  const [conclusionBySession, setConclusionBySession] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("Build a GUI around codex CLI JSONL output.");
  const [cwd, setCwd] = useState("");
  const [blockQuery, setBlockQuery] = useState("");
  const [blockKindFilter, setBlockKindFilter] = useState<BlockKind | "all">("all");
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

  const filteredBlocks = useMemo(() => {
    const kind = blockKindFilter;
    const q = blockQuery.trim().toLowerCase();
    if (kind === "all" && !q) return blocks;

    return blocks.filter((b) => {
      if (kind !== "all" && b.kind !== kind) return false;
      if (!q) return true;
      const hay = `${b.title}\n${b.subtitle ?? ""}\n${b.body}`.toLowerCase();
      return hay.includes(q);
    });
  }, [blocks, blockKindFilter, blockQuery]);

  function setCollapsedForActiveSession(blockKey: string, collapsed: boolean) {
    if (!activeSessionId) return;
    setBlocksBySession((prev) => {
      const list = prev[activeSessionId] ?? [];
      const nextList = list.map((b) => (b.key === blockKey ? { ...b, collapsed } : b));
      return { ...prev, [activeSessionId]: nextList };
    });
  }

  async function loadSession(session: SessionMeta) {
    const [lines, conclusionText] = await Promise.all([
      invoke<string[]>("read_session_events", { session_id: session.id, max_lines: 2000 }).catch(
        () => [],
      ),
      invoke<string>("read_conclusion", { session_id: session.id }).catch(() => ""),
    ]);

    const events: UiEvent[] = lines.map((raw, idx) => {
      let json: unknown | null = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }

      return {
        session_id: session.id,
        ts_ms: session.created_at_ms + idx,
        stream: "stdout",
        raw,
        json,
      };
    });

    let nextBlocks: Block[] = [];
    for (const evt of events) {
      nextBlocks = applyUiEventToBlocks(nextBlocks, evt);
    }

    setBlocksBySession((prev) => ({ ...prev, [session.id]: nextBlocks }));
    setConclusionBySession((prev) => ({ ...prev, [session.id]: conclusionText }));
  }

  useEffect(() => {
    let unlistenEvent: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;

    (async () => {
      unlistenEvent = await listen<UiEvent>("codex_event", ({ payload }) => {
        if (!payload?.session_id) return;
        setBlocksBySession((prev) => ({
          ...prev,
          [payload.session_id]: applyUiEventToBlocks(prev[payload.session_id] ?? [], payload),
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
          id: newId(),
          key: `run_finished:${payload.ts_ms}`,
          kind: payload.success ? "status" : "error",
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

  useEffect(() => {
    void invoke<Settings>("get_settings")
      .then((loaded) => {
        setSettings(loaded);
        setCodexPathDraft(loaded.codex_path ?? "");
        setDefaultCwdDraft(loaded.default_cwd ?? "");
        if (!cwd.trim() && loaded.default_cwd) setCwd(loaded.default_cwd);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRun() {
    setErrorBanner(null);
    try {
      const meta = await invoke<SessionMeta>("start_run", {
        prompt,
        cwd: cwd.trim() ? cwd.trim() : null,
      });
      setSessions((prev) => [meta, ...prev]);
      setActiveSessionId(meta.id);
      const startBlock: Block = {
        id: newId(),
        key: `run_start:${Date.now()}`,
        kind: "status",
        title: "Start",
        body: "codex exec --json --full-auto ...",
        ts_ms: Date.now(),
      };
      setBlocksBySession((prev) => ({
        ...prev,
        [meta.id]: [startBlock, ...(prev[meta.id] ?? [])],
      }));
      if (meta.status !== "running") {
        void loadSession(meta);
      }
    } catch (e) {
      setErrorBanner(String(e));
    }
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

  async function openSettings() {
    try {
      const loaded = await invoke<Settings>("get_settings");
      setSettings(loaded);
      setCodexPathDraft(loaded.codex_path ?? "");
      setDefaultCwdDraft(loaded.default_cwd ?? "");
      if (!cwd.trim() && loaded.default_cwd) setCwd(loaded.default_cwd);
    } catch {
      // ignore
    }
    setShowSettings(true);
  }

  async function detectCodex() {
    try {
      const paths = await invoke<string[]>("detect_codex_paths_cmd");
      setDetectedCodexPaths(paths);
    } catch (e) {
      setErrorBanner(String(e));
    }
  }

  async function saveSettingsDraft() {
    try {
      const next: Settings = {
        ...settings,
        codex_path: codexPathDraft.trim() ? codexPathDraft.trim() : null,
        default_cwd: defaultCwdDraft.trim() ? defaultCwdDraft.trim() : null,
      };
      const saved = await invoke<Settings>("save_settings", { settings: next });
      setSettings(saved);
      if (!cwd.trim() && saved.default_cwd) setCwd(saved.default_cwd);
      setShowSettings(false);
    } catch (e) {
      setErrorBanner(String(e));
    }
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
            <button className="btn" type="button" onClick={openSettings}>
              Settings
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
        {errorBanner ? <div className="errorBanner">{errorBanner}</div> : null}
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

        <div className="filterBar">
          <input
            className="search"
            value={blockQuery}
            onChange={(e) => setBlockQuery(e.currentTarget.value)}
            placeholder="Search blocks…"
          />
          <div className="chips">
            {(
              [
                ["all", "All"],
                ["assistant", "Assistant"],
                ["command", "Command"],
                ["thought", "Thought"],
                ["status", "Status"],
                ["error", "Error"],
                ["event", "Event"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`chip ${blockKindFilter === key ? "active" : ""}`}
                type="button"
                onClick={() => setBlockKindFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="muted mono results">
            {filteredBlocks.length}/{blocks.length}
          </div>
        </div>

        <div className="timeline">
          {filteredBlocks.map((b) => (
            <section key={b.id} className={`block ${b.kind}`}>
              <header className="blockHeader">
                <div className="blockHeaderLeft">
                  <div className="blockTitle">{b.title}</div>
                  {b.subtitle ? <div className="blockSubtitle muted mono">{b.subtitle}</div> : null}
                </div>
                <div className="blockHeaderRight">
                  {b.status ? <span className={`pill ${b.status}`}>{b.status}</span> : null}
                  <button
                    className="iconBtn"
                    type="button"
                    onClick={() => setCollapsedForActiveSession(b.key, !(b.collapsed ?? false))}
                    aria-label={b.collapsed ? "Expand block" : "Collapse block"}
                    title={b.collapsed ? "Expand" : "Collapse"}
                  >
                    {b.collapsed ? "▸" : "▾"}
                  </button>
                  <div className="muted mono">{new Date(b.ts_ms).toLocaleTimeString()}</div>
                </div>
              </header>
              {b.collapsed ? null : (
                <div className="blockBody">
                  {b.kind === "assistant" ? (
                    <div className="markdown compact">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.body}</ReactMarkdown>
                    </div>
                  ) : b.kind === "thought" ? (
                    <pre className="blockPre mono">{b.body}</pre>
                  ) : b.kind === "command" ? (
                    <pre className="blockPre mono">{b.body || "(no output yet)"}</pre>
                  ) : (
                    <pre className="blockPre mono">{b.body}</pre>
                  )}
                </div>
              )}
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

      {showSettings ? (
        <div className="modalBackdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Settings</div>
              <button className="btn" type="button" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>

            <div className="field">
              <label className="label">Codex executable path</label>
              <input
                className="input"
                value={codexPathDraft}
                onChange={(e) => setCodexPathDraft(e.currentTarget.value)}
                placeholder='e.g. "/opt/homebrew/bin/codex"'
              />
              <div className="row">
                <button className="btn" type="button" onClick={detectCodex}>
                  Detect
                </button>
                <button className="btn primary" type="button" onClick={saveSettingsDraft}>
                  Save
                </button>
              </div>
              {detectedCodexPaths.length > 0 ? (
                <div className="detected">
                  <div className="muted">Detected:</div>
                  <ul>
                    {detectedCodexPaths.map((p) => (
                      <li key={p}>
                        <button
                          className="linkBtn mono"
                          type="button"
                          onClick={() => setCodexPathDraft(p)}
                        >
                          {p}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="field">
              <label className="label">Default working directory</label>
              <input
                className="input"
                value={defaultCwdDraft}
                onChange={(e) => setDefaultCwdDraft(e.currentTarget.value)}
                placeholder='e.g. "/Users/you/projects"'
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
