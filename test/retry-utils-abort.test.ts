import { withRetry } from "../src/services/ingestion/utils";

describe("withRetry abort handling", () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it("fails fast when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("already-cancelled");
    const operation = jest.fn().mockResolvedValue("ok");

    await expect(
      withRetry(
        operation,
        {
          maxRetries: 2,
          baseDelay: 10,
          maxDelay: 20,
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not execute another attempt after abort during retry delay", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(
      operation,
      {
        maxRetries: 1,
        baseDelay: 1000,
        maxDelay: 1000,
      },
      { signal: controller.signal }
    );
    const settled = promise.catch((error) => error);

    await Promise.resolve();
    controller.abort("cancel-backoff");
    await jest.advanceTimersByTimeAsync(1000);

    await expect(settled).resolves.toMatchObject({
      name: "AbortError",
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
