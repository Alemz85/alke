// "Run metrics now" (nightly job on demand). Spawns the same entrypoint the
// 03:30 UTC GitHub Actions cron runs — `python -m metrics.compute` — from the
// repo root (dev) or the bundled extraResource copy (packaged; see
// electron-builder.yml). Idempotent: safe to run anytime, re-running just
// recomputes the same rows. python3 resolution depends on index.ts's
// login-shell PATH import (packaged apps don't inherit Terminal's PATH) —
// that hydration runs once at startup, before this module is ever invoked.
import { spawn } from 'child_process'
import { app } from 'electron'
import { join } from 'path'

export interface MetricsJobResult {
  ok: boolean
  summaryLines: string[]
  durationMs: number
  error?: string
}

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

/**
 * Runs `python3 -m metrics.compute` once and resolves with a shaped result —
 * never rejects. Guards against concurrent runs: a second call while one is
 * in flight returns `{ ok: false, error: '... already running' }` immediately
 * rather than spawning a second process.
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
  const job = new Promise<MetricsJobResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn('python3', ['-m', 'metrics.compute'], {
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
        settle({ ok: true, summaryLines: tailMeaningfulLines(stdout, SUMMARY_TAIL_LINES), durationMs })
      } else {
        settle({
          ok: false,
          summaryLines: tailMeaningfulLines(stdout, SUMMARY_TAIL_LINES),
          durationMs,
          error: classifyExitFailure(stderr, code)
        })
      }
    })
  }).finally(() => {
    running = null
  })

  running = job
  return job
}
