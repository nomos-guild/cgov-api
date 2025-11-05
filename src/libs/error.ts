import { Response } from "express";

export const paramValidationError = (res: Response, message?: string) => {
  res.status(422).json({ error: message || 'Unprocessable entity' })
}

export const missingEnvError = (res: Response, message?: string) => {
  res.status(500).json({ error: message || 'Missing environment variable' })
}
