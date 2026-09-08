import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

it("migrates existing cached data, preserves ordinary proposal fields and invalidates derived artifacts", async () => {
  const db = new PGlite();
  try {
    // Representative pre-migration tables. Unrelated application tables are untouched.
    await db.exec(`CREATE TABLE proposal (id integer PRIMARY KEY, title text, metadata text);
   CREATE TABLE cip179_transaction (tx_hash text PRIMARY KEY, payload text, absolute_slot bigint);
   CREATE TABLE cip179_artifact (survey_key text PRIMARY KEY, artifact text);
   CREATE TABLE sync_status (job_name text PRIMARY KEY, last_result text);
   INSERT INTO proposal VALUES (1,'Ordinary governance action','{"body":{"title":"Preserved"}}');
   INSERT INTO cip179_transaction VALUES ('abc','{"type":"responses"}',100);
   INSERT INTO cip179_artifact VALUES ('abc:0','stale');
   INSERT INTO sync_status VALUES ('cip179-sync','success'),('ordinary-sync','success');`);
    await db.exec(
      readFileSync(
        "prisma/migrations/20260908000000_cip179_chain_integrity/migration.sql",
        "utf8",
      ),
    );
    expect(
      (await db.query<any>("SELECT * FROM proposal")).rows[0],
    ).toMatchObject({
      title: "Ordinary governance action",
      meta_url: null,
      meta_hash: null,
    });
    expect(
      (await db.query<any>("SELECT * FROM cip179_transaction")).rows[0],
    ).toMatchObject({
      tx_hash: "abc",
      payload: '{"type":"responses"}',
      block_hash: null,
      survey_keys: [],
    });
    expect((await db.query("SELECT * FROM cip179_artifact")).rows).toEqual([]);
    expect(
      (
        await db.query<any>(
          "SELECT last_result FROM sync_status WHERE job_name='cip179-sync'",
        )
      ).rows[0].last_result,
    ).toBe("partial");
    expect(
      (
        await db.query<any>(
          "SELECT last_result FROM sync_status WHERE job_name='ordinary-sync'",
        )
      ).rows[0].last_result,
    ).toBe("success");
    await db.exec("UPDATE cip179_transaction SET survey_keys=ARRAY['abc:0']");
    expect(
      (
        await db.query(
          "SELECT tx_hash FROM cip179_transaction WHERE survey_keys @> ARRAY['abc:0']",
        )
      ).rows,
    ).toEqual([{ tx_hash: "abc" }]);
  } finally {
    await db.close();
  }
}, 30000);
