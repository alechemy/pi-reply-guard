export const preservationFixtures = [
  { name: "negation", original: "Do not delete the log.", revision: "Delete the log.", check: "preserve-negation" },
  { name: "condition", original: "Restart only after the backup completes.", revision: "Restart before the backup completes.", check: "preserve-conditions" },
  { name: "scope", original: "Some requests need authentication.", revision: "All requests need authentication.", check: "preserve-scope" },
  { name: "uncertainty", original: "The trace suggests that the worker exited.", revision: "The trace proves that the worker exited.", check: "preserve-uncertainty" },
  { name: "attribution", original: "The operator reported a timeout.", revision: "The server reported a timeout.", check: "preserve-attribution" },
  { name: "obligation", original: "You must retain the backup.", revision: "You may retain the backup.", check: "preserve-obligation" },
  { name: "unit", original: "Retain the log for 2 hours.", revision: "Retain the log for 2 minutes.", check: "preserve-quantities" },
  { name: "quantity association", original: "Worker A ran 2 jobs. Worker B ran 3 jobs.", revision: "Worker A ran 3 jobs. Worker B ran 2 jobs.", check: "preserve-quantities" },
  { name: "invented cause", original: "The worker stopped.", revision: "The worker stopped because memory ran out.", check: "preserve-invention" },
  { name: "invented experience", original: "Restart the worker.", revision: "I have fixed this before. Restart the worker.", check: "preserve-invention" },
  { name: "omitted limitation", original: "The check passed on the test host. Production was unavailable.", revision: "The check passed.", check: "preserve-omission" },
  { name: "style repair", original: "Retain the log—keep it for 2 hours.", revision: "Retain the log for 2 hours.", check: null },
];
