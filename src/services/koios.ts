import axios, { AxiosInstance } from "axios";
import { withRetry, type RetryOptions } from "./ingestion/utils";

const BASE_URL = process.env.KOIOS_BASE_URL || "https://api.koios.rest/api/v1";

// Dedicated retry configuration for Koios API calls.
// Koios rate limits can be hit during heavy syncs, so we:
// - Allow more retries
// - Use slightly longer base/max delays than the generic defaults
const KOIOS_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelay: 3000, // 3 seconds
  maxDelay: 30000, // 30 seconds
};

/**
 * Creates and configures an Axios instance for Koios API
 * @returns Configured Axios instance with auth headers and interceptors
 */
export const getKoiosService = (): AxiosInstance => {
  const API_KEY = process.env.KOIOS_API_KEY || "";

  const instance = axios.create({
    baseURL: BASE_URL,
    headers: {
      "Authorization": API_KEY ? `Bearer ${API_KEY}` : undefined,
      "Content-Type": "application/json",
    },
    timeout: 30000, // 30 second timeout for blockchain data queries
  });

  // Add response interceptor for common error handling
  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      console.error("Koios API Error:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        url: error.config?.url,
      });
      return Promise.reject(error);
    }
  );

  return instance;
};

/**
 * Helper function to make GET requests to Koios API with built-in retry logic
 * @param url - The endpoint path (e.g., "/proposal_list")
 * @param params - Optional query parameters
 * @returns The data from the API response
 */
export async function koiosGet<T>(url: string, params?: any): Promise<T> {
  const koios = getKoiosService();

  return withRetry(
    async () => {
      const response = await koios.get<T>(url, { params });
      return response.data;
    },
    KOIOS_RETRY_OPTIONS
  );
}

/**
 * Helper function to make POST requests to Koios API with built-in retry logic
 * @param url - The endpoint path
 * @param data - The request body
 * @returns The data from the API response
 */
export async function koiosPost<T>(url: string, data?: any): Promise<T> {
  const koios = getKoiosService();

  return withRetry(
    async () => {
      const response = await koios.post<T>(url, data);
      return response.data;
    },
    KOIOS_RETRY_OPTIONS
  );
}