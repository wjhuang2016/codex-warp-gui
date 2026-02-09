import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";
import { CwdShell } from "./CwdShell";
import { CodeFrame } from "./CodeFrame";

const EMPTY_BLOCKS: Block[] = [];
const IS_TAURI =
  typeof (window as any).__TAURI__ !== "undefined" ||
  typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

type ConnectionMode = "local" | "remote";

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
  context_window?: number | null;
  context_used_tokens?: number | null;
  context_left_pct?: number | null;
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

type ContextMetrics = {
  session_id: string;
  ts_ms: number;
  context_left_pct: number;
  context_used_tokens: number;
  context_window: number;
};

type UsageRecord = {
  ts_ms: number;
  session_id: string;
  thread_id?: string | null;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cached_input_tokens: number;
  context_window: number;
};

type RunFinished = {
  session_id: string;
  ts_ms: number;
  exit_code: number | null;
  success: boolean;
};

type SkillSummary = {
  name: string;
  description: string;
  path: string;
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

function quotePathIfNeeded(path: string): string {
  if (!path) return path;
  if (/[ \t]/.test(path)) return JSON.stringify(path);
  return path;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function mimeToExt(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "png";
}

function dayKeyLocal(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type TimelineProps = {
  activeSessionId: string;
  filteredBlocks: Block[];
  startingSessionId: string | null;
  loadingSessionId: string | null;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  timelineEndRef: React.RefObject<HTMLDivElement | null>;
  onTimelineScroll: () => void;
  setCollapsedForActiveSession: (blockKey: string, collapsed: boolean) => void;
  markdownComponents: Components;
};

const Timeline = memo(function Timeline({
  activeSessionId,
  filteredBlocks,
  startingSessionId,
  loadingSessionId,
  timelineRef,
  timelineEndRef,
  onTimelineScroll,
  setCollapsedForActiveSession,
  markdownComponents,
}: TimelineProps) {
  return (
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
                      <div className="markdown compact thoughtMarkdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {b.body}
                        </ReactMarkdown>
                      </div>
                    ) : b.kind === "command" ? (
                      <CodeFrame text={b.body || "(no output yet)"} />
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
  );
});

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

function normalizeCwdPath(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  // Normalize trailing slashes for stable grouping.
  return t.replace(/[\\/]+$/, "");
}

function basenameFromPath(raw: string): string {
  const t = normalizeCwdPath(raw);
  if (!t) return "";
  const parts = t.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? t;
}

function projectFromCwd(cwd: string | null | undefined): { key: string; label: string; path: string | null } {
  const norm = normalizeCwdPath(cwd ?? "");
  if (!norm) return { key: "__no_project__", label: "No project", path: null };
  const label = basenameFromPath(norm) || norm;
  return { key: norm, label, path: norm };
}

function sortSessionsByRecency(items: SessionMeta[]): SessionMeta[] {
  return items
    .slice()
    .sort((a, b) => (b.last_used_at_ms || b.created_at_ms) - (a.last_used_at_ms || a.created_at_ms));
}

function normalizeBaseUrl(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  return t.replace(/\/+$/, "");
}

function joinBaseUrl(base: string, path: string): string {
  const b = normalizeBaseUrl(base);
  if (!b) return path;
  if (!path) return b;
  if (path.startsWith("/")) return `${b}${path}`;
  return `${b}/${path}`;
}

const TOOL_MARKUP_RE = /[ \t]*\uE200[^\uE201]*\uE201/g;
function stripToolCitations(text: string): string {
  if (!text) return text;
  if (!text.includes("\uE200")) return text;
  return text.replace(TOOL_MARKUP_RE, "");
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;
const ANSI_ESCAPE_RE_ALT = /\u009b[0-9;]*m/g;
const ANSI_ESCAPE_RE_FALLBACK = /\uFFFD\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  if (!text) return text;
  return text
    .replace(ANSI_ESCAPE_RE, "")
    .replace(ANSI_ESCAPE_RE_ALT, "")
    .replace(ANSI_ESCAPE_RE_FALLBACK, "");
}

function parseIsoTimestampMs(text: string): number | null {
  const cleaned = stripAnsi(text);
  const m = cleaned.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z/);
  if (!m) return null;
  const base = m[1];
  let frac = m[3] ?? "";
  if (frac.length > 3) frac = frac.slice(0, 3);
  if (frac.length > 0) frac = frac.padEnd(3, "0");
  const iso = `${base}${frac ? `.${frac}` : ""}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
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

type PlanStepStatus = "pending" | "in_progress" | "completed";
type PlanStep = {
  step: string;
  status: PlanStepStatus;
};
type PlanState = {
  ts_ms: number;
  explanation: string | null;
  steps: PlanStep[];
};

type ActivityItem = {
  id: string;
  ts_ms: number;
  text: string;
};

type ProjectGroup = {
  key: string;
  label: string;
  path: string | null;
  sessions: SessionMeta[];
  lastUsedAt: number;
};

const THREADS_PAGE_SIZE = 30;
const THREADS_SCROLL_THRESHOLD_PX = 140;

type SkillPickerState = {
  start: number;
  end: number;
  query: string;
  selected: number;
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

function extractRolloutContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    const t = typeof (item as any).type === "string" ? String((item as any).type) : "";
    if (t !== "input_text" && t !== "output_text") continue;
    const text = typeof (item as any).text === "string" ? String((item as any).text) : "";
    if (text) parts.push(text);
  }
  return parts.join("");
}

function shouldShowRolloutUserText(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.startsWith("# AGENTS.md")) return false;
  if (t.startsWith("<environment_context")) return false;
  if (t.includes("<INSTRUCTIONS>")) return false;
  return true;
}

function parseExitCodeFromToolOutput(output: string): number | null {
  const m = output.match(/Exit code:\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function hasRecentPromptBlock(blocks: Block[], text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  const start = Math.max(0, blocks.length - 8);
  for (let i = blocks.length - 1; i >= start; i -= 1) {
    const b = blocks[i];
    if (b.kind !== "status") continue;
    if (b.title !== "Prompt") continue;
    if ((b.body || "").trim() === t) return true;
  }
  return false;
}

function hasRecentThoughtBlock(blocks: Block[], text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  const start = Math.max(0, blocks.length - 8);
  for (let i = blocks.length - 1; i >= start; i -= 1) {
    const b = blocks[i];
    if (b.kind !== "thought") continue;
    if ((b.body || "").trim() === t) return true;
  }
  return false;
}

function runActivityTextFromJson(json: unknown): string | null {
  if (!isObject(json)) return null;
  const method = typeof (json as any).method === "string" ? String((json as any).method) : "";
  if (!method.startsWith("codex/event/")) return null;

  const params = isObject((json as any).params) ? ((json as any).params as any) : {};
  const messageFields = ["message", "summary", "text", "title", "label", "name"];
  for (const k of messageFields) {
    const v = params && typeof params[k] === "string" ? String(params[k]).trim() : "";
    if (v) return stripToolCitations(v);
  }

  const short = method.slice("codex/event/".length).replace(/\//g, " ");
  const parts: string[] = [short || "event"];
  const query = params && typeof params.query === "string" ? params.query.trim() : "";
  const path = params && typeof params.path === "string" ? params.path.trim() : "";
  const tool = params && typeof params.tool === "string" ? params.tool.trim() : "";
  if (query) parts.push(query);
  if (path) parts.push(path);
  if (tool) parts.push(tool);
  return stripToolCitations(parts.filter(Boolean).join(" • "));
}

function normalizePlanStepStatus(status: unknown): PlanStepStatus {
  const raw = typeof status === "string" ? status.trim() : "";
  const lower = raw.toLowerCase();
  if (lower === "inprogress" || lower === "in_progress" || lower === "in progress") return "in_progress";
  if (lower === "completed" || lower === "done" || lower === "complete") return "completed";
  return "pending";
}

function parsePlanUpdateFromJson(
  json: unknown,
): Omit<PlanState, "ts_ms"> | null {
  if (!isObject(json)) return null;
  const method = typeof (json as any).method === "string" ? String((json as any).method) : "";
  if (!method.startsWith("turn/plan/")) return null;

  const params = isObject((json as any).params) ? ((json as any).params as any) : null;
  if (!params || !Array.isArray(params.plan)) return null;

  const steps: PlanStep[] = [];
  for (const item of params.plan) {
    if (!isObject(item)) continue;
    const step = typeof (item as any).step === "string" ? String((item as any).step).trim() : "";
    if (!step) continue;
    const status = normalizePlanStepStatus((item as any).status);
    steps.push({ step, status });
  }

  const explanationRaw = params && typeof params.explanation === "string" ? String(params.explanation).trim() : "";
  const explanation = explanationRaw ? explanationRaw : null;
  return { explanation, steps };
}

function computeSkillTrigger(text: string, cursor: number): Omit<SkillPickerState, "selected"> | null {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, pos);
  const idx = before.lastIndexOf("$");
  if (idx === -1) return null;
  if (idx > 0 && !/\s/.test(before[idx - 1])) return null;
  const query = before.slice(idx + 1);
  if (!/^[a-zA-Z0-9_-]*$/.test(query)) return null;
  return { start: idx, end: pos, query };
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
  copy.splice(idx, 1);
  copy.push(updated);
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
  copy.splice(idx, 1);
  copy.push(updated);
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
  copy.splice(idx, 1);
  copy.push(updated);
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

    if (method.startsWith("turn/plan/")) {
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

  // Codex native rollout JSONL ("~/.codex/sessions/**/rollout-*.jsonl")
  if (type === "session_meta" || type === "turn_context") {
    return blocks;
  }

  if (type === "event_msg" && isObject((e.json as any).payload)) {
    const payload = (e.json as any).payload as any;
    const pType = typeof payload.type === "string" ? String(payload.type) : "";
    if (!pType) return blocks;
    if (pType === "token_count" || pType === "agent_message") {
      return blocks;
    }
    if (pType === "agent_reasoning") {
      const text = stripToolCitations(typeof payload.text === "string" ? String(payload.text) : "");
      if (!text.trim()) return blocks;
      if (hasRecentThoughtBlock(blocks, text)) return blocks;
      return [
        ...blocks,
        {
          id: newId(),
          key: `rollout:agent_reasoning:${e.ts_ms}:${Math.random()}`,
          kind: "thought",
          title: "Thought",
          body: text,
          ts_ms: e.ts_ms,
        },
      ];
    }
    if (pType === "user_message") {
      const message = stripToolCitations(
        typeof payload.message === "string" ? String(payload.message) : "",
      );
      if (!message.trim()) return blocks;
      if (hasRecentPromptBlock(blocks, message)) return blocks;
      const key = `rollout:user_message:${e.ts_ms}`;
      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "status",
        title: "Prompt",
        body: message,
        ts_ms: e.ts_ms,
      });
    }
    if (pType === "error") {
      const message = typeof payload.message === "string" ? String(payload.message) : "";
      if (!message.trim()) return blocks;
      return [
        ...blocks,
        {
          id: newId(),
          key: `rollout:error:${e.ts_ms}:${Math.random()}`,
          kind: "error",
          title: "Error",
          body: message,
          ts_ms: e.ts_ms,
        },
      ];
    }
    return blocks;
  }

  if (type === "response_item" && isObject((e.json as any).payload)) {
    const payload = (e.json as any).payload as any;
    const pType = typeof payload.type === "string" ? String(payload.type) : "";
    if (!pType) return blocks;

    if (pType === "message") {
      const role = typeof payload.role === "string" ? String(payload.role) : "";
      if (role === "assistant") {
        const text = stripToolCitations(extractRolloutContentText(payload.content));
        if (!text.trim()) return blocks;
        return [
          ...blocks,
          {
            id: newId(),
            key: `rollout:assistant:${e.ts_ms}:${Math.random()}`,
            kind: "assistant",
            title: "Assistant",
            body: text,
            ts_ms: e.ts_ms,
          },
        ];
      }
      if (role === "user") {
        const text = stripToolCitations(extractRolloutContentText(payload.content));
        if (!shouldShowRolloutUserText(text)) return blocks;
        if (hasRecentPromptBlock(blocks, text)) return blocks;
        const key = `rollout:user:${e.ts_ms}`;
        return upsertBlock(blocks, {
          id: key,
          key,
          kind: "status",
          title: "Prompt",
          body: text,
          ts_ms: e.ts_ms,
        });
      }
      return blocks;
    }

    if (pType === "reasoning") {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const parts: string[] = [];
      for (const item of summary) {
        if (!isObject(item)) continue;
        if (String((item as any).type) !== "summary_text") continue;
        const text = typeof (item as any).text === "string" ? String((item as any).text) : "";
        if (text) parts.push(text);
      }
      const text = stripToolCitations(parts.join("\n\n"));
      if (!text.trim()) return blocks;
      if (hasRecentThoughtBlock(blocks, text)) return blocks;
      return [
        ...blocks,
        {
          id: newId(),
          key: `rollout:reasoning:${e.ts_ms}:${Math.random()}`,
          kind: "thought",
          title: "Thought",
          body: text,
          ts_ms: e.ts_ms,
        },
      ];
    }

    if (pType === "function_call") {
      const callId = typeof payload.call_id === "string" ? String(payload.call_id) : "";
      const tool = typeof payload.name === "string" ? String(payload.name) : "tool";
      const argsRaw = typeof payload.arguments === "string" ? String(payload.arguments) : "";
      let subtitle: string | undefined;
      if (argsRaw) {
        try {
          const parsed = JSON.parse(argsRaw) as any;
          const cmd = typeof parsed?.command === "string" ? String(parsed.command) : "";
          const wd = typeof parsed?.workdir === "string" ? String(parsed.workdir) : "";
          if (cmd) subtitle = summarizeCommand(cmd);
          if (wd && subtitle) subtitle = `${subtitle} • ${wd}`;
          if (!subtitle && wd) subtitle = wd;
        } catch {
          // ignore
        }
      }
      const key = callId ? `call:${callId}` : `call:${e.ts_ms}:${Math.random()}`;
      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "command",
        title: tool === "shell_command" ? "Command" : `Tool: ${tool}`,
        subtitle,
        body: "",
        ts_ms: e.ts_ms,
        status: "in_progress",
      });
    }

    if (pType === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? String(payload.call_id) : "";
      const output = stripToolCitations(typeof payload.output === "string" ? String(payload.output) : "");
      if (!output.trim()) return blocks;
      const key = callId ? `call:${callId}` : `call:${e.ts_ms}:${Math.random()}`;
      const exitCode = parseExitCodeFromToolOutput(output);
      const status = exitCode == null ? "completed" : exitCode === 0 ? "completed" : "failed";
      const autoCollapse = output.length > 1400 ? true : undefined;
      return upsertBlock(blocks, {
        id: key,
        key,
        kind: "command",
        title: "Command",
        body: output,
        ts_ms: e.ts_ms,
        status,
        collapsed: autoCollapse,
      });
    }

    return blocks;
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
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() => {
    const stored = localStorage.getItem("codex_warp_connection_mode");
    if (stored === "local" || stored === "remote") return stored;
    return IS_TAURI ? "local" : "remote";
  });
  const isRemote = connectionMode === "remote";
  const [remoteBaseUrl, setRemoteBaseUrl] = useState(() =>
    localStorage.getItem("codex_warp_remote_base_url") ?? "",
  );
  const [remoteBaseUrlDraft, setRemoteBaseUrlDraft] = useState("");
  const [checkingRemote, setCheckingRemote] = useState(false);

  const [mobilePanel, setMobilePanel] = useState<null | "sessions" | "right">(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionSettings, setShowSessionSettings] = useState(false);
  const [showTerminalDrawer, setShowTerminalDrawer] = useState(false);
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
  const [activityBySession, setActivityBySession] = useState<Record<string, ActivityItem[]>>({});
  const [planBySession, setPlanBySession] = useState<Record<string, PlanState>>({});
  const [metricsBySession, setMetricsBySession] = useState<Record<string, ContextMetrics>>({});
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [activeProjectKey, setActiveProjectKey] = useState(() => {
    return localStorage.getItem("codex_warp_active_project") ?? "all";
  });
  const [threadsLimitByProject, setThreadsLimitByProject] = useState<Record<string, number>>({});
  const [skillPicker, setSkillPicker] = useState<SkillPickerState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [blockQuery, setBlockQuery] = useState("");
  const [blockKindFilter, setBlockKindFilter] = useState<BlockKind | "all">("all");
  const [rightTab, setRightTab] = useState<"todo" | "preview" | "usage">("todo");
  const [showRename, setShowRename] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [runStartedAtBySession, setRunStartedAtBySession] = useState<Record<string, number>>({});
  const [lastPromptBySession, setLastPromptBySession] = useState<Record<string, string>>({});
  const [tickerMs, setTickerMs] = useState(() => Date.now());

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const threadListRef = useRef<HTMLDivElement | null>(null);
  const threadMoreRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const composingPromptRef = useRef(false);
  const scrollStateBySessionRef = useRef<
    Record<string, { scrollTop: number; stickToBottom: boolean }>
  >({});
  const activeSessionIdRef = useRef("");
  const activeSessionStatusRef = useRef<SessionStatus | null>(null);
  const showSettingsRef = useRef(false);
  const showSessionSettingsRef = useRef(false);
  const showTerminalDrawerRef = useRef(false);
  const showRenameRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);

  const insertPromptText = useCallback((text: string) => {
    if (!text) return;
    const el = promptRef.current;
    if (!el) {
      setPrompt((prev) => prev + text);
      return;
    }
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
    const value = el.value;
    const next = value.slice(0, start) + text + value.slice(end);
    setPrompt(next);
    const pos = start + text.length;
    requestAnimationFrame(() => {
      const el2 = promptRef.current;
      if (!el2) return;
      el2.focus();
      el2.selectionStart = pos;
      el2.selectionEnd = pos;
    });
  }, []);

  const apiBaseUrl = useMemo(() => normalizeBaseUrl(remoteBaseUrl), [remoteBaseUrl]);
  const apiUrl = useCallback((path: string) => joinBaseUrl(apiBaseUrl, path), [apiBaseUrl]);

  const apiFetchJson = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(apiUrl(path), {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init?.headers || {}),
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || res.statusText);
      }
      return (await res.json()) as T;
    },
    [apiUrl],
  );

  const apiFetchText = useCallback(
    async (path: string, init?: RequestInit): Promise<string> => {
      const res = await fetch(apiUrl(path), init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || res.statusText);
      }
      return await res.text();
    },
    [apiUrl],
  );

  const apiFetchOk = useCallback(
    async (path: string, init?: RequestInit): Promise<void> => {
      const res = await fetch(apiUrl(path), init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || res.statusText);
      }
    },
    [apiUrl],
  );

  useEffect(() => {
    localStorage.setItem("codex_warp_connection_mode", connectionMode);
  }, [connectionMode]);

  useEffect(() => {
    localStorage.setItem("codex_warp_remote_base_url", remoteBaseUrl);
  }, [remoteBaseUrl]);

  useEffect(() => {
    localStorage.setItem("codex_warp_active_project", activeProjectKey);
  }, [activeProjectKey]);

  useEffect(() => {
    if (!IS_TAURI || isRemote) {
      setShowTerminalDrawer(false);
    }
  }, [isRemote]);

  const stopRun = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      if (IS_TAURI && !isRemote) {
        await invoke("stop_run", { sessionId });
        return;
      }
      await apiFetchOk(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
      });
    },
    [apiFetchOk, isRemote],
  );

  const updateSkillPickerFromText = useCallback((text: string, cursor: number) => {
    const trigger = computeSkillTrigger(text, cursor);
    if (!trigger) {
      setSkillPicker(null);
      return;
    }
    setSkillPicker((prev) => {
      if (!prev) return { ...trigger, selected: 0 };
      const same = prev.start === trigger.start && prev.query === trigger.query;
      return { ...trigger, selected: same ? prev.selected : 0 };
    });
  }, []);

  const replacePromptRange = useCallback((start: number, end: number, replacement: string) => {
    setPrompt((prev) => prev.slice(0, start) + replacement + prev.slice(end));
    requestAnimationFrame(() => {
      const el = promptRef.current;
      if (!el) return;
      const pos = start + replacement.length;
      el.focus();
      el.selectionStart = pos;
      el.selectionEnd = pos;
      updateSkillPickerFromText(el.value, pos);
    });
  }, [updateSkillPickerFromText]);

  const skillMatches = useMemo(() => {
    if (!skillPicker) return [];
    const q = skillPicker.query.trim().toLowerCase();
    const items = skills
      .filter((s) => {
        if (!q) return true;
        const name = (s.name || "").toLowerCase();
        const desc = (s.description || "").toLowerCase();
        return name.includes(q) || desc.includes(q);
      })
      .sort((a, b) => {
        const qLower = q;
        const an = (a.name || "").toLowerCase();
        const bn = (b.name || "").toLowerCase();
        const ap = !qLower ? 0 : an.startsWith(qLower) ? 0 : an.includes(qLower) ? 1 : 2;
        const bp = !qLower ? 0 : bn.startsWith(qLower) ? 0 : bn.includes(qLower) ? 1 : 2;
        if (ap !== bp) return ap - bp;
        return an.localeCompare(bn);
      });
    return items.slice(0, 24);
  }, [skillPicker, skills]);

  useEffect(() => {
    if (!skillPicker) return;
    if (skillMatches.length === 0) return;
    if (skillPicker.selected >= 0 && skillPicker.selected < skillMatches.length) return;
    setSkillPicker((prev) =>
      prev ? { ...prev, selected: Math.max(0, Math.min(prev.selected, skillMatches.length - 1)) } : prev,
    );
  }, [skillMatches.length, skillPicker]);

  const applySkill = useCallback(
    (name: string) => {
      if (!skillPicker) return;
      const replacement = `$${name} `;
      replacePromptRange(skillPicker.start, skillPicker.end, replacement);
      setSkillPicker(null);
    },
    [replacePromptRange, skillPicker],
  );

  const onPromptChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.currentTarget.value;
      const cursor = e.currentTarget.selectionStart ?? next.length;
      setPrompt(next);
      updateSkillPickerFromText(next, cursor);
    },
    [updateSkillPickerFromText],
  );

  const blocks = useMemo(
    () => blocksBySession[activeSessionId] ?? EMPTY_BLOCKS,
    [activeSessionId, blocksBySession],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const map = new Map<string, ProjectGroup>();
    for (const s of sessions) {
      const { key, label, path } = projectFromCwd(s.cwd);
      const lastUsedAt = s.last_used_at_ms || s.created_at_ms || 0;
      const existing =
        map.get(key) ??
        {
          key,
          label,
          path,
          sessions: [],
          lastUsedAt,
        };
      existing.sessions.push(s);
      existing.lastUsedAt = Math.max(existing.lastUsedAt, lastUsedAt);
      map.set(key, existing);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.sessions = sortSessionsByRecency(g.sessions);
    }
    groups.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.label.localeCompare(b.label));
    return groups;
  }, [sessions]);

  useEffect(() => {
    if (activeProjectKey === "all") return;
    if (projectGroups.some((g) => g.key === activeProjectKey)) return;
    setActiveProjectKey("all");
  }, [activeProjectKey, projectGroups]);

  const activeProjectLabel = useMemo(() => {
    if (activeProjectKey === "all") return "All projects";
    const g = projectGroups.find((x) => x.key === activeProjectKey);
    return g ? g.label : "All projects";
  }, [activeProjectKey, projectGroups]);

  const sessionsForActiveProject = useMemo(() => {
    if (activeProjectKey === "all") return sessions;
    return sessions.filter((s) => projectFromCwd(s.cwd).key === activeProjectKey);
  }, [activeProjectKey, sessions]);

  useEffect(() => {
    setThreadsLimitByProject((prev) => {
      if (prev[activeProjectKey] != null) return prev;
      const initial = Math.min(THREADS_PAGE_SIZE, sessionsForActiveProject.length || THREADS_PAGE_SIZE);
      return { ...prev, [activeProjectKey]: initial };
    });
    // We only care about length for initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectKey]);

  const visibleThreadsLimit = threadsLimitByProject[activeProjectKey] ?? THREADS_PAGE_SIZE;
  const visibleSessionsForActiveProject = useMemo(() => {
    if (visibleThreadsLimit <= 0) return [];
    return sessionsForActiveProject.slice(0, visibleThreadsLimit);
  }, [sessionsForActiveProject, visibleThreadsLimit]);
  const hasMoreThreads = visibleSessionsForActiveProject.length < sessionsForActiveProject.length;

  const onThreadListScroll = useCallback(() => {
    const el = threadListRef.current;
    if (!el) return;
    if (!hasMoreThreads) return;
    const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (remaining > THREADS_SCROLL_THRESHOLD_PX) return;
    setThreadsLimitByProject((prev) => {
      const cur = prev[activeProjectKey] ?? THREADS_PAGE_SIZE;
      const next = Math.min(cur + THREADS_PAGE_SIZE, sessionsForActiveProject.length);
      if (next <= cur) return prev;
      return { ...prev, [activeProjectKey]: next };
    });
  }, [activeProjectKey, hasMoreThreads, sessionsForActiveProject.length]);

  useEffect(() => {
    const root = threadListRef.current;
    const target = threadMoreRef.current;
    if (!root || !target) return;
    if (!hasMoreThreads) return;

    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setThreadsLimitByProject((prev) => {
          const cur = prev[activeProjectKey] ?? THREADS_PAGE_SIZE;
          const next = Math.min(cur + THREADS_PAGE_SIZE, sessionsForActiveProject.length);
          if (next <= cur) return prev;
          return { ...prev, [activeProjectKey]: next };
        });
      },
      {
        root,
        rootMargin: `0px 0px ${THREADS_SCROLL_THRESHOLD_PX}px 0px`,
        threshold: 0.01,
      },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [activeProjectKey, hasMoreThreads, sessionsForActiveProject.length]);

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
              if (IS_TAURI) {
                void openUrl(url).catch((err) => setErrorBanner(String(err)));
              } else {
                try {
                  window.open(url, "_blank", "noopener,noreferrer");
                } catch (err) {
                  setErrorBanner(String(err));
                }
              }
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
    showTerminalDrawerRef.current = showTerminalDrawer;
    showRenameRef.current = showRename;
  }, [
    activeSession?.status,
    activeSessionId,
    showRename,
    showSettings,
    showSessionSettings,
    showTerminalDrawer,
  ]);

  useEffect(() => {
    if (!IS_TAURI || isRemote) return;
    let unlisten: null | (() => void) = null;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        const payload: DragDropEvent = event.payload;
        if (payload.type !== "drop") return;
        if (!payload.paths?.length) return;
        const rawPaths = payload.paths.slice();
        const sid = activeSessionIdRef.current || null;
        setErrorBanner(null);
        void (async () => {
          try {
            const imported = await invoke<string[]>("import_dropped_files", {
              sessionId: sid,
              paths: rawPaths,
            });
            const next = imported.length > 0 ? imported : rawPaths;
            insertPromptText(next.map(quotePathIfNeeded).join("\n"));
          } catch (err) {
            setErrorBanner(String(err));
            insertPromptText(rawPaths.map(quotePathIfNeeded).join("\n"));
          }
        })();
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [insertPromptText, isRemote]);

  function closeSessionSettings() {
    setShowSessionSettings(false);
  }

  const onPromptPaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!IS_TAURI || isRemote) return;
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const images: File[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const type = item.type || "";
        if (!type.toLowerCase().startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) images.push(file);
      }
      if (images.length === 0) return;

      e.preventDefault();
      setErrorBanner(null);

      try {
        for (let i = 0; i < images.length; i++) {
          const file = images[i];
          const buffer = await file.arrayBuffer();
          const dataBase64 = arrayBufferToBase64(buffer);
          const ext = mimeToExt(file.type);
          const path = await invoke<string>("save_pasted_image", {
            sessionId: activeSessionId || null,
            ext,
            dataBase64,
          });
          insertPromptText(path + (i === images.length - 1 ? "" : "\n"));
        }
      } catch (err) {
        setErrorBanner(String(err));
      }
    },
    [activeSessionId, insertPromptText, isRemote],
  );

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
      if (showTerminalDrawerRef.current && activeSessionStatusRef.current !== "running") {
        e.preventDefault();
        setShowTerminalDrawer(false);
        return;
      }
      if (activeSessionStatusRef.current !== "running") return;
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      e.preventDefault();
      setErrorBanner(null);
      void stopRun(sid).catch((err) => setErrorBanner(String(err)));
    }

    // Capture to ensure Escape works even if focused widgets stop propagation (xterm, inputs, etc).
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [stopRun]);

  useEffect(() => {
    if (activeSession?.status !== "running") return;
    const id = window.setInterval(() => setTickerMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [activeSession?.status, activeSessionId]);

  const activePlan = useMemo(
    () => planBySession[activeSessionId] ?? null,
    [activeSessionId, planBySession],
  );
  const planSteps = activePlan?.steps ?? [];
  const planExplanation = activePlan?.explanation ?? null;

  const todos = useMemo(() => extractTodos(blocks), [blocks]);
  const planDoneCount = planSteps.reduce((acc, s) => acc + (s.status === "completed" ? 1 : 0), 0);
  const todosDoneCount = todos.reduce((acc, t) => acc + (t.done ? 1 : 0), 0);
  const totalTodoCount = planSteps.length + todos.length;
  const doneTodoCount = planDoneCount + todosDoneCount;
  const hasAnyTodos = totalTodoCount > 0;
  const conclusion = useMemo(
    () => conclusionBySession[activeSessionId] ?? "",
    [activeSessionId, conclusionBySession],
  );

  const dailyUsage = useMemo(() => {
    const map = new Map<
      string,
      {
        dayKey: string;
        total: number;
        input: number;
        output: number;
        reasoning: number;
        cached: number;
        runs: number;
      }
    >();

    for (const r of usageRecords) {
      const key = dayKeyLocal(r.ts_ms);
      const cur =
        map.get(key) ??
        {
          dayKey: key,
          total: 0,
          input: 0,
          output: 0,
          reasoning: 0,
          cached: 0,
          runs: 0,
        };
      map.set(key, {
        dayKey: key,
        total: cur.total + (r.total_tokens || 0),
        input: cur.input + (r.input_tokens || 0),
        output: cur.output + (r.output_tokens || 0),
        reasoning: cur.reasoning + (r.reasoning_output_tokens || 0),
        cached: cur.cached + (r.cached_input_tokens || 0),
        runs: cur.runs + 1,
      });
    }

    return [...map.values()].sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  }, [usageRecords]);

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

  const contextLeftPct = useMemo(() => {
    if (!activeSessionId) return null;
    const live = metricsBySession[activeSessionId]?.context_left_pct;
    if (typeof live === "number") return live;
    const persisted = activeSession?.context_left_pct;
    return typeof persisted === "number" ? persisted : null;
  }, [activeSession?.context_left_pct, activeSessionId, metricsBySession]);

  const contextUsage = useMemo(() => {
    if (!activeSessionId) return null;
    const live = metricsBySession[activeSessionId];
    const pct = typeof live?.context_left_pct === "number" ? live.context_left_pct : null;
    const used =
      typeof live?.context_used_tokens === "number" ? live.context_used_tokens : null;
    const window = typeof live?.context_window === "number" ? live.context_window : null;
    if (pct != null) return { pct, used, window };

    const persistedPct =
      typeof activeSession?.context_left_pct === "number" ? activeSession.context_left_pct : null;
    if (persistedPct == null) return null;
    const persistedUsed =
      typeof activeSession?.context_used_tokens === "number"
        ? activeSession.context_used_tokens
        : null;
    const persistedWindow =
      typeof activeSession?.context_window === "number" ? activeSession.context_window : null;
    return { pct: persistedPct, used: persistedUsed, window: persistedWindow };
  }, [
    activeSession?.context_left_pct,
    activeSession?.context_used_tokens,
    activeSession?.context_window,
    activeSessionId,
    metricsBySession,
  ]);

  const runHeadline = useMemo(() => {
    if (!activeSessionId) return "";
    const p = lastPromptBySession[activeSessionId];
    if (p && p.trim()) return clampTitle(p, 84);
    if (activeSession?.title) return clampTitle(activeSession.title, 84);
    return "";
  }, [activeSession?.title, activeSessionId, lastPromptBySession]);

  const runActivity = useMemo(
    () => activityBySession[activeSessionId] ?? [],
    [activityBySession, activeSessionId],
  );
  const recentRunActivity = useMemo(() => runActivity.slice(-4), [runActivity]);

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

  const setCollapsedForActiveSession = useCallback(
    (blockKey: string, collapsed: boolean) => {
      if (!activeSessionId) return;
      setBlocksBySession((prev) => {
        const list = prev[activeSessionId] ?? [];
        const nextList = list.map((b) => (b.key === blockKey ? { ...b, collapsed } : b));
        return { ...prev, [activeSessionId]: nextList };
      });
    },
    [activeSessionId],
  );

  async function loadSession(session: SessionMeta) {
    const loadId = session.id;
    setLoadingSessionId(loadId);
    setErrorBanner(null);
    try {
      if (!IS_TAURI || isRemote) {
        setBlocksBySession((prev) => ({ ...prev, [session.id]: [] }));
        setConclusionBySession((prev) => ({ ...prev, [session.id]: "" }));
        connectRemoteStream(session.id, 4000);
        const conclusionText = await apiFetchText(
          `/api/sessions/${encodeURIComponent(session.id)}/conclusion`,
        ).catch(() => "");
        setConclusionBySession((prev) => ({
          ...prev,
          [session.id]: stripToolCitations(conclusionText),
        }));
        return;
      }

      const [lines, stderrLines, conclusionText] = await Promise.all([
        invoke<string[]>("read_session_events", { sessionId: session.id }),
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
          ts_ms:
            isObject(json) && typeof (json as any)._ts_ms === "number" && Number.isFinite((json as any)._ts_ms)
              ? Number((json as any)._ts_ms)
              : session.created_at_ms + idx,
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

      const stderrEvents: UiEvent[] = stderrLines.map((raw, idx) => {
        const parsed = parseIsoTimestampMs(raw);
        return {
          session_id: session.id,
          ts_ms: parsed ?? session.created_at_ms + lines.length + idx,
          stream: "stderr",
          raw,
          json: null,
        };
      });

      let nextBlocks: Block[] = [];
      let nextPlan: PlanState | null = null;
      for (const evt of [...events, ...stderrEvents]) {
        const plan = parsePlanUpdateFromJson(evt.json);
        if (plan) {
          nextPlan = { ts_ms: evt.ts_ms, explanation: plan.explanation, steps: plan.steps };
        }
        nextBlocks = applyUiEventToBlocks(nextBlocks, evt);
      }

      setBlocksBySession((prev) => ({ ...prev, [session.id]: nextBlocks }));
      setConclusionBySession((prev) => ({
        ...prev,
        [session.id]: stripToolCitations(conclusionText),
      }));
      setPlanBySession((prev) => {
        if (nextPlan) return { ...prev, [session.id]: nextPlan };
        if (!(session.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[session.id];
        return copy;
      });
    } catch (e) {
      setErrorBanner(String(e));
    } finally {
      setLoadingSessionId((cur) => (cur === loadId ? null : cur));
    }
  }

  async function refreshSessions(nextActiveId?: string) {
    setErrorBanner(null);
    try {
      const loaded =
        IS_TAURI && !isRemote
          ? await invoke<SessionMeta[]>("list_sessions")
          : await apiFetchJson<SessionMeta[]>("/api/sessions");
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

  const refreshUsageRecords = useCallback(async () => {
    setUsageLoading(true);
    try {
      const loaded =
        IS_TAURI && !isRemote
          ? await invoke<UsageRecord[]>("list_usage_records", { maxRecords: 5000 })
          : await apiFetchJson<UsageRecord[]>("/api/usage?max_records=5000");
      setUsageRecords(loaded);
    } catch {
      // ignore
    } finally {
      setUsageLoading(false);
    }
  }, [apiFetchJson, isRemote]);

  const closeRemoteStream = useCallback(() => {
    const cur = eventSourceRef.current;
    if (cur) {
      try {
        cur.close();
      } catch {
        // ignore
      }
    }
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
  }, []);

  const connectRemoteStream = useCallback(
    (sessionId: string, tail: number) => {
      if (!sessionId) return;
      if (!isRemote) return;

      if (eventSourceSessionIdRef.current === sessionId && eventSourceRef.current) {
        return;
      }

      closeRemoteStream();
      const url = apiUrl(
        `/api/sessions/${encodeURIComponent(sessionId)}/stream?tail=${encodeURIComponent(
          String(tail),
        )}`,
      );
      const es = new EventSource(url);
      eventSourceRef.current = es;
      eventSourceSessionIdRef.current = sessionId;

      es.onopen = () => {
        setLoadingSessionId((cur) => (cur === sessionId ? null : cur));
      };

      es.addEventListener("codex_event", (evt) => {
        const data = (evt as MessageEvent).data;
        if (typeof data !== "string" || !data) return;
        let payload: UiEvent;
        try {
          payload = JSON.parse(data) as UiEvent;
        } catch {
          return;
        }
        if (!payload?.session_id) return;

        const plan = parsePlanUpdateFromJson(payload.json);
        if (plan) {
          setPlanBySession((prev) => {
            const cur = prev[payload.session_id];
            if (cur && cur.ts_ms > payload.ts_ms) return prev;
            return {
              ...prev,
              [payload.session_id]: {
                ts_ms: payload.ts_ms,
                explanation: plan.explanation,
                steps: plan.steps,
              },
            };
          });
        }

        if (isObject(payload.json) && (payload.json as any).type === "app.prompt") {
          const p = (payload.json as any).prompt;
          if (typeof p === "string" && p.trim()) {
            setLastPromptBySession((prev) => ({ ...prev, [payload.session_id]: p }));
          }
        }

        if (isObject(payload.json) && (payload.json as any).type === "event_msg") {
          const p = isObject((payload.json as any).payload) ? ((payload.json as any).payload as any) : null;
          const pType = p && typeof p.type === "string" ? String(p.type) : "";
          if (pType === "user_message" && typeof p.message === "string" && p.message.trim()) {
            setLastPromptBySession((prev) => ({ ...prev, [payload.session_id]: String(p.message) }));
          }
          if (pType === "token_count") {
            const info = p && isObject(p.info) ? (p.info as any) : null;
            const total = info?.total_token_usage?.total_tokens;
            const window = info?.model_context_window;
            if (typeof total === "number" && typeof window === "number" && window > 0) {
              const pct = Math.max(0, Math.min(100, Math.round(((window - total) / window) * 100)));
              setMetricsBySession((prev) => ({
                ...prev,
                [payload.session_id]: {
                  session_id: payload.session_id,
                  ts_ms: payload.ts_ms,
                  context_left_pct: pct,
                  context_used_tokens: Math.max(0, Math.floor(total)),
                  context_window: Math.max(0, Math.floor(window)),
                },
              }));
            }
          }
        }

        const activityText = runActivityTextFromJson(payload.json);
        if (activityText) {
          setActivityBySession((prev) => {
            const list = prev[payload.session_id] ?? [];
            const next = [...list, { id: newId(), ts_ms: payload.ts_ms, text: activityText }].slice(
              -120,
            );
            return { ...prev, [payload.session_id]: next };
          });
        }

        setBlocksBySession((prev) => ({
          ...prev,
          [payload.session_id]: applyUiEventToBlocks(prev[payload.session_id] ?? [], payload),
        }));
      });

      es.addEventListener("codex_metrics", (evt) => {
        const data = (evt as MessageEvent).data;
        if (typeof data !== "string" || !data) return;
        let payload: ContextMetrics;
        try {
          payload = JSON.parse(data) as ContextMetrics;
        } catch {
          return;
        }
        if (!payload?.session_id) return;
        setMetricsBySession((prev) => ({ ...prev, [payload.session_id]: payload }));
        setSessions((prev) =>
          prev.map((s) =>
            s.id === payload.session_id
              ? {
                  ...s,
                  context_left_pct: payload.context_left_pct,
                  context_used_tokens: payload.context_used_tokens,
                  context_window: payload.context_window,
                }
              : s,
          ),
        );
      });

      es.addEventListener("codex_run_finished", (evt) => {
        const data = (evt as MessageEvent).data;
        if (typeof data !== "string" || !data) return;
        let payload: RunFinished;
        try {
          payload = JSON.parse(data) as RunFinished;
        } catch {
          return;
        }
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

        void apiFetchText(`/api/sessions/${encodeURIComponent(payload.session_id)}/conclusion`)
          .then((text) =>
            setConclusionBySession((prev) => ({
              ...prev,
              [payload.session_id]: stripToolCitations(text),
            })),
          )
          .catch(() => {});

        void refreshUsageRecords();
      });

      es.onerror = () => {
        if (activeSessionIdRef.current === sessionId) {
          // Avoid spamming banners; only set if not already showing an error.
          setErrorBanner((cur) => cur ?? "Lost connection to server (reconnecting…).");
        }
      };
    },
    [apiFetchText, apiUrl, closeRemoteStream, isRemote, refreshUsageRecords],
  );

  useEffect(() => {
    if (!isRemote) {
      closeRemoteStream();
      return;
    }
    return () => {
      closeRemoteStream();
    };
  }, [closeRemoteStream, isRemote]);

  useEffect(() => {
    if (!IS_TAURI || isRemote) return;
    let disposed = false;
    let unlistenEvent: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;
    let unlistenMetrics: (() => void) | null = null;

    void listen<UiEvent>("codex_event", ({ payload }) => {
      if (!payload?.session_id) return;
      const plan = parsePlanUpdateFromJson(payload.json);
      if (plan) {
        setPlanBySession((prev) => {
          const cur = prev[payload.session_id];
          if (cur && cur.ts_ms > payload.ts_ms) return prev;
          return {
            ...prev,
            [payload.session_id]: {
              ts_ms: payload.ts_ms,
              explanation: plan.explanation,
              steps: plan.steps,
            },
          };
        });
      }
      const activityText = runActivityTextFromJson(payload.json);
      if (activityText) {
        setActivityBySession((prev) => {
          const list = prev[payload.session_id] ?? [];
          const next = [...list, { id: newId(), ts_ms: payload.ts_ms, text: activityText }].slice(-120);
          return { ...prev, [payload.session_id]: next };
        });
      }
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

    void listen<ContextMetrics>("codex_metrics", ({ payload }) => {
      if (!payload?.session_id) return;
      setMetricsBySession((prev) => ({ ...prev, [payload.session_id]: payload }));
      setSessions((prev) =>
        prev.map((s) =>
          s.id === payload.session_id
            ? {
                ...s,
                context_left_pct: payload.context_left_pct,
                context_used_tokens: payload.context_used_tokens,
                context_window: payload.context_window,
              }
            : s,
        ),
      );
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenMetrics = unlisten;
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

      void refreshUsageRecords();
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
      unlistenMetrics?.();
    };
  }, [isRemote, refreshUsageRecords]);

  useEffect(() => {
    let alive = true;
    setErrorBanner(null);
    void (async () => {
      try {
        const loaded =
          IS_TAURI && !isRemote
            ? await invoke<SessionMeta[]>("list_sessions")
            : await apiFetchJson<SessionMeta[]>("/api/sessions");
        if (!alive) return;
        const sorted = sortSessionsByRecency(loaded);
        setSessions(sorted);
        const active = sorted[0]?.id ?? "";
        setActiveSessionId(active);
        if (active) {
          const s = sorted.find((x) => x.id === active);
          if (s) await loadSession(s);
        }
      } catch (e) {
        if (!alive) return;
        setErrorBanner(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiFetchJson, isRemote]);

  useEffect(() => {
    void refreshUsageRecords();
  }, [refreshUsageRecords]);

  useEffect(() => {
    let alive = true;
    setSkillsLoading(true);
    const p: Promise<SkillSummary[]> =
      IS_TAURI && !isRemote
        ? invoke<SkillSummary[]>("list_skills")
        : apiFetchJson<SkillSummary[]>("/api/skills");
    void p
      .then((loaded) => {
        if (!alive) return;
        setSkills(loaded);
      })
      .catch((err) => {
        if (!alive) return;
        setErrorBanner(`Failed to load skills: ${String(err)}`);
      })
      .finally(() => {
        if (!alive) return;
        setSkillsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [apiFetchJson, isRemote]);

  useEffect(() => {
    if (!IS_TAURI || isRemote) return;
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
  }, [isRemote]);

  async function startNewRun(promptText: string): Promise<boolean> {
    const promptTextTrimmed = promptText.trim();
    if (!promptTextTrimmed) return false;
    if (startingSessionId) return false;
    const prevActiveSessionId = activeSessionId;
    const sessionId = newSessionId();
    const now = Date.now();

    stickToBottomRef.current = true;
    setRunStartedAtBySession((prev) => ({ ...prev, [sessionId]: now }));
    setLastPromptBySession((prev) => ({ ...prev, [sessionId]: promptTextTrimmed }));
    setStartingSessionId(sessionId);
    setActiveSessionId(sessionId);
    setErrorBanner(null);

    const nextCwd = cwd.trim() ? cwd.trim() : null;
    const placeholder: SessionMeta = {
      id: sessionId,
      title: safeSessionTitle(promptTextTrimmed),
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
    setActivityBySession((prev) => ({ ...prev, [sessionId]: [] }));

    try {
      const meta =
        IS_TAURI && !isRemote
          ? await invoke<SessionMeta>("start_run", {
              sessionId,
              prompt: promptTextTrimmed,
              cwd: nextCwd,
            })
          : await apiFetchJson<SessionMeta>("/api/sessions", {
              method: "POST",
              body: JSON.stringify({
                session_id: sessionId,
                prompt: promptTextTrimmed,
                cwd: nextCwd,
              }),
            });
      setSessions((prev) => sortSessionsByRecency(prev.map((s) => (s.id === sessionId ? meta : s))));
      setActiveSessionId(sessionId);
      if (!IS_TAURI || isRemote || meta.status !== "running") {
        void loadSession(meta);
      }
      return true;
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
      setActivityBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setActiveSessionId(prevActiveSessionId);
      setErrorBanner(String(e));
      return false;
    } finally {
      setStartingSessionId((cur) => (cur === sessionId ? null : cur));
    }
  }

  function beginNewSession() {
    if (startingSessionId != null) return;
    persistScrollStateForActiveSession();
    setErrorBanner(null);
    setActiveSessionId("");
    if (!IS_TAURI || isRemote) {
      closeRemoteStream();
    }
  }

  async function runInActiveSession() {
    const promptText = prompt.trim();
    if (!promptText) return;
    stickToBottomRef.current = true;
    setErrorBanner(null);
    setSkillPicker(null);

    if (!activeSessionId) {
      setPrompt("");
      const ok = await startNewRun(promptText);
      if (!ok) setPrompt(promptText);
      return;
    }
    if (activeSession?.status === "running") {
      setErrorBanner("This session is already running.");
      return;
    }

    setPrompt("");
    try {
      if (!IS_TAURI || isRemote) {
        connectRemoteStream(activeSessionId, 0);
      }
      const now = Date.now();
      setActivityBySession((prev) => ({ ...prev, [activeSessionId]: [] }));
      setRunStartedAtBySession((prev) => ({ ...prev, [activeSessionId]: now }));
      setLastPromptBySession((prev) => ({ ...prev, [activeSessionId]: promptText }));
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, status: "running", last_used_at_ms: Math.max(s.last_used_at_ms, now) }
            : s,
        ),
      );
      const meta =
        IS_TAURI && !isRemote
          ? await invoke<SessionMeta>("continue_run", {
              sessionId: activeSessionId,
              prompt: promptText,
              cwd: cwd.trim() ? cwd.trim() : null,
            })
          : await apiFetchJson<SessionMeta>(`/api/sessions/${encodeURIComponent(activeSessionId)}/turn`, {
              method: "POST",
              body: JSON.stringify({
                prompt: promptText,
                cwd: cwd.trim() ? cwd.trim() : null,
              }),
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
      setPrompt(promptText);
    }
  }

  async function touchSession(sessionId: string) {
    try {
      const meta =
        IS_TAURI && !isRemote
          ? await invoke<SessionMeta>("touch_session", { sessionId })
          : await apiFetchJson<SessionMeta>(`/api/sessions/${encodeURIComponent(sessionId)}/touch`, {
              method: "POST",
            });
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
    if (!IS_TAURI || isRemote) {
      const next = window.prompt("Working directory:", cwd.trim() || "");
      if (next == null) return;
      setCwd(next.trim());
      return;
    }
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
    const ok = IS_TAURI
      ? await confirm(`Delete session "${activeSession.title}"?`, {
          title: "Delete session",
          kind: "warning",
        })
      : window.confirm(`Delete session "${activeSession.title}"?`);
    if (!ok) return;
    try {
      if (IS_TAURI && !isRemote) {
        await invoke("delete_session", { sessionId: activeSession.id });
      } else {
        if (eventSourceSessionIdRef.current === activeSession.id) {
          closeRemoteStream();
        }
        await apiFetchOk(`/api/sessions/${encodeURIComponent(activeSession.id)}`, {
          method: "DELETE",
        });
      }
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
      setActivityBySession((prev) => {
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
    setRemoteBaseUrlDraft(remoteBaseUrl);
    if (IS_TAURI && !isRemote) {
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

  async function checkRemoteDraft() {
    const draft = normalizeBaseUrl(remoteBaseUrlDraft);
    const url = draft ? `${draft}/healthz` : "/healthz";
    setCheckingRemote(true);
    setErrorBanner(null);
    try {
      const res = await fetch(url, { method: "GET" });
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new Error(text || res.statusText);
      if (text.trim() !== "ok") throw new Error(`Unexpected response: ${text.trim()}`);
      setRemoteBaseUrl(draft);
      setRemoteBaseUrlDraft(draft);
      setConnectionMode("remote");
    } catch (e) {
      setErrorBanner(`Remote check failed: ${String(e)}`);
    } finally {
      setCheckingRemote(false);
    }
  }

  async function saveConnectionSettings() {
    const draft = normalizeBaseUrl(remoteBaseUrlDraft);
    setRemoteBaseUrl(draft);
    if (!IS_TAURI) {
      setConnectionMode("remote");
    }
    setShowSettings(false);
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
    <div
      className={`app ${mobilePanel === "sessions" ? "mobileSessionsOpen" : ""} ${
        mobilePanel === "right" ? "mobileRightOpen" : ""
      }`}
    >
      {mobilePanel ? (
        <div className="mobileBackdrop" onClick={() => setMobilePanel(null)} />
      ) : null}
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

        <div className="sidebarSectionTitle">Projects</div>
        <div className="projectList">
          <button
            type="button"
            className={`projectRow ${activeProjectKey === "all" ? "active" : ""}`}
            onClick={() => {
              setActiveProjectKey("all");
              if (!activeSessionId && sessions.length > 0) {
                setActiveSessionId(sessions[0].id);
                void loadSession(sessions[0]);
              }
            }}
          >
            <div className="projectTitle">All projects</div>
            <div className="projectMeta muted mono">{sessions.length}</div>
          </button>
          {projectGroups.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`projectRow ${p.key === activeProjectKey ? "active" : ""}`}
              onClick={() => {
                setActiveProjectKey(p.key);
                const list = p.sessions;
                const nextActive = list.some((s) => s.id === activeSessionId)
                  ? activeSessionId
                  : list[0]?.id ?? "";
                if (nextActive && nextActive !== activeSessionId) {
                  persistScrollStateForActiveSession();
                  setActiveSessionId(nextActive);
                  const s = list.find((x) => x.id === nextActive);
                  if (s) void loadSession(s);
                }
              }}
              title={p.path ?? ""}
            >
              <div className="projectTitle">{p.label}</div>
              <div className="projectMeta muted mono">{p.sessions.length}</div>
            </button>
          ))}
        </div>

        <div className="sidebarSectionTitle">
          Threads <span className="muted mono">{activeProjectLabel}</span>
        </div>
        <div className="sessionList" ref={threadListRef} onScroll={onThreadListScroll}>
          {visibleSessionsForActiveProject.length === 0 ? (
            <div className="sessionEmpty">
              <div className="sessionEmptyTitle">No threads yet.</div>
              <div className="muted">
                {IS_TAURI && !isRemote
                  ? "Click Run to create one."
                  : "Check Settings → Remote base URL, or create a new session on this server."}
              </div>
            </div>
          ) : null}

          {visibleSessionsForActiveProject.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sessionRow ${s.id === activeSessionId ? "active" : ""}`}
              onClick={() => {
                if (s.id === activeSessionId) {
                  void touchSession(s.id);
                  setMobilePanel(null);
                  return;
                }
                persistScrollStateForActiveSession();
                void touchSession(s.id);
                setActiveSessionId(s.id);
                void loadSession(s);
                setMobilePanel(null);
              }}
            >
              <div className="sessionTitle">{s.title}</div>
              <div className="sessionMeta">
                <span className={`pill ${s.status}`}>{s.status}</span>
                <span className="muted">{s.cwd ?? ""}</span>
              </div>
            </button>
          ))}
          <div ref={threadMoreRef} className="sessionSentinel" />
          {hasMoreThreads ? (
            <div className="sessionListFooter muted mono">Loading more…</div>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <div className="mobileBar">
          <button
            className="btn"
            type="button"
            onClick={() => setMobilePanel((cur) => (cur === "sessions" ? null : "sessions"))}
          >
            Sessions
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setMobilePanel(null);
              beginNewSession();
            }}
            disabled={startingSessionId != null}
          >
            New
          </button>
          <button className="btn" type="button" onClick={openSettings}>
            Settings
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setMobilePanel((cur) => (cur === "right" ? null : "right"))}
          >
            Panels
          </button>
        </div>
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
              {contextUsage ? (
                <div
                  className="pill ctx"
                  title={
                    contextUsage.used != null && contextUsage.window != null
                      ? `${contextUsage.used.toLocaleString()} / ${contextUsage.window.toLocaleString()} tokens used`
                      : "Context remaining"
                  }
                >
                  {contextUsage.pct}% ctx left
                </div>
              ) : null}
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
		                {contextLeftPct != null ? `${contextLeftPct}% context left • ` : ""}
		                esc to interrupt)
		              </span>
		            </div>
                {recentRunActivity.length > 0 ? (
                  <div className="runActivity">
                    {recentRunActivity.map((a) => (
                      <div key={a.id} className="runActivityItem">
                        <span className="runActivityDot" aria-hidden>
                          •
                        </span>
                        <span className="runActivityText">{a.text}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
		          </div>
		        ) : null}

	        <Timeline
	          activeSessionId={activeSessionId}
	          filteredBlocks={filteredBlocks}
	          startingSessionId={startingSessionId}
	          loadingSessionId={loadingSessionId}
	          timelineRef={timelineRef}
	          timelineEndRef={timelineEndRef}
	          onTimelineScroll={onTimelineScroll}
	          setCollapsedForActiveSession={setCollapsedForActiveSession}
	          markdownComponents={markdownComponents}
	        />

          {showTerminalDrawer ? (
            <div className="terminalDrawer" role="region" aria-label="Terminal">
              <div className="terminalDrawerHeader">
                <div className="terminalDrawerTitle mono">Terminal</div>
                <div className="terminalDrawerHint muted mono">
                  cd &lt;path&gt; to set working directory
                </div>
                <div className="spacer" />
                <button
                  className="iconBtn"
                  type="button"
                  onClick={() => setShowTerminalDrawer(false)}
                  aria-label="Close terminal"
                  title="Close"
                >
                  ✕
                </button>
              </div>
              <div className="terminalDrawerBody">
                {IS_TAURI && !isRemote ? (
                  <CwdShell
                    className="drawer"
                    initialCwd={cwd}
                    onCwd={(next) => {
                      if (cwd === next) return;
                      setCwd(next);
                    }}
                    onError={(msg) => setErrorBanner(msg)}
                  />
                ) : (
                  <div className="terminalDrawerEmpty muted">
                    Terminal drawer is available in the macOS app (local mode).
                  </div>
                )}
              </div>
            </div>
          ) : null}

	        <div className="composer">
	          <div className="composerLeft">
              <div className="composerTools">
                <button
                  className="btn"
                  type="button"
                  disabled={!IS_TAURI || isRemote}
                  title={
                    !IS_TAURI || isRemote
                      ? "Attachments are available in the macOS app (local mode)."
                      : "Attach files"
                  }
                  onClick={async () => {
                    if (!IS_TAURI || isRemote) return;
                    setErrorBanner(null);
                    try {
                      const selected = await openDialog({ multiple: true });
                      if (!selected) return;
                      const paths = Array.isArray(selected) ? selected : [selected];
                      const imported = await invoke<string[]>("import_dropped_files", {
                        sessionId: activeSessionId || null,
                        paths,
                      });
                      const next = imported.length > 0 ? imported : paths;
                      insertPromptText(next.map(quotePathIfNeeded).join("\n"));
                    } catch (e) {
                      setErrorBanner(String(e));
                    }
                  }}
                >
                  Attach
                </button>
                <button
                  className="btn"
                  type="button"
                  title="Insert $ to pick a skill"
                  onClick={() => {
                    insertPromptText("$");
                    requestAnimationFrame(() => {
                      const el = promptRef.current;
                      if (!el) return;
                      updateSkillPickerFromText(
                        el.value,
                        el.selectionStart ?? el.value.length,
                      );
                    });
                  }}
                >
                  $
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setShowTerminalDrawer((prev) => !prev)}
                  disabled={!IS_TAURI || isRemote}
                  title={
                    !IS_TAURI || isRemote
                      ? "Terminal drawer is available in the macOS app (local mode)."
                      : showTerminalDrawer
                        ? "Hide terminal"
                        : "Show terminal"
                  }
                >
                  Terminal
                </button>
                <div className="spacer" />
                <div className="muted mono composerHint">
                  enter to send • shift+enter newline • esc to interrupt
                </div>
              </div>
              <div className="promptWrap">
                <textarea
                  className="prompt"
                  ref={promptRef}
                  value={prompt}
                  onChange={onPromptChange}
                  onKeyUp={(e) => {
                    if (
                      e.key !== "ArrowLeft" &&
                      e.key !== "ArrowRight" &&
                      e.key !== "ArrowUp" &&
                      e.key !== "ArrowDown" &&
                      e.key !== "Home" &&
                      e.key !== "End"
                    ) {
                      return;
                    }
                    updateSkillPickerFromText(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                    );
                  }}
                  onClick={(e) =>
                    updateSkillPickerFromText(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                    )
                  }
                  onPaste={onPromptPaste}
                  onCompositionStart={() => {
                    composingPromptRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingPromptRef.current = false;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && activeSession?.status === "running" && activeSessionId) {
                      e.preventDefault();
                      e.stopPropagation();
                      setErrorBanner(null);
                      setSkillPicker(null);
                      void stopRun(activeSessionId).catch((err) => setErrorBanner(String(err)));
                      return;
                    }

                    if (skillPicker) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        if (skillMatches.length === 0) return;
                        setSkillPicker((prev) =>
                          prev
                            ? {
                                ...prev,
                                selected: Math.min(prev.selected + 1, skillMatches.length - 1),
                              }
                            : prev,
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        if (skillMatches.length === 0) return;
                        setSkillPicker((prev) =>
                          prev
                            ? { ...prev, selected: Math.max(0, prev.selected - 1) }
                            : prev,
                        );
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setSkillPicker(null);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        const native = e.nativeEvent as any;
                        if (composingPromptRef.current) return;
                        const isComposing = Boolean(native && native.isComposing);
                        const composingKeyCode =
                          native && (native.keyCode === 229 || native.which === 229);
                        if (isComposing || composingKeyCode) return;
                        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;

                        e.preventDefault();
                        const idx = Math.max(
                          0,
                          Math.min(skillPicker.selected, Math.max(0, skillMatches.length - 1)),
                        );
                        const choice = skillMatches[idx];
                        if (choice) applySkill(choice.name);
                        return;
                      }
                    }

                    if (e.key === "Enter") {
                      const native = e.nativeEvent as any;
                      if (composingPromptRef.current) return;
                      const isComposing = Boolean(native && native.isComposing);
                      const composingKeyCode =
                        native && (native.keyCode === 229 || native.which === 229);
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
                      void stopRun(activeSessionId).catch((err) => setErrorBanner(String(err)));
                    }
                  }}
                  rows={2}
                  placeholder="Describe what you want Codex to do…"
                />

                {skillPicker ? (
                  <div className="skillPicker" role="listbox" aria-label="Skills">
                    <div className="skillPickerHeader">
                      <div className="skillPickerTitle mono">
                        ${skillPicker.query || ""}
                      </div>
                      <div className="skillPickerHint muted mono">
                        {skillsLoading ? "Loading…" : "enter to insert • esc to close"}
                      </div>
                    </div>
                    {skillMatches.length > 0 ? (
                      <ul className="skillList">
                        {skillMatches.map((s, idx) => (
                          <li
                            key={s.name}
                            className={`skillItem ${idx === skillPicker.selected ? "active" : ""}`}
                            title={s.path}
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              applySkill(s.name);
                            }}
                          >
                            <div className="skillName mono">{s.name}</div>
                            {s.description ? (
                              <div className="skillDesc muted">{s.description}</div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="skillEmpty muted">
                        {skillsLoading ? "Loading skills…" : "No matching skills."}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
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
	            className={`tab ${rightTab === "usage" ? "active" : ""}`}
	            onClick={() => setRightTab("usage")}
	          >
	            Usage
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
	                {doneTodoCount}/{totalTodoCount}
	              </span>
	            </div>
	            {hasAnyTodos ? (
	              <>
	                {planExplanation ? <div className="muted todoHint">{planExplanation}</div> : null}
	                <ul className="todoList">
	                  {planSteps.map((t, idx) => {
	                    const isDone = t.status === "completed";
	                    const isProgress = t.status === "in_progress";
	                    const pillClass = isProgress ? "in_progress" : isDone ? "completed" : "";
	                    const pillText = isProgress ? "in progress" : isDone ? "done" : "pending";
	                    return (
	                      <li key={`plan:${idx}:${t.step}`} className={`todoItem plan ${isDone ? "done" : ""}`}>
	                        <span
	                          className={`todoBox ${isDone ? "done" : isProgress ? "progress" : ""}`}
	                          aria-hidden
	                        />
	                        <span className="todoLabel">{t.step}</span>
	                        <span className={`pill todoPill ${pillClass}`}>{pillText}</span>
	                      </li>
	                    );
	                  })}
	                  {todos.map((t) => (
	                    <li
	                      key={`${t.done ? "1" : "0"}:${t.text}`}
	                      className={`todoItem ${t.done ? "done" : ""}`}
	                    >
	                      <span className={`todoBox ${t.done ? "done" : ""}`} aria-hidden />
	                      <span className="todoLabel">{t.text}</span>
	                    </li>
	                  ))}
	                </ul>
	              </>
	            ) : (
	              <div className="muted">No TODOs parsed yet.</div>
	            )}
	          </div>
	        ) : rightTab === "usage" ? (
	          <div className="panel">
	            <div className="panelTitle">
	              Usage{" "}
	              {usageLoading ? <span className="muted">Loading…</span> : null}
	            </div>
	            {dailyUsage.length > 0 ? (
	              <ul className="usageList">
	                {dailyUsage.slice(0, 14).map((d) => (
	                  <li
	                    key={d.dayKey}
	                    className={`usageItem ${d.dayKey === dayKeyLocal(Date.now()) ? "today" : ""}`}
	                  >
	                    <div className="usageItemHeader">
	                      <span className="usageDay mono">{d.dayKey}</span>
	                      <span className="usageTokens mono">{d.total.toLocaleString()} tok</span>
	                    </div>
	                    <div className="usageBreakdown muted mono">
	                      in {d.input.toLocaleString()} • out {d.output.toLocaleString()} • rsn{" "}
	                      {d.reasoning.toLocaleString()} • cache {d.cached.toLocaleString()} •{" "}
	                      {d.runs} runs
	                    </div>
	                  </li>
	                ))}
	              </ul>
	            ) : (
	              <div className="muted">No usage records yet.</div>
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
              <label className="label">Connection</label>
              {IS_TAURI ? (
                <div className="row">
                  <button
                    className={`btn ${connectionMode === "local" ? "primary" : ""}`}
                    type="button"
                    onClick={() => setConnectionMode("local")}
                  >
                    Local
                  </button>
                  <button
                    className={`btn ${connectionMode === "remote" ? "primary" : ""}`}
                    type="button"
                    onClick={() => setConnectionMode("remote")}
                  >
                    Remote
                  </button>
                </div>
              ) : (
                <div className="muted">Web mode uses a remote server.</div>
              )}

              <label className="label" style={{ marginTop: 12 }}>
                Remote base URL
              </label>
              <input
                className="input"
                value={remoteBaseUrlDraft}
                onChange={(e) => setRemoteBaseUrlDraft(e.currentTarget.value)}
                placeholder="e.g. http://127.0.0.1:8765 (leave empty for same origin)"
              />
              <div className="row">
                <button
                  className="btn"
                  type="button"
                  disabled={checkingRemote}
                  onClick={checkRemoteDraft}
                  title="GET /healthz"
                >
                  {checkingRemote ? "Checking…" : "Check"}
                </button>
                <button className="btn primary" type="button" onClick={saveConnectionSettings}>
                  Save
                </button>
              </div>
            </div>

            {IS_TAURI && !isRemote ? (
              <>
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
              </>
            ) : null}
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
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setShowSessionSettings(false);
                    setShowTerminalDrawer(true);
                  }}
                  disabled={!IS_TAURI || isRemote}
                  title={!IS_TAURI || isRemote ? "Terminal drawer is available in the macOS app (local mode)." : ""}
                >
                  Terminal
                </button>
              </div>
              <div className="muted">
                {activeSessionId
                  ? "Used the next time you click Continue in this session."
                  : "Used when you start a new session."}
              </div>
            </div>
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
                      if (IS_TAURI && !isRemote) {
                        await invoke("rename_session", { sessionId: activeSessionId, title });
                      } else {
                        await apiFetchOk(
                          `/api/sessions/${encodeURIComponent(activeSessionId)}/rename`,
                          {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ title }),
                          },
                        );
                      }
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
