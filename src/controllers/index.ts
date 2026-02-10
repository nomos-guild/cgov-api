import { Request, Response } from "express";

export * as dataController from "./data";
export * as overviewController from "./overview";
export * as proposalController from "./proposal";
export * as developmentController from "./development";
export * as drepController from "./drep";
export * as analyticsController from "./analytics";

export const placeholderGet = (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "GET request successful" });
};

export const placeholderPost = (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "POST request successful" });
};
