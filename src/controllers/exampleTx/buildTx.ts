import { Request, Response } from "express";
import { buildExampleTx } from "../../transactions";

export const buildTx = (_req: Request, res: Response) => {
  const signedTx = buildExampleTx();
  res.json({ signedTx });
};
