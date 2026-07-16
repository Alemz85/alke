// "Run metrics now" (nightly job on demand). Spawns the same entrypoint the
// 03:30 UTC GitHub Actions cron runs — `python -m metrics.compute` — from the
// repo root (dev) or the bundled extraResource copy (packaged; see
// electron-builder.yml). Idempotent: safe to run anytime, re-running just
// recomputes the same rows.
//
// Interpreter resolution: index.ts hydrates process.env.PATH from a login
// shell at startup (packaged apps don't inherit Terminal's PATH), but even
// after that, plain `python3` can resolve to a different interpreter than the
// one the user actually has metrics/requirements.txt installed into — several
// python3s can coexist (pyenv, system, Homebrew, miniforge/conda...) and
// whichever wins PATH order may lack the deps. So we PROBE a short candidate
// list with a cheap `import <deps>` check and use the first one that passes,
// instead of trusting `python3` blindly. The probe result is cached for the
// process lifetime (successful runs don't re-probe) but a failed run clears
// the cache so the next attempt re-probes — picking up e.g. a freshly
// hydrated PATH or a newly-installed interpreter without an app restart.
import { spawn } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { CloudDispatchUnavailable, resolveGithubToken, runCloudMetricsJob } from './metricsCloud'

export interface MetricsJobResult {
  ok: boolean
  summaryLines: string[]
  durationMs: number
  error?: string
}

// Checked in order. `python3` first (respects the hydrated PATH / any venv
// the user has set up), then well-known absolute install locations as a
// fallback net — miniforge/conda's default prefix, then the two common
// Homebrew/system spots on macOS. Absolute candidates are skipped with an
// existsSync check before spawning, since most machines won't have all of
// them.
const CANDIDATE_INTERPRETERS = [
  'python3',
  '/opt/homebrew/Caskroom/miniforge/base/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3'
]

// The metrics job's real import surface (compute.py -> models.py/insights.py
// and the supabase client) — keep this in sync with metrics/requirements.txt.
// Deliberately excludes reverse_geocoder: that's only used by metrics/geo.py
// for GPS route work, not the nightly compute entrypoint this job runs.
const PROBE_IMPORTS = ['supabase', 'pandas', 'numpy', 'statsmodels']
const PROBE_ARGS = ['-c', `import ${PROBE_IMPORTS.join(', ')}`]
const PROBE_TIMEOUT_MS = 10 * 1000

// Cached across calls within this process — re-probing on every "run metrics
// now" click would add ~1s of subprocess spawns per candidate for no benefit
// once we know which interpreter works. Cleared on failure (see
// resolveInterpreter) so a fix (installing deps, changing PATH) is picked up
// without an app restart.
let cachedInterpreter: string | null = null

// Dev: main runs from app/out/main, repo root is three levels up (mirrors
// chat.ts's CHATCTX_DIR derivation). Packaged: metrics/ ships as an
// extraResource sibling of chatctx/knowledge under resourcesPath, and the job
// needs its OWN cwd at that resources root so `python -m metrics.compute`
// resolves the `metrics` package directly beneath cwd.
const REPO_ROOT = app.isPackaged ? process.resourcesPath : join(__dirname, '../../../')

const TIMEOUT_MS = 10 * 60 * 1000
// Keep only the last few meaningful stdout lines for the summary — compute.py
// prints one line per stage; the tail is what a human wants after "done".
const SUMMARY_TAIL_LINES = 6

let running: Promise<MetricsJobResult> | null = null

// Exported for direct unit testing (pure — no process/IO); not part of the
// module's IPC-facing surface.
export function tailMeaningfulLines(stdout: string, count: number): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count)
}

export function classifySpawnError(error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') {
    return 'python3 not found on PATH — the nightly metrics job needs python3 with metrics/requirements.txt installed'
  }
  return `failed to start python3: ${error.message}`
}

export function classifyExitFailure(stderr: string, code: number | null): string {
  const trimmed = stderr.trim()
  if (/ModuleNotFoundError/.test(trimmed)) {
    const tail = trimmed.split('\n').slice(-6).join('\n')
    return `${tail}\n\nMissing Python dependency — run: pip install -r metrics/requirements.txt`
  }
  if (trimmed) {
    return trimmed.split('\n').slice(-10).join('\n')
  }
  return `metrics job exited with code ${code}`
}

interface ProbeFailure {
  interpreter: string
  reason: string
}

interface ProbeResult {
  interpreter: string | null
  failures: ProbeFailure[]
}

// Spawns `<interpreter> -c "import supabase, pandas, numpy, statsmodels"` and
// resolves true/false — never rejects, so probeCandidates can walk the whole
// list without a try/catch per iteration. A non-existent absolute path is a
// spawn ENOENT, which counts as a (cheap) failure, same as an interpreter
// that runs but lacks the deps.
function probeOne(interpreter: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''

    const child = spawn(interpreter, PROBE_ARGS)

    const timeout = setTimeout(() => {
      finish({ ok: false, reason: `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s` })
      child.kill('SIGKILL')
    }, PROBE_TIMEOUT_MS)

    function finish(result: { ok: true } | { ok: false; reason: string }): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: error.code === 'ENOENT' ? 'not found' : error.message })
    })

    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true })
      } else {
        const tail = stderr.trim().split('\n').slice(-2).join(' ').trim()
        finish({ ok: false, reason: tail || `exited with code ${code}` })
      }
    })
  })
}

