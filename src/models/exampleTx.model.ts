export interface BuildExampleTxBody {
  domain: string
  wallet_address: string
  utxos: string[]
  collateral_utxos: string[]
  extension: ExtensionType
}

export interface SubmitExampleTxBody {
  signedTx: string
}

export enum ExtensionType {
  ONE_YEAR = 'ONE_YEAR',
  TWO_YEAR = 'TWO_YEAR',
  THREE_YEAR = 'THREE_YEAR',
  LIFETIME = 'LIFETIME',
}