import { selectLatestDrepMetadataFromUpdates } from "../src/services/ingestion/drep-sync.service";

describe("drep-sync metadata precedence", () => {
  it("prefers newest update values while backfilling missing fields from older updates", () => {
    const updates = [
      {
        block_time: 200,
        update_tx_hash: "tx_b",
        meta_json: {
          body: {
            givenName: "Newest Name",
          },
        },
      },
      {
        block_time: 100,
        update_tx_hash: "tx_a",
        meta_json: {
          body: {
            givenName: "Old Name",
            paymentAddress: "addr_old",
            image: { contentUrl: "https://old.example/icon.png" },
            doNotList: true,
            bio: "old bio",
            motivations: "old motivations",
            objectives: "old objectives",
            qualifications: "old qualifications",
            references: [{ label: "ref" }],
          },
        },
      },
    ] as any[];

    const metadata = selectLatestDrepMetadataFromUpdates(updates);

    expect(metadata).toEqual({
      name: "Newest Name",
      paymentAddr: "addr_old",
      iconUrl: "https://old.example/icon.png",
      doNotList: true,
      bio: "old bio",
      motivations: "old motivations",
      objectives: "old objectives",
      qualifications: "old qualifications",
      references: JSON.stringify([{ label: "ref" }]),
    });
  });

  it("uses deterministic tx-hash order when block_time ties", () => {
    const updates = [
      {
        block_time: 200,
        update_tx_hash: "tx_z",
        meta_json: {
          body: {
            givenName: "Winner By Tx Hash",
          },
        },
      },
      {
        block_time: 200,
        update_tx_hash: "tx_a",
        meta_json: {
          body: {
            givenName: "Lower Tx Hash",
          },
        },
      },
    ] as any[];

    const metadata = selectLatestDrepMetadataFromUpdates(updates);

    expect(metadata.name).toBe("Winner By Tx Hash");
  });
});
