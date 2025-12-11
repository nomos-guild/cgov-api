import { Request, Response, NextFunction } from "express";

/**
 * API Key Authentication Middleware
 * Validates the API key from the request header against the server's API key
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"];
  const serverApiKey = process.env.SERVER_API_KEY;

  // If no server API key is configured, skip authentication (development mode)
  if (!serverApiKey) {
    console.warn(
      "⚠️  SERVER_API_KEY not configured. API authentication is disabled."
    );
    return next();
  }

  // Check if API key is provided
  if (!apiKey) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API key is required. Please provide X-API-Key header.",
    });
  }

  // Validate API key
  if (apiKey !== serverApiKey) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Invalid API key.",
    });
  }

  next();
}
