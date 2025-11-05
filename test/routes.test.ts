import { api } from './setup';

const exampleBuildBody = {
  "domain": "123",
  "wallet_address": "addr",
  "utxos": [],
  "collateral_utxos": [],
  "extension": "ONE_YEAR"
}

describe('API Endpoints', () => {
  it('should respond with status 200 for POST /exampleTx/build', async () => {
    const response = await api.post('/exampleTx/build').send(exampleBuildBody);
    expect(response.status).toBe(200);
  });

  it('should respond with status 200 for POST /exampleTx/submit', async () => {
    const response = await api.post('/exampleTx/submit').send({ signedTx: "signedTx" });
    expect(response.status).toBe(200);
  });
});