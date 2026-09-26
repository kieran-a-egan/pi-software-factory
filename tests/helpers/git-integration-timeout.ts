// Hosted Windows Git process startup/contention can exceed Vitest's 5s default:
// CI run 36261280898 timed out tests with 15–33 Git invocations (5.9–7.1s reported).
// Bound the allowance to Git integration suites; retain the default elsewhere.
export const GIT_INTEGRATION_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;
