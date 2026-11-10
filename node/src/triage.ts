/** Deterministic fake support ticket for demos. */
export function makeTicket(ticketId: number) {
  const severity = ticketId % 17 === 0 ? 90 : ticketId % 5 === 0 ? 60 : 20;
  return {
    id: ticketId,
    subject: `Fake ticket #${ticketId}`,
    severity,
    customer: `customer-${ticketId % 100}`,
  };
}

export function needsApproval(
  ticketSeverity: number,
  threshold: number | null | undefined,
): boolean {
  if (threshold === null || threshold === undefined) return false;
  return ticketSeverity >= threshold;
}
