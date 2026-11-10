import { FRAGILE_FAIL_AT } from "../config.js";
import { fragileTriageTickets } from "../fragile.js";
import { McpHttpClient } from "../client.js";

async function main() {
  console.log("=== Day 0: fragile vs queued ===\n");

  console.log(`Fragile path (fails at ticket ${FRAGILE_FAIL_AT})...`);
  try {
    await fragileTriageTickets(2000);
  } catch (err) {
    console.log(`  FAILED as expected: ${(err as Error).message}`);
  }

  console.log("\nQueued path (returns handle immediately)...");
  const client = new McpHttpClient();
  const created = await client.triageTickets({ count: 200 });
  console.log(`  taskId=${created.taskId} status=${created.status}`);
  console.log("  (worker will finish in the background - no client timeout)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
