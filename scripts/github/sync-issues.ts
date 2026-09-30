/**
 * Creates (or updates) the GitHub milestones, labels and issues defined in
 * docs/architecture/v1-github-issues.md. Idempotent: issues are matched by
 * their key ("M1-6 · …"), milestones by title, labels by name. An issue whose
 * acceptance criteria are all checked is closed as completed; any other is
 * left open (and reopened if needed).
 *
 *   npx tsx scripts/github/sync-issues.ts --parse     # print what was parsed; no gh needed
 *   gh auth login                                      # once
 *   npx tsx scripts/github/sync-issues.ts --dry-run   # reads GitHub, writes nothing
 *   npx tsx scripts/github/sync-issues.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SOURCE = "docs/architecture/v1-github-issues.md";
const dryRun = process.argv.includes("--dry-run");

type Milestone = { key: string; title: string };
type Issue = { key: string; title: string; milestone: string; labels: string[]; body: string; done: boolean };

const LABEL_COLORS: Record<string, string> = { area: "1d76db", type: "5319e7", risk: "b60205" };

function parse(markdown: string): { milestones: Milestone[]; issues: Issue[] } {
  const milestones: Milestone[] = [];
  const issues: Issue[] = [];
  let milestone: Milestone | undefined;
  let current: { key: string; title: string; lines: string[] } | undefined;

  const flush = () => {
    if (!current || !milestone) return;
    const body = current.lines.join("\n").trim();
    const labelLine = body.match(/^\*\*Labels:\*\*(.*)$/m)?.[1] ?? "";
    const labels = [...labelLine.matchAll(/`([a-z]+:[a-z0-9-]+)`/g)].map((m) => m[1]!);
    const boxes = [...body.matchAll(/^- \[( |x)\]/gm)].map((m) => m[1]);
    issues.push({
      key: current.key,
      title: `${current.key} · ${current.title}`,
      milestone: milestone.title,
      labels,
      body: body.replace(/^\*\*Labels:\*\*.*\n+/m, ""),
      done: boxes.length > 0 && boxes.every((b) => b === "x"),
    });
    current = undefined;
  };

  for (const line of markdown.split("\n")) {
    const m = line.match(/^## (M\d+) — (.+)$/);
    const i = line.match(/^### (M\d+-\d+) · (.+)$/);
    if (m) {
      flush();
      milestone = { key: m[1]!, title: `${m[1]} — ${m[2]}` };
      milestones.push(milestone);
    } else if (i) {
      flush();
      current = { key: i[1]!, title: i[2]!, lines: [] };
    } else if (line.trim() === "---") {
      flush();
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return { milestones, issues };
}

function gh(args: string[], input?: unknown): unknown {
  if (dryRun && args.some((a) => a === "POST" || a === "PATCH")) {
    console.log(`[dry-run] gh ${args.join(" ")}`);
    return {};
  }
  const res = spawnSync("gh", args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`gh ${args.join(" ")} failed:\n${res.stderr}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

if (process.argv.includes("--parse")) {
  const { milestones, issues } = parse(readFileSync(SOURCE, "utf8"));
  for (const m of milestones) {
    console.log(m.title);
    for (const i of issues.filter((x) => x.milestone === m.title)) {
      const boxes = i.body.match(/^- \[[ x]\]/gm)?.length ?? 0;
      console.log(`  ${i.done ? "✔" : "·"} ${i.title}  [${i.labels.join(", ")}]  ${boxes} criteria, ${i.body.length} chars`);
    }
  }
  process.exit(0);
}

const repo = (gh(["repo", "view", "--json", "nameWithOwner"]) as { nameWithOwner: string }).nameWithOwner;
const api = (path: string) => `repos/${repo}/${path}`;
const { milestones, issues } = parse(readFileSync(SOURCE, "utf8"));
console.log(`${repo}: ${milestones.length} milestones, ${issues.length} issues in ${SOURCE}${dryRun ? " (dry run)" : ""}`);

// Labels
const existingLabels = new Set(
  (gh(["api", "--paginate", "--slurp", api("labels?per_page=100")]) as { name: string }[][]).flat().map((l) => l.name),
);
for (const name of new Set(issues.flatMap((i) => i.labels))) {
  if (existingLabels.has(name)) continue;
  gh(["api", "-X", "POST", api("labels"), "--input", "-"], {
    name,
    color: LABEL_COLORS[name.split(":")[0]!] ?? "ededed",
  });
  console.log(`label  + ${name}`);
}

// Milestones
const milestoneNumbers = new Map<string, number>();
for (const m of (gh(["api", "--paginate", "--slurp", api("milestones?state=all&per_page=100")]) as {
  title: string;
  number: number;
}[][]).flat()) {
  milestoneNumbers.set(m.title, m.number);
}
for (const m of milestones) {
  if (milestoneNumbers.has(m.title)) continue;
  const created = gh(["api", "-X", "POST", api("milestones"), "--input", "-"], {
    title: m.title,
    description: `Issues ${m.key}-* from ${SOURCE}`,
  }) as { number: number };
  milestoneNumbers.set(m.title, created.number ?? 0);
  console.log(`milestone + ${m.title}`);
}

// Issues
type GhIssue = { number: number; title: string; state: string; body: string | null; pull_request?: unknown };
const existing = new Map<string, GhIssue>();
for (const issue of (gh(["api", "--paginate", "--slurp", api("issues?state=all&per_page=100")]) as GhIssue[][]).flat()) {
  if (issue.pull_request) continue;
  const key = issue.title.match(/^(M\d+-\d+) · /)?.[1];
  if (key) existing.set(key, issue);
}
for (const issue of issues) {
  const body = `${issue.body}\n\n---\n_Source: [\`${SOURCE}\`](../blob/main/${SOURCE}) — edit there and re-run \`scripts/github/sync-issues.ts\`._`;
  const state = issue.done ? "closed" : "open";
  const fields = {
    title: issue.title,
    body,
    labels: issue.labels,
    milestone: milestoneNumbers.get(issue.milestone),
  };
  const found = existing.get(issue.key);
  if (!found) {
    const created = gh(["api", "-X", "POST", api("issues"), "--input", "-"], fields) as { number: number };
    if (issue.done) {
      gh(["api", "-X", "PATCH", api(`issues/${created.number}`), "--input", "-"], {
        state,
        state_reason: "completed",
      });
    }
    console.log(`issue  + ${issue.title}${issue.done ? " (closed: done)" : ""}`);
  } else if (found.body !== body || found.title !== issue.title || found.state !== state) {
    gh(["api", "-X", "PATCH", api(`issues/${found.number}`), "--input", "-"], {
      ...fields,
      state,
      ...(issue.done ? { state_reason: "completed" } : {}),
    });
    console.log(`issue  ~ #${found.number} ${issue.title} (${state})`);
  }
}
console.log("done");
