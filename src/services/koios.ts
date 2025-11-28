import axios, { AxiosInstance } from "axios";

let koiosClient: AxiosInstance | null = null;

const createKoiosClient = (): AxiosInstance => {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const apiKey = process.env.KOIOS_API_KEY;
  if (apiKey) {
    headers.Authorization = apiKey.startsWith("Bearer ")
      ? apiKey
      : `Bearer ${apiKey}`;
  }

  const baseURL = process.env.KOIOS_API_URL || "https://api.koios.rest/api/v1";
  const timeout = Number(process.env.KOIOS_TIMEOUT ?? 20000);

  return axios.create({ baseURL, headers, timeout });
};

export const getKoiosService = (): AxiosInstance => {
  if (!koiosClient) {
    koiosClient = createKoiosClient();
  }

  return koiosClient;
};
