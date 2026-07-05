# Dogfood friction log (ad-studio-v2 migration)

## 2026-07-05 — rejecting a review gate re-buys everything

Rejecting `review-storyboard` (bad artifact, wanted a re-roll with a better
prompt) marks the whole RUN rejected. The only path forward is a fresh run,
which re-buys every step — there is no way to invalidate ONE done step and
re-run it within the same run. v1's hand-rolled ledger had this (`verdict.ts
reject` + scripts querying for kept generations).

Cheap here (storyboard was the first paid step, $0.15), but rejecting a late
step in a long pipeline would re-buy the entire prefix. Wanted: something like
`invalidateStep(db, runId, key)` (or gate reject with `retry: step-key`
semantics) that marks the done step failed→re-runnable and clears its review
gate, so the run resumes from that step instead of dying.

Related papercut: the checklist gate had to be re-kept on the fresh run even
though the concept hadn't changed — gate verdicts are per-run with no notion
of "same evidence, carry the verdict".
