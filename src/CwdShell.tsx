import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type ShellOutput = { data: string };
type ShellCwd = { cwd: string };

type Props = {
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

export function CwdShell({ initialCwd, onCwd, onError }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);

  const pendingInputRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      convertEol: true,
      scrollback: 2000,
      allowTransparency: true,
      theme: {
        background: "transparent",
        foreground: "#e8ecf3",
        cursor: "#00d4ff",
        selectionBackground: "rgba(0, 212, 255, 0.22)",
        black: "#0b0d12",
        brightBlack: "#263047",
        cyan: "#00d4ff",
        brightCyan: "#00d4ff",
        magenta: "#7c5cff",
        brightMagenta: "#7c5cff",
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

  return <div className="cwdShell" ref={containerRef} />;
}

