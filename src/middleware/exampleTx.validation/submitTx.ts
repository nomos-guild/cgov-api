// Custom middleware for validation
import { Request, Response, NextFunction } from 'express';
import type { FromSchema } from 'json-schema-to-ts';
import { paramValidationError } from '../../libs/error';
import {
  IsString,
  validate,
} from 'class-validator';

const schema = {
  type: 'object',
  properties: {
    signedTx: { type: 'string' },
  },
  required: ['signedTx'],
} as const;

class Param {
  @IsString()
  signedTx: string;
}

const validateParam = async (req: Request, res: Response, next: NextFunction) => {
  const body: FromSchema<typeof schema> = req.body
  const param = new Param();
  param.signedTx = body.signedTx;

  const errors = await validate(param);
  if (errors.length > 0) {
    console.log(`validation error: ${errors}`);
    paramValidationError(res)
  };
  next();
}

export { schema, validateParam }