// Walks CANDIDATE_INTERPRETERS in order, probing each until one passes.
// Absolute paths are skipped with a cheap existsSync check first (no point
// spawning a process for a file that isn't there) but still recorded as a
// failure so the final error message shows every candidate that was tried.
async function probeCandidates(): Promise<ProbeResult> {
  const failures: ProbeFailure[] = []

  for (const interpreter of CANDIDATE_INTERPRETERS) {
    if (interpreter.startsWith('/') && !existsSync(interpreter)) {
      failures.push({ interpreter, reason: 'not found' })
      continue
    }

    const result = await probeOne(interpreter)
    if (result.ok) {
      return { interpreter, failures }
    }
    failures.push({ interpreter, reason: result.reason })
  }

  return { interpreter: null, failures }
}

export function formatNoInterpreterError(failures: ProbeFailure[]): string {
  const lines = failures.map((f) => `  ${f.interpreter}: ${f.reason}`)
  return [
    'No working python3 interpreter found for the metrics job. Tried:',
    ...lines,
    '',
    `Install the metrics dependencies into one of the interpreters above — run: pip install -r metrics/requirements.txt`
  ].join('\n')
}

/**
 * Resolves the python3 interpreter to use for the metrics job: the cached
 * one from a prior successful probe, or a fresh probe across
 * CANDIDATE_INTERPRETERS otherwise. Exported for direct unit testing of the
 * caching behavior.
 */
export async function resolveInterpreter(): Promise<
  { ok: true; interpreter: string } | { ok: false; error: string }
> {
  if (cachedInterpreter) {
    return { ok: true, interpreter: cachedInterpreter }
  }

  const { interpreter, failures } = await probeCandidates()
  if (!interpreter) {
    return { ok: false, error: formatNoInterpreterError(failures) }
  }

  cachedInterpreter = interpreter
  return { ok: true, interpreter }
}

// Runs the already-resolved interpreter against `-m metrics.compute` and
// resolves with a shaped result — never rejects. Split out from
// runMetricsJob so interpreter resolution (which can itself fail with no
// process ever spawned) stays a separate, clearly-ordered step.
function runCompute(interpreter: string, startedAt: number): Promise<MetricsJobResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(interpreter, ['-m', 'metrics.compute'], {
      cwd: REPO_ROOT,
      env: process.env
    })

    const timeout = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      settle({
        ok: false,
        summaryLines: tailMeaningfulLines(stdout, SUMMARY_TAIL_LINES),
        durationMs: Date.now() - startedAt,
        error: 'metrics job timed out after 10 minutes and was killed'
      })
    }, TIMEOUT_MS)

    function settle(result: MetricsJobResult): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      // A spawn/exit failure invalidates the cached interpreter so the next
      // run re-probes from scratch — e.g. the cached interpreter's env got
      // its deps removed, or disk/PATH changed since the last success.
      if (!result.ok) {
        cachedInterpreter = null
      }
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        summaryLines: [],
        durationMs: Date.now() - startedAt,
        error: classifySpawnError(error)
      })
    })

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt
      if (code === 0) {
        settle({
          ok: true,
          summaryLines: [...tailMeaningfulLines(stdout, SUMMARY_TAIL_LINES), `(ran via ${interpreter})`],
          durationMs
        })
      } else {
        settle({
          ok: false,
          summaryLines: tailMeaningfulLines(stdout, SUMMARY_TAIL_LINES),
          durationMs,
          error: classifyExitFailure(stderr, code)
        })
      }
    })
  })
}

/**
 * Runs the metrics job once and resolves with a shaped result — never
 * rejects. Guards against concurrent runs: a second call while one is in
 * flight returns `{ ok: false, error: '... already running' }` immediately.
 *
 * CLOUD-FIRST: when a GitHub token is resolvable (env GITHUB_TOKEN or the
 * gh CLI's stored token), the button dispatches the nightly-metrics workflow
 * and follows it — same clean environment as every nightly, immune to local
 * Python drift. The local spawn (interpreter-probed, see resolveInterpreter)
 * is the fallback for token-less/offline setups; because the job is
 * idempotent, even an ambiguous cloud failure followed by a local run can
 * only rewrite identical rows, never double-count.
 */
export function runMetricsJob(): Promise<MetricsJobResult> {
  if (running) {
    return Promise.resolve({
      ok: false,
      summaryLines: [],
      durationMs: 0,
      error: 'metrics job is already running — wait for it to finish'
    })
  }

  const startedAt = Date.now()
  const job = (async (): Promise<MetricsJobResult> => {
    let cloudNote: string | null = null

    const token = await resolveGithubToken()
    if (token) {
      try {
        return await runCloudMetricsJob(token, startedAt)
      } catch (error) {
        if (!(error instanceof CloudDispatchUnavailable)) throw error
        cloudNote = `cloud dispatch unavailable (${error.message}) — ran locally instead`
      }
    }

    const resolved = await resolveInterpreter()
    if (!resolved.ok) {
      return {
        ok: false,
        summaryLines: cloudNote ? [cloudNote] : [],
        durationMs: Date.now() - startedAt,
        error: resolved.error
      }
    }
    const result = await runCompute(resolved.interpreter, startedAt)
    if (cloudNote) {
      return { ...result, summaryLines: [...result.summaryLines, cloudNote] }
    }
    return result
  })().finally(() => {
    running = null
  })

  running = job
  return job
}
