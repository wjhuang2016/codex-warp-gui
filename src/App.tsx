import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";
import { CwdShell } from "./CwdShell";

const EMPTY_BLOCKS: Block[] = [];

type Settings = {
  codex_path?: string | null;
  default_cwd?: string | null;
  last_cwd?: string | null;
};

type SessionStatus = "running" | "done" | "error";
type SessionMeta = {
  id: string;
  title: string;
  created_at_ms: number;
  last_used_at_ms: number;
  cwd?: string | null;
  status: SessionStatus;
  codex_session_id?: string | null;
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

function newSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
  }

  // Fallback (non-cryptographic), still formatted as a UUID v4.
  const r4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  const v4 = r4();
  const variant = ((8 + Math.floor(Math.random() * 4)).toString(16) + r4().slice(1)).slice(0, 4);
  return `${r4()}${r4()}-${r4()}-4${v4.slice(1)}-${variant}-${r4()}${r4()}${r4()}`;
}

function safeSessionTitle(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "New session";
  const s = trimmed.replace(/\n/g, " ");
  if (s.length <= 60) return s;
  return `${s.slice(0, 60)}…`;
}

function clampTitle(text: string, max = 70): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const s = trimmed.replace(/\s+/g, " ");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function sortSessionsByRecency(items: SessionMeta[]): SessionMeta[] {
  return items
    .slice()
    .sort((a, b) => (b.last_used_at_ms || b.created_at_ms) - (a.last_used_at_ms || a.created_at_ms));
}

const TOOL_MARKUP_RE = /[ \t]*\uE200[^\uE201]*\uE201/g;
function stripToolCitations(text: string): string {
  if (!text) return text;
  if (!text.includes("\uE200")) return text;
  return text.replace(TOOL_MARKUP_RE, "");
}

function toExternalUrl(href: string): string | null {
  const t = href.trim();
  if (!t) return null;

  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      return u.toString();
    }
    return null;
  } catch {
    // Handle bare domains like "github.com/tauri-apps/tauri"
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(\/.*)?$/.test(t)) {
      try {
        const u = new URL(`https://${t}`);
        return u.toString();
      } catch {
        return null;
      }
    }
    return null;
  }
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

