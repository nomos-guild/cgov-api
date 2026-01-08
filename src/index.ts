import dotenv from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import path from "path";
import fs from "fs";
import dataRouter from "./routes/data.route";
import userRouter from "./routes/user.route";
import overviewRouter from "./routes/overview.route";
import proposalRouter from "./routes/proposal.route";
import { apiKeyAuth } from "./middleware/auth.middleware";
import { startAllJobs } from "./jobs";

dotenv.config();

const app = express();

// Trust proxy for GCP Cloud Run deployment
// Set to 1 to trust only the first proxy hop (Cloud Run's load balancer)
// This ensures req.ip returns the real client IP from X-Forwarded-For header
app.set("trust proxy", 1);

// Security: Helmet.js for HTTP security headers
app.use(helmet());

// Security: CORS - allow all origins
app.use(cors());

// Debug: Log IP information for rate limiting analysis
app.use((req, _res, next) => {
  const realClientIp = req.headers['x-real-client-ip'];
  const xff = req.headers['x-forwarded-for'];
  // Priority: X-Real-Client-IP (set by frontend) > X-Forwarded-For > req.ip
  let rateLimitKey: string;
  if (realClientIp) {
    rateLimitKey = Array.isArray(realClientIp) ? realClientIp[0] : realClientIp;
  } else if (typeof xff === 'string') {
    rateLimitKey = xff.split(',')[0].trim();
  } else if (Array.isArray(xff) && xff.length > 0) {
    rateLimitKey = xff[0].split(',')[0].trim();
  } else {
    rateLimitKey = req.ip || 'unknown';
  }
  console.log('[Rate Limit Debug]', {
    path: req.path,
    'X-Real-Client-IP': realClientIp,
    'X-Forwarded-For': xff,
    'Rate-Limit-Key': rateLimitKey,
  });
  next();
});

// Security: Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // Default: 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"), // Default: 100 requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: "Too many requests, please try again later." },
  // Custom key generator to extract real client IP
  // Priority: X-Real-Client-IP (custom header from frontend) > X-Forwarded-For > req.ip
  keyGenerator: (req) => {
    // Check custom header first (set by frontend, not modified by proxies)
    const realClientIp = req.headers["x-real-client-ip"];
    if (realClientIp) {
      return Array.isArray(realClientIp) ? realClientIp[0] : realClientIp;
    }
    // Fall back to X-Forwarded-For
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      return xff.split(",")[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return xff[0].split(",")[0].trim();
    }
    return req.ip || "unknown";
  },
});

app.use(limiter);

app.use(bodyParser.json());

// Serve Swagger documentation from static file (no auth required)
const swaggerPath = path.join(__dirname, "../docs/swagger.json");
if (fs.existsSync(swaggerPath)) {
  const swaggerDocument = JSON.parse(fs.readFileSync(swaggerPath, "utf8"));
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} else {
  console.warn(
    "⚠️  Swagger file not found. Run 'npm run swagger:generate' to create it."
  );
}

// Apply API key authentication to protected routes
app.use("/data", apiKeyAuth, dataRouter);
app.use("/user", apiKeyAuth, userRouter);
app.use("/overview", apiKeyAuth, overviewRouter);
app.use("/proposal", apiKeyAuth, proposalRouter);

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = res.statusCode || 500;
  console.error(err.stack);
  res.status(statusCode).json({ error: err.message });
});

// Start cron jobs only if not disabled
// When running in separate containers, set DISABLE_CRON_IN_API=true
if (process.env.DISABLE_CRON_IN_API !== "true") {
  console.log("Starting cron jobs in API process...");
  startAllJobs();
} else {
  console.log("Cron jobs disabled in API process (running in separate service)");
}

// Start the server
const port = parseInt(process.env.PORT || "3000");
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

export default app;
