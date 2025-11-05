import axios, { AxiosInstance } from "axios";

const BASE_URL = "https://cardano-mainnet.blockfrost.io/api/v0";

export const getBlockfrostService = (): AxiosInstance => {
  const API_KEY = process.env.MAINNET_BLOCKFROST_API_KEY || "";

  return axios.create({
    baseURL: BASE_URL,
    headers: {
      project_id: API_KEY,
    },
  });
};
