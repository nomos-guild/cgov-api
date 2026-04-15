import { resolvePoolEntityId } from "../src/services/ingestion/pool-groups.service";
import type { KoiosPoolGroup } from "../src/types/koios.types";

describe("resolvePoolEntityId", () => {
  const base = (overrides: Partial<KoiosPoolGroup>): KoiosPoolGroup => ({
    pool_id_bech32: "pool1test",
    ...overrides,
  });

  it("uses Koios pool_group when present", () => {
    expect(
      resolvePoolEntityId(
        base({
          pool_group: "EDEN",
          adastat_group: "x",
          balanceanalytics_group: "EDEN",
        })
      )
    ).toBe("EDEN");
  });

  it("falls back to adastat_group when pool_group is null", () => {
    expect(
      resolvePoolEntityId(
        base({
          pool_group: null,
          adastat_group: "garden-pool.com",
          balanceanalytics_group: "SINGLEPOOL",
        })
      )
    ).toBe("garden-pool.com");
  });

  it("uses balanceanalytics_group when not SINGLEPOOL", () => {
    expect(
      resolvePoolEntityId(
        base({
          pool_group: null,
          adastat_group: null,
          balanceanalytics_group: "ACME",
        })
      )
    ).toBe("ACME");
  });

  it("uses pool id when only SINGLEPOOL is set (avoids collapsing all singles)", () => {
    expect(
      resolvePoolEntityId(
        base({
          pool_id_bech32: "pool100wj94uzf54vup2hdzk0afng4dhjaqggt7j434mtgm8v2gfvfgp",
          pool_group: null,
          adastat_group: null,
          balanceanalytics_group: "SINGLEPOOL",
        })
      )
    ).toBe("pool100wj94uzf54vup2hdzk0afng4dhjaqggt7j434mtgm8v2gfvfgp");
  });

  it("returns null when pool id missing", () => {
    expect(
      resolvePoolEntityId(
        base({
          pool_id_bech32: "",
          pool_group: "X",
        })
      )
    ).toBeNull();
  });
});
