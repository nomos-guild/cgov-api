import dotenv from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import path from "path";
import fs from "fs";
import dataRouter from "./routes/data.route";
import userRouter from "./routes/user.route";
import overviewRouter from "./routes/overview.route";
import proposalRouter from "./routes/proposal.route";
import { startAllJobs } from "./jobs";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Serve Swagger documentation from static file
const swaggerPath = path.join(__dirname, "../docs/swagger.json");
if (fs.existsSync(swaggerPath)) {
  const swaggerDocument = JSON.parse(fs.readFileSync(swaggerPath, "utf8"));
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} else {
  console.warn(
    "⚠️  Swagger file not found. Run 'npm run swagger:generate' to create it."
  );
}

app.use("/data", dataRouter);
app.use("/user", userRouter);
app.use("/overview", overviewRouter);
app.use("/proposal", proposalRouter);

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
