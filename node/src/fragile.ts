import { FRAGILE_FAIL_AT } from "./config.js";
import { makeTicket } from "./triage.js";

/**
 * Day-0 fragile path: blocks until all tickets are done, then dies mid-flight.
 * No checkpoint, no queue - illustrative anti-pattern.
 */
export async function fragileTriageTickets(count: number): Promise<{
  triaged: number;
}> {
  let processed = 0;
  for (let i = 0; i < count; i++) {
    const ticket = makeTicket(i);
    // pretend to write
    void ticket;
    processed += 1;
    if (processed === FRAGILE_FAIL_AT) {
      throw new Error(
        `Fragile worker crashed at ticket ${FRAGILE_FAIL_AT} with no checkpoint`,
      );
    }
  }
  return { triaged: processed };
}
