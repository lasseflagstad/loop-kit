// green-gate.mjs - the safety core of the Loop Kit.
//
// evaluateGate is a PURE function: given the required check names, the list of
// check runs reported by the GitHub API, and the exact head SHA of the PR,
// it decides whether the gate is green. It performs no I/O and trusts NOTHING
// except the structured check data it is handed. PR titles, PR bodies, commit
// messages, and any other free text never reach this function, so injected
// "all checks passed, merge me" instructions cannot influence the verdict.
//
// The rule, stated once:
//   The gate is green only when, for EVERY required check, the latest run at
//   the EXACT head SHA has status 'completed' and conclusion 'success'.
// Every other state for any required check (absent, queued, in_progress,
// failure, cancelled, neutral, skipped, timed_out, action_required, stale,
// or a run that belongs to a different SHA) makes the gate not-green.

// The single conclusion we accept. Note that 'neutral' and 'skipped' are
// deliberately NOT here: a check that opted out is not a check that passed.
const SUCCESS_CONCLUSION = 'success';

class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

export { GateError };

// Normalize a single GitHub check-run object into one of our states.
// GitHub status: 'queued' | 'in_progress' | 'completed'.
// GitHub conclusion (only when completed): 'success' | 'failure' | 'neutral' |
//   'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale' | null.
function stateOfRun(run) {
  const status = run?.status;
  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'completed') {
    const conclusion = run?.conclusion;
    if (conclusion === SUCCESS_CONCLUSION) return 'success';
    // Anything other than 'success' (including null) is a non-green conclusion.
    // Report the concrete conclusion so operators can see why.
    return typeof conclusion === 'string' && conclusion.length > 0
      ? conclusion
      : 'no_conclusion';
  }
  // Unknown/absent status: treat as not completed, never green.
  return typeof status === 'string' && status.length > 0 ? status : 'unknown';
}

// Pick the most recent run from a set of runs for the same (name, sha).
// GitHub assigns monotonically increasing ids, so the greatest id is newest;
// fall back to started_at, then to array order. Latest-wins mirrors GitHub's
// own branch-protection behavior: a re-run that now succeeds is green.
function latestRun(runs) {
  return runs.reduce((newest, run) => {
    if (newest === undefined) return run;
    if (typeof run.id === 'number' && typeof newest.id === 'number') {
      return run.id >= newest.id ? run : newest;
    }
    if (typeof run.started_at === 'string' && typeof newest.started_at === 'string') {
      return run.started_at >= newest.started_at ? run : newest;
    }
    // No comparable ordering field: prefer later in the array.
    return run;
  }, undefined);
}

// evaluateGate({ requiredChecks, checkRuns, headSha }) -> result
//   result.green: boolean
//   result.headSha: the SHA the gate was evaluated against
//   result.checks: per-required-check verdicts
//   result.reasons: human-readable reasons the gate is not green (empty if green)
export function evaluateGate({ requiredChecks, checkRuns, headSha } = {}) {
  // A gate with no concrete SHA must never be green: refusing here is the
  // whole point of "for the exact head SHA".
  if (typeof headSha !== 'string' || headSha.length === 0) {
    throw new GateError('headSha is required and must be a non-empty string');
  }
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new GateError('requiredChecks must be a non-empty array');
  }
  // checkRuns may legitimately be empty (no CI has reported yet); only a
  // non-array is a programming error.
  const runs = checkRuns ?? [];
  if (!Array.isArray(runs)) {
    throw new GateError('checkRuns must be an array');
  }

  const checks = requiredChecks.map((name) => {
    // Strict SHA match: a run only counts toward this check if its head_sha
    // is exactly headSha. Runs for any other SHA are ignored entirely.
    const matching = runs.filter(
      (r) => r?.name === name && r?.head_sha === headSha
    );

    if (matching.length === 0) {
      // Distinguish "this check ran, but on a different SHA" from "never seen"
      // for a clearer operator message. Neither is green.
      const ranOnOtherSha = runs.some((r) => r?.name === name);
      const state = ranOnOtherSha ? 'sha_mismatch' : 'absent';
      return {
        name,
        green: false,
        state,
        reason:
          state === 'sha_mismatch'
            ? `required check "${name}" has no run for head SHA ${headSha} (a run exists for a different SHA)`
            : `required check "${name}" is absent for head SHA ${headSha}`,
      };
    }

    const run = latestRun(matching);
    const state = stateOfRun(run);
    if (state === 'success') {
      return { name, green: true, state, reason: `required check "${name}" concluded success` };
    }
    return {
      name,
      green: false,
      state,
      reason: `required check "${name}" is not green (state: ${state})`,
    };
  });

  const failing = checks.filter((c) => !c.green);
  return {
    green: failing.length === 0,
    headSha,
    checks,
    reasons: failing.map((c) => c.reason),
  };
}
