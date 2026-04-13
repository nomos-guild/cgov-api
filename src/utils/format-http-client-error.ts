import axios from "axios";

const MAX_CAUSE_DEPTH = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAxiosLikeConfig(config: unknown): config is Record<string, unknown> {
  if (!isPlainObject(config)) return false;
  return typeof config.url === "string" || typeof config.baseURL === "string";
}

function appendHttpClientFields(
  err: Record<string, unknown>,
  out: Record<string, unknown>
): void {
  const useAxiosFields =
    axios.isAxiosError(err) || (err.config != null && isAxiosLikeConfig(err.config));

  if (!useAxiosFields) return;

  const cfg = err.config;
  if (isPlainObject(cfg)) {
    if (typeof cfg.method === "string") {
      out.method = cfg.method.toUpperCase();
    }
    if (cfg.baseURL != null) out.baseURL = cfg.baseURL;
    if (cfg.url != null) out.url = cfg.url;
    const src = cfg.__koiosSource;
    if (src != null) out.source = src;
  }

  const res = err.response;
  if (isPlainObject(res)) {
    if (typeof res.status === "number") out.responseStatus = res.status;
    if (typeof res.statusText === "string" && res.statusText) {
      out.responseStatusText = res.statusText;
    }
  }
}

function stackFields(stack: string | undefined): Record<string, string> {
  if (!stack) return {};
  if (process.env.LOG_FULL_ERROR_STACK === "true") {
    return { stack };
  }
  const first = stack.split("\n")[0]?.trim();
  return first ? { stackFirstLine: first } : {};
}

/**
 * Returns a JSON-safe summary for logging. Never includes raw Axios request/response,
 * headers, or bodies (avoids huge socket dumps in Cloud Logging).
 */
export function formatAxiosLikeError(
  err: unknown,
  options?: { depth?: number; visited?: WeakSet<object> }
): Record<string, unknown> {
  const depth = options?.depth ?? 0;
  const visited = options?.visited ?? new WeakSet<object>();

  if (err == null) {
    return { message: String(err) };
  }
  if (typeof err !== "object") {
    return { message: String(err) };
  }

  if (visited.has(err)) {
    return { message: "[circular reference]" };
  }
  visited.add(err);

  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof e.name === "string") out.name = e.name;
  if (typeof e.message === "string") out.message = e.message;
  if (typeof e.code === "string") out.code = e.code;

  Object.assign(
    out,
    stackFields(typeof e.stack === "string" ? e.stack : undefined)
  );

  appendHttpClientFields(e, out);

  if (depth < MAX_CAUSE_DEPTH && e.cause !== undefined && e.cause !== err) {
    out.cause = formatAxiosLikeError(e.cause, {
      depth: depth + 1,
      visited,
    });
  }

  return out;
}
