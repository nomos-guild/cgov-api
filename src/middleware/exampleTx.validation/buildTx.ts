// Custom middleware for validation
import { Request, Response, NextFunction } from 'express';
import type { FromSchema } from 'json-schema-to-ts';
import {
  IsString,
  IsNotEmpty,
  validate,
  IsEnum,
  IsArray,
  MaxLength,
} from 'class-validator';
import { ExtensionType } from '../../models/exampleTx.model';
import { paramValidationError } from '../../libs/error';

const schema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    wallet_address: { type: 'string' },
    utxos: { type: 'array', items: { type: 'string' } },
    collateral_utxos: { type: 'array', items: { type: 'string' } },
    extension: { type: 'string' },
  },
  required: ['domain', 'wallet_address', 'utxos', 'collateral_utxos', 'extension'],
} as const;

class Param {
  @IsString()
  @IsNotEmpty()
  @MaxLength(18)
  domain: string;

  @IsString()
  wallet_address: string;

  @IsArray()
  utxos: string[];

  @IsArray()
  collateral_utxos: string[];

  @IsEnum(ExtensionType)
  extension: ExtensionType;
}

const validateParam = async (req: Request, res: Response, next: NextFunction) => {
  const body: FromSchema<typeof schema> = req.body
  const param = new Param();
  param.domain = body.domain;
  param.wallet_address = body.wallet_address;
  param.utxos = body.utxos;
  param.collateral_utxos = body.collateral_utxos;
  param.extension = ExtensionType[body.extension];

  const errors = await validate(param);
  if (errors.length > 0) {
    console.log(`validation error: ${errors}`);
    paramValidationError(res)
  } else {
    next();
  }
}

export { schema, validateParam }
