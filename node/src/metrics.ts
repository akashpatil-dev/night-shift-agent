const counters = {
  tasks_created: 0,
  tasks_completed: 0,
  tasks_failed: 0,
  tasks_dead_lettered: 0,
  tasks_cancelled: 0,
  retries: 0,
};

export function inc(
  name: keyof typeof counters,
  by = 1,
): void {
  counters[name] += by;
}

export function snapshot(): typeof counters {
  return { ...counters };
}

export function prometheusText(): string {
  const lines = [
    "# HELP nightshift_tasks_created Tasks created",
    "# TYPE nightshift_tasks_created counter",
    `nightshift_tasks_created ${counters.tasks_created}`,
    "# HELP nightshift_tasks_completed Tasks completed",
    "# TYPE nightshift_tasks_completed counter",
    `nightshift_tasks_completed ${counters.tasks_completed}`,
    "# HELP nightshift_tasks_failed Tasks failed",
    "# TYPE nightshift_tasks_failed counter",
    `nightshift_tasks_failed ${counters.tasks_failed}`,
    "# HELP nightshift_tasks_dead_lettered Tasks moved to dead letter",
    "# TYPE nightshift_tasks_dead_lettered counter",
    `nightshift_tasks_dead_lettered ${counters.tasks_dead_lettered}`,
    "# HELP nightshift_tasks_cancelled Tasks cancelled",
    "# TYPE nightshift_tasks_cancelled counter",
    `nightshift_tasks_cancelled ${counters.tasks_cancelled}`,
    "# HELP nightshift_retries Worker retries scheduled",
    "# TYPE nightshift_retries counter",
    `nightshift_retries ${counters.retries}`,
  ];
  return lines.join("\n") + "\n";
}

export function resetMetrics(): void {
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) {
    counters[k] = 0;
  }
}
