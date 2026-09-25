export function formatTimings(timings: Record<string, number>): string {
  const parts: string[] = [];
  if (timings.ast_ms !== undefined) parts.push(`ast: ${timings.ast_ms}ms`);
  if (timings.path_ms !== undefined) parts.push(`path: ${timings.path_ms}ms`);
  if (timings.fuzzy_ms !== undefined) parts.push(`fuzzy: ${timings.fuzzy_ms}ms`);
  if (timings.capn_ms !== undefined) parts.push(`capn: ${timings.capn_ms}ms`);
  if (timings.total_ms !== undefined) parts.push(`total: ${timings.total_ms}ms`);
  return parts.join(" | ");
}

export function renderPlainText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;

  if (record.status === "hit") {
    const provider = record.provider as string;
    const confidence = record.confidence ? ` (confidence: ${record.confidence})` : "";
    let detail = "";
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