function previewText(text: string): string {
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "";
  const max = 140;
  if (first.length <= max) return first;
  return `${first.slice(0, max)}…`;
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

function appendDeltaToBlock(
  blocks: Block[],
  key: string,
  create: () => Block,
  delta: string,
  ts_ms: number,
): Block[] {
  const idx = blocks.findIndex((b) => b.key === key);
  if (idx === -1) {
    const next = create();
    return [
      ...blocks,
      {
        ...next,
        body: (next.body || "") + delta,
        ts_ms,
      },
    ];
  }

  const prev = blocks[idx];
  const updated: Block = {
    ...prev,
    body: (prev.body || "") + delta,
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
        body: stripToolCitations(e.raw),
        ts_ms: e.ts_ms,
      }),
      stripToolCitations(e.raw),
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
      }),
      e.raw,
      e.ts_ms,
    );
  }

  const method = typeof (e.json as any).method === "string" ? (e.json as any).method : undefined;
  if (method) {
    if (
      method === "thread/tokenUsage/updated" ||
      method === "account/rateLimits/updated" ||
      method === "item/reasoning/summaryPartAdded" ||
      method.startsWith("codex/event/")
    ) {
      return blocks;
    }

    const params = isObject((e.json as any).params) ? ((e.json as any).params as any) : {};

    if (method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const delta = stripToolCitations(typeof params.delta === "string" ? params.delta : "");
      if (!itemId || !delta) return blocks;
      const key = `item:${itemId}`;
      return appendDeltaToBlock(
        blocks,
        key,
        () => ({
          id: newId(),
          key,
          kind: "assistant",
          title: "Assistant",
          body: "",
          ts_ms: e.ts_ms,
        }),
        delta,
        e.ts_ms,
      );
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const delta = stripToolCitations(typeof params.delta === "string" ? params.delta : "");
      if (!itemId || !delta) return blocks;
      const key = `item:${itemId}`;
      return appendDeltaToBlock(
        blocks,
        key,
        () => ({
          id: newId(),
          key,
          kind: "thought",
          title: "Thought",
          body: "",
          ts_ms: e.ts_ms,
        }),
        delta,
        e.ts_ms,
      );
    }

    if (method === "item/commandExecution/outputDelta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const delta = stripToolCitations(typeof params.delta === "string" ? params.delta : "");
      if (!itemId || !delta) return blocks;
      const key = `item:${itemId}`;
      return appendDeltaToBlock(
        blocks,
        key,
        () => ({
          id: newId(),
          key,
          kind: "command",
          title: "Command",
          body: "",
          ts_ms: e.ts_ms,
        }),
        delta,
        e.ts_ms,
      );
    }

    if (method === "item/started" || method === "item/completed") {
      const item = isObject(params.item) ? (params.item as any) : null;
      const itemType = item && typeof item.type === "string" ? item.type : "";
      const itemId = item && typeof item.id === "string" ? item.id : "";
      const key = itemId ? `item:${itemId}` : `item:${e.ts_ms}:${Math.random()}`;

      if (itemType === "userMessage") {
        return blocks;
      }

      if (itemType === "agentMessage") {
        const text = stripToolCitations(item && typeof item.text === "string" ? item.text : "");
        if (!text) return blocks;
        return upsertBlock(blocks, {
          id: key,
          key,
          kind: "assistant",
          title: "Assistant",
          body: text,
          ts_ms: e.ts_ms,
        });
      }

      if (itemType === "commandExecution") {
        const command = item && typeof item.command === "string" ? item.command : "";
        const output =
          stripToolCitations(
            item && typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
          );
        const rawStatus = item && typeof item.status === "string" ? item.status : undefined;
        const status = rawStatus === "inProgress" ? "in_progress" : rawStatus;
        const exitCode = item && typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
        const title = status === "in_progress" ? "Command (running)" : "Command";
        const subtitle = command ? `${summarizeCommand(command)}${exitCode}` : undefined;
        const autoCollapse =
          status && status !== "in_progress" && output.length > 1400 ? true : undefined;

        return upsertBlock(blocks, {
          id: key,
          key,
          kind: "command",
          title,
          subtitle,
          body: output,
          ts_ms: e.ts_ms,
          status,
          collapsed: autoCollapse,
        });
      }

      if (itemType === "reasoning") {
        return blocks;
      }

      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "event",
        title: itemType || "item",
        body: JSON.stringify(item ?? params, null, 2),
        ts_ms: e.ts_ms,
      });
    }

    if (method === "error") {
      return [
        ...blocks,
        {
          id: newId(),
          key: `app_error:${e.ts_ms}:${Math.random()}`,
          kind: "error",
          title: "Error",
          body: JSON.stringify(params ?? e.json, null, 2),
          ts_ms: e.ts_ms,
        },
      ];
    }

    // Ignore other app-server notifications by default.
    if (method === "thread/started" || method === "turn/started" || method === "turn/completed") {
      return blocks;
    }
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

  if (type === "app.prompt") {
    const prompt = stripToolCitations(typeof e.json.prompt === "string" ? e.json.prompt : "");
    const key = `prompt:${e.ts_ms}`;
    return upsertBlock(blocks, {
      id: key,
      key,
      kind: "status",
      title: "Prompt",
      body: prompt,
      ts_ms: e.ts_ms,
    });
  }

  if (type === "app/error") {
    const message = typeof e.json.message === "string" ? e.json.message : "Unknown error";
    return [
      ...blocks,
      {
        id: newId(),
        key: `app_error:${e.ts_ms}:${Math.random()}`,
        kind: "error",
        title: "Error",
        body: message,
        ts_ms: e.ts_ms,
      },
    ];
  }

  if (type === "thread.started" || type === "turn.started") {
    return blocks;
  }

  if (type === "turn.completed") {
    return blocks;
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
      const text = stripToolCitations(
        typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2),
      );
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
      const text = stripToolCitations(
        typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2),
      );
      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "thought",
        title: "Thought",
        body: text,
        ts_ms: e.ts_ms,
      });
    }

    if (itemType === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const output = stripToolCitations(
        typeof item.aggregated_output === "string" ? item.aggregated_output : "",
      );
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
  let inPlan = false;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/);
    if (m) {
      out.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
      continue;
    }

    const next = line.match(
      /^\s*(next|next step|todo|tbd|后续|下一步)\s*[:：]\s*(.+)$/i,
    );
    if (next) {
      out.push({ done: false, text: next[2].trim() });
      continue;
    }

    if (/^\s*(plan|计划)\s*[:：]\s*$/i.test(line)) {
      inPlan = true;
      continue;
    }
    if (inPlan) {
      if (!line.trim()) {
        inPlan = false;
        continue;
      }
      const n = line.match(/^\s*\d+\.\s+(.*)$/);
      if (n) out.push({ done: false, text: n[1].trim() });
    }
  }
  return out;
}

