// Markdown exclusions for mention detection. Each pass advances monotonically;
// an unclosed delimiter must not make the parser rescan every possible suffix.
function withoutFences(text) {
  let fence;
  const lines = text.split("\n");
  return lines
    .map((line, index) => {
      const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (run?.[0] === fence[0] && run.length >= fence.length) fence = undefined;
        return "";
      }
      if (run && index + 1 < lines.length) {
        fence = run;
        return "";
      }
      return line;
    })
    .join("\n");
}

function withoutInlineCode(text) {
  const runs = [...text.matchAll(/`+/g)];
  const next = new Map(),
    closing = [];
  for (let i = runs.length - 1; i >= 0; --i) {
    const width = runs[i][0].length;
    closing[i] = next.get(width);
    next.set(width, i);
  }
  const pieces = [];
  let from = 0;
  for (let i = 0; i < runs.length; ++i) {
    if (closing[i] === undefined) continue; // unmatched literal backticks
    pieces.push(text.slice(from, runs[i].index), " ");
    i = closing[i];
    from = runs[i].index + runs[i][0].length;
  }
  pieces.push(text.slice(from));
  return pieces.join("");
}

function withoutLinkTargets(text) {
  const pieces = [];
  let start = -1,
    from = 0;
  for (const m of text.matchAll(/\]\(|\)|\n/g)) {
    if (m[0] === "\n") start = -1;
    else if (m[0] === "](") {
      if (start < 0) start = m.index;
    } else if (start >= 0) {
      pieces.push(text.slice(from, start), " ");
      from = m.index + 1;
      start = -1;
    }
  }
  pieces.push(text.slice(from));
  return pieces.join("");
}

export function hasPersonalMention(message, username) {
  if (!username || !/[@＠]/.test(message)) return false;
  const prose = withoutLinkTargets(withoutInlineCode(withoutFences(message))).replace(
    /https?:\/\/[^\s<>]+/gi,
    " ",
  );
  const handle = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_@＠/\\\\])[@＠]${handle}(?![a-z0-9_-]|\\.[a-z0-9_-])`,
    "iu",
  ).test(prose);
}
