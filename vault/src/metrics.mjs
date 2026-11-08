/** Minimal in-process metrics registry (Prometheus text exposition). */
export function createMetrics() {
  const counters = new Map();
  const startedAt = Date.now();

  function key(method, route, status) {
    return method + " " + route + " " + String(status);
  }

  function record(method, route, status, durationMs) {
    const k = key(method, route, status);
    const current = counters.get(k) || { count: 0, durationMs: 0 };
    current.count += 1;
    current.durationMs += durationMs;
    counters.set(k, current);
  }

  function render(extra = {}) {
    const lines = [];
    lines.push("# HELP vault_http_requests_total HTTP requests handled by the Vault API");
    lines.push("# TYPE vault_http_requests_total counter");
    for (const [k, value] of [...counters.entries()].sort()) {
      const parts = k.split(" ");
      lines.push(
        "vault_http_requests_total{method=\"" + parts[0] + "\",route=\"" + parts[1] + "\",status=\"" + parts[2] + "\"} " + value.count,
      );
    }
    lines.push("# HELP vault_http_request_duration_ms_sum Sum of request durations in milliseconds");
    lines.push("# TYPE vault_http_request_duration_ms_sum counter");
    for (const [k, value] of [...counters.entries()].sort()) {
      const parts = k.split(" ");
      lines.push(
        "vault_http_request_duration_ms_sum{method=\"" + parts[0] + "\",route=\"" + parts[1] + "\",status=\"" + parts[2] + "\"} " + value.durationMs.toFixed(3),
      );
    }
    lines.push("# HELP vault_process_uptime_seconds Vault API process uptime in seconds");
    lines.push("# TYPE vault_process_uptime_seconds gauge");
    lines.push("vault_process_uptime_seconds " + ((Date.now() - startedAt) / 1000).toFixed(3));
    if (extra.queue) {
      lines.push("# HELP vault_ingest_queue_jobs Ingest jobs by status");
      lines.push("# TYPE vault_ingest_queue_jobs gauge");
      for (const status of ["pending", "running", "succeeded", "failed", "skipped", "total"]) {
        if (extra.queue[status] !== undefined) lines.push("vault_ingest_queue_jobs{status=\"" + status + "\"} " + extra.queue[status]);
      }
    }
    if (extra.usage) {
      lines.push("# HELP vault_records_total Stored record counts by kind");
      lines.push("# TYPE vault_records_total gauge");
      for (const [kind, value] of Object.entries(extra.usage)) lines.push("vault_records_total{kind=\"" + kind + "\"} " + value);
    }
    return lines.join("\n") + "\n";
  }

  return { record, render };
}