function extractTodos(blocks: Block[]): TodoItem[] {
  const candidates: TodoItem[] = [];
  for (const b of blocks) {
    if (b.kind !== "assistant" && b.kind !== "thought") continue;
    candidates.push(...parseMarkdownTodos(b.body));
  }

  const dedup = new Map<string, TodoItem>();
  for (const t of candidates) {
    const normalized = t.text.trim();
    if (!normalized) continue;
    if (/^(n\/a|na|none|无|没有|不需要)$/i.test(normalized)) continue;
    const key = normalized;
    const existing = dedup.get(key);
    if (!existing) dedup.set(key, t);
    else if (!existing.done && t.done) dedup.set(key, t);
  }
  return [...dedup.values()].slice(0, 100);
}

function App() {
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionSettings, setShowSessionSettings] = useState(false);
  const [showCwdShell, setShowCwdShell] = useState(false);
  const [settings, setSettings] = useState<Settings>({});
  const [codexPathDraft, setCodexPathDraft] = useState("");
  const [defaultCwdDraft, setDefaultCwdDraft] = useState("");
  const [detectedCodexPaths, setDetectedCodexPaths] = useState<string[]>([]);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [startingSessionId, setStartingSessionId] = useState<string | null>(null);
  const [blocksBySession, setBlocksBySession] = useState<Record<string, Block[]>>({});
  const [conclusionBySession, setConclusionBySession] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [blockQuery, setBlockQuery] = useState("");
  const [blockKindFilter, setBlockKindFilter] = useState<BlockKind | "all">("all");
  const [rightTab, setRightTab] = useState<"todo" | "preview">("todo");
  const [showRename, setShowRename] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [runStartedAtBySession, setRunStartedAtBySession] = useState<Record<string, number>>({});
  const [lastPromptBySession, setLastPromptBySession] = useState<Record<string, string>>({});
  const [tickerMs, setTickerMs] = useState(() => Date.now());

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const composingPromptRef = useRef(false);
  const scrollStateBySessionRef = useRef<
    Record<string, { scrollTop: number; stickToBottom: boolean }>
  >({});
  const activeSessionIdRef = useRef("");
  const activeSessionStatusRef = useRef<SessionStatus | null>(null);
  const showSettingsRef = useRef(false);
  const showSessionSettingsRef = useRef(false);
  const showRenameRef = useRef(false);

  const blocks = useMemo(
    () => blocksBySession[activeSessionId] ?? EMPTY_BLOCKS,
    [activeSessionId, blocksBySession],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const markdownComponents: Components = useMemo(
    () => ({
      a({ node: _node, href, children, ...props }) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              const raw = typeof href === "string" ? href : "";
              const url = raw ? toExternalUrl(raw) : null;
              if (!url) {
                setErrorBanner(raw ? `Cannot open link: ${raw}` : "Cannot open link.");
                return;
              }
              setErrorBanner(null);
              void openUrl(url).catch((err) => setErrorBanner(String(err)));
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [],
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    activeSessionStatusRef.current = activeSession?.status ?? null;
    showSettingsRef.current = showSettings;
    showSessionSettingsRef.current = showSessionSettings;
    showRenameRef.current = showRename;
  }, [activeSession?.status, activeSessionId, showRename, showSettings, showSessionSettings]);

  function closeSessionSettings() {
    setShowSessionSettings(false);
    setShowCwdShell(false);
    void invoke("stop_shell").catch(() => {});
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (showSettingsRef.current) {
        e.preventDefault();
        setShowSettings(false);
        return;
      }
      if (showSessionSettingsRef.current) {
        e.preventDefault();
        closeSessionSettings();
        return;
      }
      if (showRenameRef.current) {
        e.preventDefault();
        setShowRename(false);
        return;
      }
      if (activeSessionStatusRef.current !== "running") return;
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      e.preventDefault();
      setErrorBanner(null);
      void invoke("stop_run", { sessionId: sid }).catch((err) => setErrorBanner(String(err)));
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (activeSession?.status !== "running") return;
    const id = window.setInterval(() => setTickerMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [activeSession?.status, activeSessionId]);

  const todos = useMemo(() => extractTodos(blocks), [blocks]);
  const conclusion = useMemo(
    () => conclusionBySession[activeSessionId] ?? "",
    [activeSessionId, conclusionBySession],
  );

  const runElapsedSec = useMemo(() => {
    if (!activeSessionId) return null;
    if (activeSession?.status !== "running") return null;
    const started =
      runStartedAtBySession[activeSessionId] ?? activeSession?.last_used_at_ms ?? 0;
    if (!started) return null;
    return Math.max(0, Math.floor((tickerMs - started) / 1000));
  }, [
    activeSession?.last_used_at_ms,
    activeSession?.status,
    activeSessionId,
    runStartedAtBySession,
    tickerMs,
  ]);

  const runHeadline = useMemo(() => {
    if (!activeSessionId) return "";
    const p = lastPromptBySession[activeSessionId];
    if (p && p.trim()) return clampTitle(p, 84);
    if (activeSession?.title) return clampTitle(activeSession.title, 84);
    return "";
  }, [activeSession?.title, activeSessionId, lastPromptBySession]);

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

  const persistScrollStateForActiveSession = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    if (!activeSessionId) return;
    const threshold = 120;
    const stickToBottom =
      el.scrollTop + el.clientHeight >= Math.max(0, el.scrollHeight - threshold);
    stickToBottomRef.current = stickToBottom;
    scrollStateBySessionRef.current[activeSessionId] = {
      scrollTop: el.scrollTop,
      stickToBottom,
    };
  }, [activeSessionId]);

  const scrollTimelineToBottom = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    const end = timelineEndRef.current;
    if (end) {
      try {
        // Legacy WebKit signature aligns element bottom when arg is false.
        end.scrollIntoView(false);
        return;
      } catch {
        // ignore
      }
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  const onTimelineScroll = useCallback(() => {
    persistScrollStateForActiveSession();
  }, [persistScrollStateForActiveSession]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollTimelineToBottom();
    const id = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return;
      scrollTimelineToBottom();
    });
    return () => cancelAnimationFrame(id);
  }, [blocks, scrollTimelineToBottom]);

  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    if (!activeSessionId) {
      stickToBottomRef.current = true;
      scrollTimelineToBottom();
      return;
    }

    const saved = scrollStateBySessionRef.current[activeSessionId];
    if (!saved) {
      stickToBottomRef.current = true;
      scrollTimelineToBottom();
      return;
    }

    stickToBottomRef.current = saved.stickToBottom;
    if (saved.stickToBottom) {
      scrollTimelineToBottom();
    } else {
      el.scrollTop = saved.scrollTop;
    }
  }, [activeSessionId, scrollTimelineToBottom]);

  function setCollapsedForActiveSession(blockKey: string, collapsed: boolean) {
    if (!activeSessionId) return;
    setBlocksBySession((prev) => {
      const list = prev[activeSessionId] ?? [];
      const nextList = list.map((b) => (b.key === blockKey ? { ...b, collapsed } : b));
      return { ...prev, [activeSessionId]: nextList };
    });
  }

  async function loadSession(session: SessionMeta) {
    const loadId = session.id;
    setLoadingSessionId(loadId);
    setErrorBanner(null);
    try {
      const [lines, stderrLines, conclusionText] = await Promise.all([
        invoke<string[]>("read_session_events", { sessionId: session.id, maxLines: 2000 }),
        invoke<string[]>("read_session_stderr", { sessionId: session.id, maxLines: 2000 }).catch(
          () => [],
        ),
        invoke<string>("read_conclusion", { sessionId: session.id }).catch(() => ""),
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

      let lastPrompt = "";
      for (const evt of events) {
        if (!isObject(evt.json)) continue;
        if ((evt.json as any).type === "app.prompt" && typeof (evt.json as any).prompt === "string") {
          lastPrompt = String((evt.json as any).prompt);
        }
      }
      if (lastPrompt.trim()) {
        setLastPromptBySession((prev) => ({ ...prev, [session.id]: lastPrompt }));
      }

      const stderrEvents: UiEvent[] = stderrLines.map((raw, idx) => ({
        session_id: session.id,
        ts_ms: session.created_at_ms + lines.length + idx,
        stream: "stderr",
        raw,
        json: null,
      }));

      let nextBlocks: Block[] = [];
      for (const evt of [...events, ...stderrEvents]) {
        nextBlocks = applyUiEventToBlocks(nextBlocks, evt);
      }

      setBlocksBySession((prev) => ({ ...prev, [session.id]: nextBlocks }));
      setConclusionBySession((prev) => ({
        ...prev,
        [session.id]: stripToolCitations(conclusionText),
      }));
    } catch (e) {
      setErrorBanner(String(e));
    } finally {
      setLoadingSessionId((cur) => (cur === loadId ? null : cur));
    }
  }

  async function refreshSessions(nextActiveId?: string) {
    setErrorBanner(null);
    try {
      const loaded = await invoke<SessionMeta[]>("list_sessions");
      const sorted = sortSessionsByRecency(loaded);
      setSessions(sorted);
      const active =
        nextActiveId && sorted.some((s) => s.id === nextActiveId)
          ? nextActiveId
          : sorted[0]?.id ?? "";
      setActiveSessionId(active);
      if (active) {
        const s = sorted.find((x) => x.id === active);
        if (s) await loadSession(s);
      }
    } catch (e) {
      setErrorBanner(String(e));
    }
  }

  useEffect(() => {
    let disposed = false;
    let unlistenEvent: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;

    void listen<UiEvent>("codex_event", ({ payload }) => {
      if (!payload?.session_id) return;
      setBlocksBySession((prev) => ({
        ...prev,
        [payload.session_id]: applyUiEventToBlocks(prev[payload.session_id] ?? [], payload),
      }));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenEvent = unlisten;
      })
      .catch(() => {});

    void listen<RunFinished>("codex_run_finished", ({ payload }) => {
      if (!payload?.session_id) return;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === payload.session_id ? { ...s, status: payload.success ? "done" : "error" } : s,
        ),
      );
      setRunStartedAtBySession((prev) => {
        if (!(payload.session_id in prev)) return prev;
        const next = { ...prev };
        delete next[payload.session_id];
        return next;
      });

      if (!payload.success && payload.session_id === activeSessionIdRef.current) {
        const msg =
          payload.exit_code == null ? "Run stopped." : `Run failed (exit ${payload.exit_code}).`;
        setErrorBanner(msg);
      }

      void invoke<string>("read_conclusion", { sessionId: payload.session_id })
        .then((text) =>
          setConclusionBySession((prev) => ({
            ...prev,
            [payload.session_id]: stripToolCitations(text),
          })),
        )
        .catch(() => {});
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenFinished = unlisten;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlistenEvent?.();
      unlistenFinished?.();
    };
  }, []);

  useEffect(() => {
    void invoke<SessionMeta[]>("list_sessions")
      .then((loaded) => {
        const sorted = sortSessionsByRecency(loaded);
        setSessions(sorted);
        if (loaded.length > 0) {
          setActiveSessionId(sorted[0].id);
          void loadSession(sorted[0]);
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
        const initialCwd = loaded.last_cwd ?? loaded.default_cwd;
        if (!cwd.trim() && initialCwd) setCwd(initialCwd);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startNewRun() {
    const promptText = prompt.trim();
    if (!promptText) return;
    if (startingSessionId) return;
    const prevActiveSessionId = activeSessionId;
    const sessionId = newSessionId();
    const now = Date.now();

    stickToBottomRef.current = true;
    setRunStartedAtBySession((prev) => ({ ...prev, [sessionId]: now }));
    setLastPromptBySession((prev) => ({ ...prev, [sessionId]: promptText }));
    setStartingSessionId(sessionId);
    setActiveSessionId(sessionId);
    setErrorBanner(null);

    const nextCwd = cwd.trim() ? cwd.trim() : null;
    const placeholder: SessionMeta = {
      id: sessionId,
      title: safeSessionTitle(promptText),
      created_at_ms: now,
      last_used_at_ms: now,
      cwd: nextCwd,
      status: "running",
      codex_session_id: null,
      events_path: "",
      stderr_path: "",
      conclusion_path: "",
    };

    setSessions((prev) => [placeholder, ...prev]);
    setBlocksBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setConclusionBySession((prev) => ({ ...prev, [sessionId]: "" }));

    try {
      const meta = await invoke<SessionMeta>("start_run", {
        sessionId,
        prompt: promptText,
        cwd: nextCwd,
      });
      setSessions((prev) => sortSessionsByRecency(prev.map((s) => (s.id === sessionId ? meta : s))));
      setActiveSessionId(sessionId);
      if (meta.status !== "running") {
        void loadSession(meta);
      }
    } catch (e) {
      setRunStartedAtBySession((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setBlocksBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setConclusionBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setActiveSessionId(prevActiveSessionId);
      setErrorBanner(String(e));
    } finally {
      setStartingSessionId((cur) => (cur === sessionId ? null : cur));
    }
  }

  function beginNewSession() {
    if (startingSessionId != null) return;
    persistScrollStateForActiveSession();
    setErrorBanner(null);
    setActiveSessionId("");
  }

  async function runInActiveSession() {
    const promptText = prompt.trim();
    if (!promptText) return;
    stickToBottomRef.current = true;
    setErrorBanner(null);

    if (!activeSessionId) {
      await startNewRun();
      return;
    }
    if (activeSession?.status === "running") {
      setErrorBanner("This session is already running.");
      return;
    }

    try {
      const now = Date.now();
      setRunStartedAtBySession((prev) => ({ ...prev, [activeSessionId]: now }));
      setLastPromptBySession((prev) => ({ ...prev, [activeSessionId]: promptText }));
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, status: "running", last_used_at_ms: Math.max(s.last_used_at_ms, now) }
            : s,
        ),
      );
      const meta = await invoke<SessionMeta>("continue_run", {
        sessionId: activeSessionId,
        prompt: promptText,
        cwd: cwd.trim() ? cwd.trim() : null,
      });
      setSessions((prev) => sortSessionsByRecency(prev.map((s) => (s.id === meta.id ? meta : s))));
      setActiveSessionId(meta.id);
    } catch (e) {
      setRunStartedAtBySession((prev) => {
        if (!(activeSessionId in prev)) return prev;
        const next = { ...prev };
        delete next[activeSessionId];
        return next;
      });
      setErrorBanner(String(e));
    }
  }

  async function touchSession(sessionId: string) {
    try {
      const meta = await invoke<SessionMeta>("touch_session", { sessionId });
      setSessions((prev) => {
        let found = false;
        const next = prev.map((s) => {
          if (s.id !== meta.id) return s;
          found = true;
          return meta;
        });
        return sortSessionsByRecency(found ? next : [meta, ...next]);
      });
    } catch {
      // ignore
    }
  }

  async function pickCwd() {
    setErrorBanner(null);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: cwd.trim()
          ? cwd.trim()
          : settings.last_cwd ?? settings.default_cwd ?? undefined,
      });
      if (!selected) return;
      const dir = Array.isArray(selected) ? selected[0] : selected;
      if (!dir) return;
      setCwd(dir);
      void invoke("shell_cd", { cwd: dir }).catch(() => {});
      const saved = await invoke<Settings>("save_settings", {
        settings: {
          ...settings,
          last_cwd: dir,
        },
      });
      setSettings(saved);
    } catch (e) {
      setErrorBanner(String(e));
    }
  }

  function openSessionSettings() {
    if (startingSessionId != null) return;
    setErrorBanner(null);
    setShowSessionSettings(true);
  }

  async function renameActive() {
    if (!activeSession) return;
    setRenameDraft(activeSession.title);
    setShowRename(true);
  }

  async function deleteActive() {
    if (!activeSession) return;
    setErrorBanner(null);
    const ok = await confirm(`Delete session "${activeSession.title}"?`, {
      title: "Delete session",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await invoke("delete_session", { sessionId: activeSession.id });
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
      await refreshSessions();
    } catch (e) {
      setErrorBanner(String(e));
    }
  }

  async function openSettings() {
    try {
      const loaded = await invoke<Settings>("get_settings");
      setSettings(loaded);
      setCodexPathDraft(loaded.codex_path ?? "");
      setDefaultCwdDraft(loaded.default_cwd ?? "");
      const initialCwd = loaded.last_cwd ?? loaded.default_cwd;
      if (!cwd.trim() && initialCwd) setCwd(initialCwd);
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
      const initialCwd = saved.last_cwd ?? saved.default_cwd;
      if (!cwd.trim() && initialCwd) setCwd(initialCwd);
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
              <button
                className="btn"
                type="button"
                onClick={beginNewSession}
                disabled={startingSessionId != null}
              >
                New
              </button>
              <button
                className="btn"
                type="button"
                onClick={renameActive}
                disabled={!activeSessionId || startingSessionId != null}
              >
                Rename
              </button>
              <button
                className="btn"
                type="button"
                onClick={deleteActive}
                disabled={!activeSessionId || startingSessionId != null}
              >
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
                persistScrollStateForActiveSession();
                void touchSession(s.id);
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
            {blockKindFilter !== "all" || blockQuery.trim() ? (
              <button
                className="chip"
                type="button"
                onClick={() => {
                  setBlockKindFilter("all");
                  setBlockQuery("");
                }}
              >
                Reset
              </button>
            ) : null}
          </div>
          <div className="muted mono results">
            {filteredBlocks.length}/{blocks.length}
          </div>
	        </div>
	
	        {activeSession?.status === "running" ? (
	          <div className="runBanner">
	            <div className="runBannerLine">
	              <span className="runBullet" aria-hidden>
	                •
	              </span>
	              <span className="runBannerTitle">{runHeadline || "Running…"}</span>
	              <span className="runBannerMeta muted mono">
	                (
	                {runElapsedSec != null ? `${runElapsedSec}s • ` : ""}
	                esc to interrupt)
	              </span>
	            </div>
	          </div>
	        ) : null}

	        <div className="timeline" ref={timelineRef} onScroll={onTimelineScroll}>
          <div className="timelineInner">
            {startingSessionId === activeSessionId ? (
              <div className="emptyState">
                <div className="emptyTitle">Starting…</div>
                <div className="muted">Launching a fresh Codex session.</div>
              </div>
            ) : loadingSessionId === activeSessionId ? (
              <div className="emptyState">
                <div className="emptyTitle">Loading…</div>
                <div className="muted">Reading session logs from disk.</div>
              </div>
            ) : filteredBlocks.length === 0 ? (
              <div className="emptyState">
                <div className="emptyTitle">No output yet.</div>
                <div className="muted">
                  Run a session, or clear filters/search if you expect content here.
                </div>
              </div>
            ) : (
              filteredBlocks.map((b) => {
                const subtitle =
                  b.subtitle ?? (b.collapsed ? previewText(b.body) || undefined : undefined);
                return (
                  <section key={b.id} className={`block ${b.kind}`}>
                    <header className="blockHeader">
                      <div className="blockHeaderLeft">
                        <div className="blockTitle">{b.title}</div>
                        {subtitle ? <div className="blockSubtitle muted mono">{subtitle}</div> : null}
                      </div>
                      <div className="blockHeaderRight">
                        {b.status ? <span className={`pill ${b.status}`}>{b.status}</span> : null}
                        <button
                          className="iconBtn blockToggle"
                          type="button"
                          onClick={() =>
                            setCollapsedForActiveSession(b.key, !(b.collapsed ?? false))
                          }
                          aria-label={b.collapsed ? "Expand block" : "Collapse block"}
                          title={b.collapsed ? "Expand" : "Collapse"}
                        >
                          {b.collapsed ? "▸" : "▾"}
                        </button>
                        <div className="muted mono blockTime">
                          {new Date(b.ts_ms).toLocaleTimeString()}
                        </div>
                      </div>
                    </header>
                    {b.collapsed ? null : (
                      <div className="blockBody">
                      {b.kind === "assistant" ? (
                        <div className="markdown compact">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {b.body}
                          </ReactMarkdown>
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
                );
              })
            )}
            <div className="timelineEnd" ref={timelineEndRef} />
          </div>
        </div>

        <div className="composer">
          <div className="composerLeft">
            <textarea
              className="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              onCompositionStart={() => {
                composingPromptRef.current = true;
              }}
              onCompositionEnd={() => {
                composingPromptRef.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const native = e.nativeEvent as any;
                  if (composingPromptRef.current) return;
                  const isComposing = Boolean(native && native.isComposing);
                  const composingKeyCode = native && (native.keyCode === 229 || native.which === 229);
                  if (isComposing || composingKeyCode) return;
                  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
                  e.preventDefault();
                  void runInActiveSession();
                }
                if (e.key === "Escape") {
                  if (!activeSessionId) return;
                  if (activeSession?.status !== "running") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setErrorBanner(null);
                  void invoke("stop_run", { sessionId: activeSessionId }).catch((err) =>
                    setErrorBanner(String(err)),
                  );
                }
              }}
              rows={2}
              placeholder="Describe what you want Codex to do…"
            />
            <div className="cwdRow">
              <button
                className="cwdPill mono"
                type="button"
                onClick={openSessionSettings}
                title={cwd.trim() ? cwd.trim() : settings.last_cwd ?? settings.default_cwd ?? ""}
              >
                {cwd.trim()
                  ? cwd.trim()
                  : settings.last_cwd ?? settings.default_cwd
                    ? `(default) ${settings.last_cwd ?? settings.default_cwd}`
                    : "Pick a working directory…"}
              </button>
              <button className="btn" type="button" onClick={pickCwd}>
                Pick…
              </button>
            </div>
          </div>
          <button
            className="btn primary"
            type="button"
            onClick={runInActiveSession}
            disabled={!prompt.trim() || activeSession?.status === "running"}
          >
            {activeSessionId ? "Continue" : "Run"}
          </button>
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
            <div className="panelTitle">
              TODO{" "}
              <span className="muted">
                {todos.filter((t) => t.done).length}/{todos.length}
              </span>
            </div>
            {todos.length > 0 ? (
              <ul className="todoList">
                {todos.map((t) => (
                  <li key={`${t.done ? "1" : "0"}:${t.text}`} className={`todoItem ${t.done ? "done" : ""}`}>
                    <span className={`todoBox ${t.done ? "done" : ""}`} aria-hidden />
                    <span className="todoLabel">{t.text}</span>
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
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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

      {showSessionSettings ? (
        <div className="modalBackdrop" onClick={closeSessionSettings}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Session settings</div>
              <button className="btn" type="button" onClick={closeSessionSettings}>
                Close
              </button>
            </div>

            <div className="field">
              <label className="label">Working directory (next run)</label>
              <input
                className="input mono"
                value={cwd}
                onChange={(e) => setCwd(e.currentTarget.value)}
                placeholder={
                  settings.last_cwd ?? settings.default_cwd ?? 'e.g. "/Users/you/projects"'
                }
              />
              <div className="row">
                <button className="btn" type="button" onClick={pickCwd}>
                  Pick…
                </button>
                {cwd.trim() ? (
                  <button className="btn" type="button" onClick={() => setCwd("")}>
                    Use default
                  </button>
                ) : null}
              </div>
              <div className="muted">
                {activeSessionId
                  ? "Used the next time you click Continue in this session."
                  : "Used when you start a new session."}
              </div>
            </div>

            <details
              onToggle={(e) => {
                const open = (e.currentTarget as HTMLDetailsElement).open;
                setShowCwdShell(open);
                if (!open) {
                  void invoke("stop_shell").catch(() => {});
                }
              }}
            >
              <summary className="detailsSummary">Advanced: zsh (cd …)</summary>
              <div className="muted" style={{ marginTop: 8, marginBottom: 10 }}>
                Type <span className="mono">cd &lt;path&gt;</span> and press{" "}
                <span className="mono">Enter</span> to update the working directory.
              </div>
              {showCwdShell ? (
                <CwdShell
                  className="large"
                  initialCwd={cwd}
                  onCwd={(next) => {
                    if (cwd === next) return;
                    setCwd(next);
                  }}
                  onError={(msg) => setErrorBanner(msg)}
                />
              ) : null}
            </details>
          </div>
        </div>
      ) : null}

      {showRename ? (
        <div className="modalBackdrop" onClick={() => setShowRename(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Rename session</div>
              <button className="btn" type="button" onClick={() => setShowRename(false)}>
                Close
              </button>
            </div>

            <div className="field">
              <label className="label">Title</label>
              <input
                className="input"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.currentTarget.value)}
                placeholder="Session title"
              />
              <div className="row">
                <button className="btn" type="button" onClick={() => setShowRename(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  type="button"
                  disabled={!renameDraft.trim() || renameSaving || !activeSessionId}
                  onClick={async () => {
                    if (!activeSessionId) return;
                    const title = renameDraft.trim();
                    if (!title) return;
                    setErrorBanner(null);
                    setRenameSaving(true);
                    try {
                      await invoke("rename_session", { sessionId: activeSessionId, title });
                      setShowRename(false);
                      await refreshSessions(activeSessionId);
                    } catch (e) {
                      setErrorBanner(String(e));
                    } finally {
                      setRenameSaving(false);
                    }
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
