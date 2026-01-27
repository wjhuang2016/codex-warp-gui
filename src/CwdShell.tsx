import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type ShellOutput = { data: string };
type ShellCwd = { cwd: string };

type Props = {
  className?: string;
  initialCwd: string;
  onCwd: (cwd: string) => void;
  onError: (message: string) => void;
};

function debounceMs<T extends (...args: any[]) => void>(fn: T, delayMs: number): T {
  let t: number | null = null;
  const wrapped = ((...args: any[]) => {
    if (t != null) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), delayMs);
  }) as T;
  return wrapped;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function CwdShell({ className, initialCwd, onCwd, onError }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);

  const pendingInputRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const themeBg = cssVar("--input-bg", "#f1ece5");
    const themeFg = cssVar("--text", "#1f2328");
    const themeAccent = cssVar("--accent", "#0f766e");
    const themeAccentHover = cssVar("--accent-hover", "#115e59");
    const themeSelection = cssVar("--focus-ring", "rgba(15, 118, 110, 0.26)");

    const term = new Terminal({
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      convertEol: true,
      scrollback: 2000,
      allowTransparency: true,
      theme: {
        background: themeBg,
        foreground: themeFg,
        cursor: themeAccent,
        cursorAccent: themeBg,
        selectionBackground: themeSelection,
        black: themeFg,
        brightBlack: cssVar("--muted", "#6b7078"),
        red: cssVar("--danger", "#b42318"),
        brightRed: cssVar("--danger", "#b42318"),
        green: cssVar("--success", "#1b8a5a"),
        brightGreen: cssVar("--success", "#1b8a5a"),
        yellow: cssVar("--warning", "#b45309"),
        brightYellow: cssVar("--warning", "#b45309"),
        blue: themeAccent,
        brightBlue: themeAccentHover,
        magenta: themeAccent,
        brightMagenta: themeAccentHover,
        cyan: themeAccent,
        brightCyan: themeAccentHover,
        white: cssVar("--panel", "#fffcf8"),
        brightWhite: cssVar("--popup", "#fffdfb"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

    const flushInput = () => {
      const data = pendingInputRef.current;
      pendingInputRef.current = "";
      flushTimerRef.current = null;
      if (!data) return;
      void invoke("shell_write", { data }).catch((err) => onError(String(err)));
    };

    const queueInput = (data: string) => {
      pendingInputRef.current += data;
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = window.setTimeout(flushInput, 8);
    };

    const onDataDispose = term.onData((d) => queueInput(d));

    let ro: ResizeObserver | null = null;
    const fitAndResize = debounceMs(() => {
      try {
        fit.fit();
        void invoke("shell_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
      } catch {
        // ignore
      }
    }, 50);

    ro = new ResizeObserver(() => fitAndResize());
    ro.observe(el);

    // Start backend shell once.
    const cwd = initialCwd.trim();
    if (!startedRef.current) {
      startedRef.current = true;
      void invoke("start_shell", { cwd: cwd ? cwd : null })
        .then(() => fitAndResize())
        .catch((err) => onError(String(err)));
    }

    let unlistenOut: (() => void) | null = null;
    let unlistenCwd: (() => void) | null = null;
    void listen<ShellOutput>("shell_output", ({ payload }) => {
      if (!payload?.data) return;
      term.write(payload.data);
    })
      .then((u) => (unlistenOut = u))
      .catch(() => {});
    void listen<ShellCwd>("shell_cwd", ({ payload }) => {
      const next = payload?.cwd?.trim();
      if (!next) return;
      onCwd(next);
    })
      .then((u) => (unlistenCwd = u))
      .catch(() => {});

    return () => {
      ro?.disconnect();
      onDataDispose.dispose();
      unlistenOut?.();
      unlistenCwd?.();
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className={`cwdShell${className ? ` ${className}` : ""}`} ref={containerRef} />;
}
