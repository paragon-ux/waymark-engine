import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./paths.js";

export interface BaselineMatch {
  file: string;
  line: number;
  text: string;
}

export interface BaselineSearchResult {
  query: string;
  tool: "ripgrep" | "git-grep" | "builtin-regex";
  duration_ms: number;
  total_matches: number;
  matching_files_count: number;
  estimated_tokens: number;
  sample_matches: BaselineMatch[];
}

export interface BaselineComparison {
  query: string;
  waymark_tier: string;
  waymark_duration_ms: number;
  waymark_matches: number;
  waymark_tokens: number;
  baseline: BaselineSearchResult;
  speedup_factor: number;
  noise_reduction_ratio: number;
  token_savings_pct: number;
}

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".capn",
  ".codedb",
  "coverage",
]);

/**
 * Perform a naive lexical search across the repository to serve as a comparative
 * baseline against Waymark's AST/PrefixTrie structured discovery.
 */
export function runBaselineSearch(query: string, rootDir?: string): BaselineSearchResult {
  const root = rootDir ? path.resolve(rootDir) : repoRoot();
  const start = performance.now();

  // Strategy 1: Attempt git-grep first (fast, standard, respects .gitignore)
  try {
    const stdout = execFileSync("git", ["-C", root, "grep", "-n", "-I", "--", query], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const matches: BaselineMatch[] = [];
    const files = new Set<string>();

    for (const line of lines) {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (match && match[1] && match[2] && match[3] !== undefined) {
        const file = match[1];
        const lineNum = Number.parseInt(match[2], 10);
        const text = match[3].trim();
        files.add(file);
        if (matches.length < 50) {
          matches.push({ file, line: lineNum, text });
        }
      }
    }

    const duration_ms = Math.round((performance.now() - start) * 100) / 100;
    const rawCharCount = stdout.length;
    const estimated_tokens = Math.ceil(rawCharCount / 4);

    return {
      query,
      tool: "git-grep",
      duration_ms,
      total_matches: lines.length,
      matching_files_count: files.size,
      estimated_tokens,
      sample_matches: matches.slice(0, 10),
    };
  } catch {
    // If git grep fails (e.g. exit code 1 = 0 matches, or git not present)
  }

  // Strategy 2: Built-in recursive filesystem regex scanner
  const matches: BaselineMatch[] = [];
  const files = new Set<string>();
  let totalChars = 0;
  let totalMatches = 0;

  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let regex: RegExp;
  try {
    regex = new RegExp(escapeRegex(query), "i");
  } catch {
    regex = new RegExp(query, "i");
  }

  function walk(dir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if ([".ts", ".js", ".mjs", ".json", ".md", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h"].includes(ext)) {
          const filePath = path.join(dir, entry.name);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split(/\r?\n/);
            const relFile = path.relative(root, filePath).replaceAll("\\", "/");

            for (let i = 0; i < lines.length; i++) {
              const currentLine = lines[i];
              if (currentLine !== undefined && regex.test(currentLine)) {
                totalMatches++;
                files.add(relFile);
                totalChars += currentLine.length + relFile.length + 10;
                if (matches.length < 50) {
                  matches.push({ file: relFile, line: i + 1, text: currentLine.trim() });
                }
              }
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    }
  }

  walk(root);

  const duration_ms = Math.round((performance.now() - start) * 100) / 100;
  return {
    query,
    tool: "builtin-regex",
    duration_ms,
    total_matches: totalMatches,
    matching_files_count: files.size,
    estimated_tokens: Math.ceil(totalChars / 4),
    sample_matches: matches.slice(0, 10),
  };
}

/**
 * Compare Waymark's structured result against the baseline search result.
 */
export function computeBaselineComparison(
  query: string,
  waymarkTier: string,
  waymarkDurationMs: number,
  waymarkMatches: number,
  waymarkTokens: number,
  baseline: BaselineSearchResult,
): BaselineComparison {
  const speedup_factor =
    waymarkDurationMs > 0
      ? Math.round((baseline.duration_ms / waymarkDurationMs) * 100) / 100
      : 1;

  const noise_reduction_ratio =
    baseline.total_matches > waymarkMatches
      ? Math.round(((baseline.total_matches - waymarkMatches) / baseline.total_matches) * 1000) / 1000
      : 0;

  const token_savings_pct =
    baseline.estimated_tokens > waymarkTokens
      ? Math.round(((baseline.estimated_tokens - waymarkTokens) / baseline.estimated_tokens) * 1000) / 1000
      : 0;

  return {
    query,
    waymark_tier: waymarkTier,
    waymark_duration_ms: waymarkDurationMs,
    waymark_matches: waymarkMatches,
    waymark_tokens: waymarkTokens,
    baseline,
    speedup_factor,
    noise_reduction_ratio,
    token_savings_pct,
  };
}
