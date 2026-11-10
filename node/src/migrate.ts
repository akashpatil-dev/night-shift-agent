import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { log } from "./logging.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = join(__dirname, "../../sql/schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query(sql);
  log.info("migrate_ok", { schemaPath });
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
