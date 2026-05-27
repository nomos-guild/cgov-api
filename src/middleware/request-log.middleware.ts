import { Request, Response, NextFunction } from "express";

/**
 * Lightweight request logger for observability on the public read endpoints.
 *
 * Logs `method path status durationMs bytesOut etag?` on response close.
 * Scoped to drep-lens-relevant paths — avoids spamming logs from health
 * checks or admin endpoints that already have their own logging.
 */
const LOGGED_PREFIXES = ["/snapshot", "/migrations", "/epochs", "/actions", "/dreps"];

function shouldLog(url: string): boolean {
  for (const p of LOGGED_PREFIXES) {
    if (url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`)) return true;
  }
  return false;
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  if (!shouldLog(req.path)) return next();

  const startedAt = process.hrtime.bigint();
  const onFinish = () => {
    res.removeListener("finish", onFinish);
    res.removeListener("close", onFinish);
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    const durationMs = (elapsedNs / 1e6).toFixed(1);
    const bytesOut = res.getHeader("Content-Length") ?? "?";
    const etag = (res.getHeader("ETag") as string | undefined) ?? null;
    const encoding = res.getHeader("Content-Encoding") ?? "";
    const message = `[req] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms ${bytesOut}B${
      encoding ? ` enc=${encoding}` : ""
    }${etag ? ` etag=${etag}` : ""}`;
    // 5xx responses ride out at error severity so log aggregators can alert
    // separately from the high-volume 2xx/3xx traffic on the same paths.
    if (res.statusCode >= 500) {
      console.error(message);
    } else {
      console.log(message);
    }
  };
  res.on("finish", onFinish);
  res.on("close", onFinish);
  next();
}
