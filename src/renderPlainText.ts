import type { CallGraphData, CallGraphHopNode } from "./types.js";

export function formatTimings(timings: Record<string, number>): string {
  const parts: string[] = [];
  if (timings.ast_ms !== undefined) parts.push(`ast: ${timings.ast_ms}ms`);
  if (timings.path_ms !== undefined) parts.push(`path: ${timings.path_ms}ms`);
  if (timings.fuzzy_ms !== undefined) parts.push(`fuzzy: ${timings.fuzzy_ms}ms`);
  if (timings.capn_ms !== undefined) parts.push(`capn: ${timings.capn_ms}ms`);
  if (timings.total_ms !== undefined) parts.push(`total: ${timings.total_ms}ms`);
  return parts.join(" | ");
}

/** Formats structured CallGraphData as an indented plain text tree (LEDGER-08 / DOD-11). */
export function renderCallGraph(graph: CallGraphData): string {
  const depthStr = `[call-graph: depth ${graph.depth}]${graph.truncated ? " (truncated at 50 nodes)" : ""}`;
  const rootLoc = graph.path && graph.line ? ` (${graph.path}:${graph.line})` : "";
  let out = `${depthStr}\n${graph.function}${rootLoc}\n`;

  function renderSubtree(nodes: CallGraphHopNode[], indent: number, relType: "callers" | "callees") {
    const pad = " ".repeat(indent);
    out += `${pad}↳ ${relType}:\n`;
    for (const node of nodes) {
      const loc = node.path ? ` (${node.path}:${node.line})` : "";
      out += `${pad}    - ${node.name}${loc}\n`;
      if (node[relType] && node[relType]!.length > 0) {
        renderSubtree(node[relType]!, indent + 4, relType);
      }
    }
  }

  if (graph.callers && graph.callers.length > 0) {
    renderSubtree(graph.callers, 2, "callers");
  }
  if (graph.callees && graph.callees.length > 0) {
    renderSubtree(graph.callees, 2, "callees");
  }
  if ((!graph.callers || graph.callers.length === 0) && (!graph.callees || graph.callees.length === 0)) {
    out += `  (no ${graph.direction === "both" ? "callers or callees" : graph.direction} found)\n`;
  }

  return out.trimEnd();
}

