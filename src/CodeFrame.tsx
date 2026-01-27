import { useMemo } from "react";

type Props = {
  text: string;
};

function looksLikeDiff(lines: string[]): boolean {
  const sample = lines.slice(0, 80);
  let hits = 0;
  for (const line of sample) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@ ")
    ) {
      hits += 2;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) hits += 1;
  }
  return hits >= 6;
}

type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx" | "plain";

function classifyDiffLine(line: string): DiffLineKind {
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ")
  ) {
    return "meta";
  }
  if (line.startsWith("@@ ")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++ ")) return "add";
  if (line.startsWith("-") && !line.startsWith("--- ")) return "del";
  if (line.startsWith(" ")) return "ctx";
  return "plain";
}

export function CodeFrame({ text }: Props) {
  const { lines, isDiff } = useMemo(() => {
    const split = text.split("\n");
    return { lines: split, isDiff: looksLikeDiff(split) };
  }, [text]);

  return (
    <div className={`codeFrame mono ${isDiff ? "diff" : ""}`}>
      {lines.map((line, i) => {
        const kind = isDiff ? classifyDiffLine(line) : "plain";
        const safeLine = line.length > 0 ? line : "\u00A0";
        return (
          <div key={i} className={`codeLine ${isDiff ? `diff-${kind}` : ""}`}>
            <span className="codeLn" aria-hidden>
              {i + 1}
            </span>
            <span className="codeText">{safeLine}</span>
          </div>
        );
      })}
    </div>
  );
}

