import { api } from "./setup";

describe("API Endpoints", () => {
  const originalServerApiKey = process.env.SERVER_API_KEY;

  beforeEach(() => {
    process.env.SERVER_API_KEY = "test-api-key";
  });

  afterAll(() => {
    process.env.SERVER_API_KEY = originalServerApiKey;
  });

  it("serves Swagger docs without API auth", async () => {
    const response = await api.get("/api-docs");
    expect(response.status).toBe(301);
    expect(response.headers.location).toContain("/api-docs/");
  });

  it("rejects protected routes without an API key", async () => {
    const response = await api.get("/overview");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: "Unauthorized",
    });
  });

  it("rejects protected routes with an invalid API key", async () => {
    const response = await api.get("/overview").set("X-API-Key", "wrong-key");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "Forbidden",
    });
  });
});