export function renderPlainText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;

  if (record.tool === "call_graph") {
    return renderCallGraph(record as unknown as CallGraphData);
  }

  if (record.kind === "multi-symbol") {
    const hits = (record.hits as number) ?? 0;
    const misses = (record.misses as number) ?? 0;
    const syms = (record.symbols as Record<string, { status: string; path?: string; line?: number; kind?: string }>) || {};
    let out = `[multi-symbol] (${hits} hit${hits === 1 ? "" : "s"}, ${misses} miss${misses === 1 ? "" : "es"})\n`;
    for (const [name, info] of Object.entries(syms)) {
      if (info.status === "hit") {
        out += `${name}: ${info.path}:${info.line} (${info.kind ?? "symbol"})\n`;
      } else {
        out += `${name}: [miss] (not found)\n`;
      }
    }
    return out.trimEnd();
  }

  if ("symbols" in record && Array.isArray(record.symbols) && "path" in record) {
    const symbols = record.symbols as Array<{ name: string; kind: string; start?: { line: number }; end?: { line: number }; line?: number }>;
    const filePath = record.path as string;
    let out = `[symbols: ${filePath}] (${symbols.length} symbol${symbols.length === 1 ? "" : "s"})\n`;
    for (const s of symbols) {
      const lineStr = s.start && s.end
        ? `L${s.start.line}${s.end.line !== s.start.line ? `-L${s.end.line}` : ""}`
        : `L${s.line ?? 1}`;
      out += `${s.name}: ${s.kind} ${lineStr}\n`;
    }
    return out.trimEnd();
  }

  if (record.tool === "symbol" && "results" in record && Array.isArray(record.results) && "query" in record) {
    const results = record.results as Array<{ name: string; kind: string; path: string; line: number }>;
    const query = record.query as string;
    if (results.length === 0) {
      return `[symbols: '${query}'] (0 matches)`;
    }
    let out = `[symbols: '${query}'] (${results.length} match${results.length === 1 ? "" : "es"})\n`;
    for (const r of results) {
      out += `${r.name}: ${r.kind} ${r.path}:${r.line}\n`;
    }
    return out.trimEnd();
  }

  if (record.status === "hit") {
    const provider = record.provider as string;
    const confidence = record.confidence ? ` (confidence: ${record.confidence})` : "";
    let detail = "";
    if (record.result && typeof record.result === "object" && (record.result as any).tool === "call_graph") {
      const graphStr = renderCallGraph(record.result as CallGraphData);
      const timingStr = record.timings ? `\n[timing] ${formatTimings(record.timings as Record<string, number>)}` : "";
      return `${graphStr}${timingStr}`;
    }
    if (provider === "codedb" || provider === "literal-path") {
      detail = String(record.result ?? "");
    } else if (provider === "fuzzy-lexical") {
      const res = record.result as Record<string, unknown>;
      detail = `${res.name} -> ${res.path}:${res.line}${res.score !== undefined ? ` (score: ${res.score})` : ""}`;
    } else {
      detail = typeof record.result === "string" ? record.result : JSON.stringify(record.result);
    }
    const timingStr = record.timings ? `\n[timing] ${formatTimings(record.timings as Record<string, number>)}` : "";
    return `[hit: ${provider}]${confidence}\n${detail}${timingStr}`;
  }

  if (record.status === "junction") {
    const rec = (record.executedOption as Record<string, unknown>)?.tier ?? "unknown";
    const signal = record.signal as { shape?: string; candidateTokens?: string[] } | undefined;
    const tokens = signal?.candidateTokens?.length ? ` (${signal.candidateTokens.join(", ")})` : "";
    const shapeStr = signal?.shape ? `Signal: ${signal.shape}${tokens}\n` : "";

    const execOpt = record.executedOption as Record<string, unknown>;
    let resStr = "";
    if (execOpt?.result && typeof execOpt.result === "object") {
      const res = execOpt.result as Record<string, unknown>;
      if (res.name) {
        resStr = `Result: ${res.name} in ${res.path}:${res.line}${res.score !== undefined ? ` (score: ${res.score})` : ""}\n`;
      } else {
        resStr = `Result: ${JSON.stringify(res)}\n`;
      }
    } else if (execOpt?.result) {
      resStr = `Result: ${String(execOpt.result)}\n`;
    }

    const tip = record.tip ?? (record.alternativeOption as any)?.continuation?.cliCommand;
    const tipStr = tip ? `Tip: ${tip}\n` : "";
    const timingStr = record.timings ? `[timing] ${formatTimings(record.timings as Record<string, number>)}\n` : "";

    return `[junction] Recommended: ${rec}\n${shapeStr}${resStr}${tipStr}${timingStr}`.trimEnd();
  }

  if (record.status === "miss") {
    const reason = record.reason ?? record.missCode ?? "No match";
    const timingStr = record.timings ? `\n[timing] ${formatTimings(record.timings as Record<string, number>)}` : "";
    return `[miss] ${reason}${timingStr}`;
  }

  if (record.kind === "daemon") {
    const action = record.action as string;
    if (action === "list") {
      const daemons = (record.daemons as Array<{ pid: number; uptime: number; root: string; address: string }>) || [];
      if (daemons.length === 0) return "[daemon] No active daemons running.";
      let out = `[daemon] Active Daemons (${daemons.length}):\n`;
      for (const d of daemons) {
        out += `  PID ${d.pid} | Uptime: ${d.uptime}s | Root: ${d.root}\n    Address: ${d.address}\n`;
      }
      return out.trimEnd();
    }
    if (action === "status") {
      if (record.status === "running") {
        const up = record.uptime ? Math.round(Number(record.uptime)) : 0;
        return `[daemon] Status: running | PID: ${record.pid} | Uptime: ${up}s\n  Root: ${record.root}\n  Address: ${record.address}`;
      }
      return `[daemon] Status: stopped\n  Root: ${record.root}`;
    }
    if (action === "start") {
      if (record.status === "already_running") {
        const up = record.uptime ? Math.round(Number(record.uptime)) : 0;
        return `[daemon] Already running (PID: ${record.pid}, uptime: ${up}s)`;
      }
      return record.ok ? `[daemon] Started successfully (PID: ${record.pid})` : `[daemon] Failed to start resident daemon`;
    }
    if (action === "stop") {
      return record.ok ? `[daemon] Stopped resident service for ${record.root}` : `[daemon] Service not running for ${record.root}`;
    }
    if (action === "restart") {
      return record.ok ? `[daemon] Restarted successfully (PID: ${record.pid})` : `[daemon] Failed to restart daemon`;
    }
    if (action === "ping") {
      const up = record.uptime ? Math.round(Number(record.uptime)) : 0;
      return record.ok ? `[daemon] Pong (PID: ${record.pid}, uptime: ${up}s)` : `[daemon] Service unreachable`;
    }
  }

  return JSON.stringify(value, null, 2);
}
