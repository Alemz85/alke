// Cloud path for "run metrics now": dispatches the existing nightly-metrics
// GitHub Actions workflow (workflow_dispatch) and polls the run to completion.
// Preferred over the local python spawn because it runs in the same clean
// environment as every nightly (pip install from requirements.txt per run) —
// immune to the local interpreter drift that broke the packaged app. The
// local path (metricsJob.ts) remains the fallback for token-less setups,
// offline work, and dev machines.
//
// Token resolution is deliberately zero-config on the owner's machine:
// GITHUB_TOKEN from the app env (.env) wins if present; otherwise the
// installed `gh` CLI is asked for its stored OAuth token at call time —
// nothing new is persisted anywhere. PATH is login-shell hydrated in packaged
// apps (index.ts), the same mechanism that finds the claude CLI.
import { execFile } from 'child_process'
import type { MetricsJobResult } from './metricsJob'

const OWNER_REPO = 'Alemz85/health-analytics'
const WORKFLOW_FILE = 'nightly-metrics.yml'
const API_BASE = `https://api.github.com/repos/${OWNER_REPO}/actions`

const FIND_RUN_TIMEOUT_MS = 90 * 1000
const RUN_TIMEOUT_MS = 6 * 60 * 1000
const POLL_INTERVAL_MS = 5 * 1000
// GitHub's clock and ours can disagree by a little; when matching "the run
// our dispatch created" by created_at, look slightly before dispatch time.
const CLOCK_SLACK_MS = 30 * 1000

/**
 * Infrastructure problems on the cloud path (no dispatch accepted, network
 * down, run never found) — the caller falls back to the local run, which is
 * safe even in ambiguity because the job is idempotent: a duplicate compute
 * just rewrites identical rows.
 */
export class CloudDispatchUnavailable extends Error {}

export async function resolveGithubToken(): Promise<string | null> {
  const envToken = process.env.GITHUB_TOKEN?.trim()
  if (envToken) return envToken
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null)
    })
  })
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface WorkflowRun {
  id: number
  run_number: number
  status: string
  conclusion: string | null
  created_at: string
  html_url: string
}

/**
 * Finds the run our dispatch just created: newest workflow_dispatch run of
 * this workflow created at/after dispatch time (minus clock slack). The
 * dispatch endpoint returns 204 with no run id, so this lookup is the only
 * way to follow the run — retried because the run can take a few seconds to
 * materialize after the 204.
 */
async function findDispatchedRun(token: string, dispatchedAtMs: number): Promise<WorkflowRun> {
  const cutoffIso = new Date(dispatchedAtMs - CLOCK_SLACK_MS).toISOString()
  const deadline = dispatchedAtMs + FIND_RUN_TIMEOUT_MS

  while (Date.now() < deadline) {
    const response = await fetch(
      `${API_BASE}/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`,
      { headers: ghHeaders(token) }
    )
    if (response.ok) {
      const body = (await response.json()) as { workflow_runs?: WorkflowRun[] }
      const match = (body.workflow_runs ?? []).find((run) => run.created_at >= cutoffIso)
      if (match) return match
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new CloudDispatchUnavailable('dispatch accepted but the run never appeared')
}

/**
 * Dispatches the workflow and follows it to completion. Returns a shaped
 * result for COMPLETED runs — including failed ones (a real job failure must
 * be reported, not papered over with a local re-run). Throws
 * CloudDispatchUnavailable only for infrastructure problems where falling
 * back to the local path is the right move.
 */
export async function runCloudMetricsJob(
  token: string,
  startedAt: number
): Promise<MetricsJobResult> {
  const dispatchedAtMs = Date.now()
  let dispatch: Response
  try {
    dispatch = await fetch(`${API_BASE}/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    })
  } catch (error) {
    throw new CloudDispatchUnavailable(
      `GitHub unreachable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (dispatch.status !== 204) {
    throw new CloudDispatchUnavailable(`dispatch rejected (HTTP ${dispatch.status})`)
  }

  const run = await findDispatchedRun(token, dispatchedAtMs)

  const deadline = dispatchedAtMs + RUN_TIMEOUT_MS
  let latest = run
  while (latest.status !== 'completed') {
    if (Date.now() >= deadline) {
      return {
        ok: false,
        summaryLines: [],
        durationMs: Date.now() - startedAt,
        error: `cloud run #${latest.run_number} still not finished after ${RUN_TIMEOUT_MS / 60000} minutes — check ${latest.html_url}`
      }
    }
    await sleep(POLL_INTERVAL_MS)
    const response = await fetch(`${API_BASE}/runs/${run.id}`, { headers: ghHeaders(token) })
    if (response.ok) {
      latest = (await response.json()) as WorkflowRun
    }
  }

  const durationMs = Date.now() - startedAt
  if (latest.conclusion === 'success') {
    return {
      ok: true,
      summaryLines: [
        `Metrics recomputed in the cloud (nightly-metrics run #${latest.run_number})`,
        '(ran via GitHub Actions — same environment as the nightly cron)'
      ],
      durationMs
    }
  }
  return {
    ok: false,
    summaryLines: [],
    durationMs,
    error: `cloud run #${latest.run_number} concluded: ${latest.conclusion} — ${latest.html_url}`
  }
}
