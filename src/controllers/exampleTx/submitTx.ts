// import { BlockfrostService } from '@services/blockfrost/BlockfrostService';
import { Request, Response } from 'express';

export const submitTx = async (req: Request, res: Response) => {
  const { signedTx } = req.body;
  // const blockfrost = new BlockfrostService();
  // const response = await blockfrost.submitTransaction(signedTx);
  const response = { txHash: signedTx };
  res.json(response);
}
