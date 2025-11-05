import { paramValidationError } from '../libs/error';
import { Request, Response, NextFunction } from 'express';

export const validateTxHash = (req: Request, res: Response, next: NextFunction) => {
  const txHash = req.params.txHash;
  const isString = typeof txHash !== 'string'
  const lengthCorrect = txHash.length === 64

  if (!txHash || !isString || !lengthCorrect) {
    paramValidationError(res, 'Invalid txHash')
  }
  next();
}
