import { Request, Response } from "express";

export * as dataController from "./data";
export * as overviewController from "./overview";
export * as proposalController from "./proposal";

export const placeholderGet = (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "GET request successful" });
};

export const placeholderPost = (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "POST request successful" });
};
