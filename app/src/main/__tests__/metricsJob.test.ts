import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// metricsJob.ts reads `app.isPackaged` at module load for its cwd resolution
// and imports `electron`'s `app` — stub it so the module loads outside a real
// Electron process. Kept minimal: only what metricsJob.ts touches.
vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

// metricsJob.ts existsSync-checks absolute interpreter candidates before
// probing them (cheap skip for paths that aren't there). Default every path
// to "exists" so probes actually reach spawn(); individual tests override
// this to exercise the skip-without-spawning branch.
const existsSyncMock = vi.fn((_path: string) => true)
vi.mock('fs', () => ({ existsSync: (...args: unknown[]) => existsSyncMock(...(args as [string])) }))

// A hand-rolled fake ChildProcess: EventEmitter for 'error'/'close', plus
// stdout/stderr sub-emitters, so tests can drive spawn() outcomes without a
// real python3 process (per the task's "don't spawn real python" gate).
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

const spawnMock = vi.fn<() => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...(args as [])) }))
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...(args as [])) }))

// Cloud-first orchestration collaborator: default to "no token" so every
// local-path test below behaves exactly as before the cloud path existed;
// the cloud-orchestration describe reprograms these per test. The mocked
// CloudDispatchUnavailable class is what metricsJob's instanceof check sees,
// so orchestration tests must throw THIS class (import it from
// '../metricsCloud' — the mock resolves to it).
const resolveGithubTokenMock = vi.fn<() => Promise<string | null>>()
const runCloudMetricsJobMock = vi.fn()
vi.mock('../metricsCloud', () => ({
  CloudDispatchUnavailable: class CloudDispatchUnavailable extends Error {},
  resolveGithubToken: (...args: unknown[]) => resolveGithubTokenMock(...(args as [])),
  runCloudMetricsJob: (...args: unknown[]) => runCloudMetricsJobMock(...(args as []))
}))

// The candidate order metricsJob.ts probes, in order — pinned here
// independently of the module so a test failure clearly signals a change to
// the contract described in the task: python3 first, then well-known
// absolute fallbacks.
const CANDIDATE_INTERPRETERS = [
  'python3',
  '/opt/homebrew/Caskroom/miniforge/base/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3'
]

// Every async step in metricsJob.ts's probe chain (spawn -> close handler ->
// probeOne's promise -> probeCandidates' loop -> resolveInterpreter ->
// runMetricsJob's continuation -> next spawn) is a real microtask hop, and
// probeOne also arms a real `setTimeout`. Under fake timers,
// advanceTimersByTimeAsync(0) drains both microtasks and any due timers in
// one go; repeating it a few times walks the whole chain regardless of
// exactly how many hops it takes.
async function flush(steps = 6): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('metricsJob', () => {
  let metricsJob: typeof import('../metricsJob')

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    spawnMock.mockReset()
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    resolveGithubTokenMock.mockReset()
    resolveGithubTokenMock.mockResolvedValue(null)
    runCloudMetricsJobMock.mockReset()
    metricsJob = await import('../metricsJob')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('tailMeaningfulLines', () => {
    it('drops blank lines and keeps only the last N', () => {
      const stdout = ['a', '', '  ', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
      expect(metricsJob.tailMeaningfulLines(stdout, 3)).toEqual(['e', 'f', 'g'])
    })

    it('trims surrounding whitespace on each kept line', () => {
      expect(metricsJob.tailMeaningfulLines('  hello  \nworld', 2)).toEqual(['hello', 'world'])
    })

    it('returns everything when there are fewer lines than the tail count', () => {
      expect(metricsJob.tailMeaningfulLines('only one', 6)).toEqual(['only one'])
    })
  })

  describe('classifySpawnError', () => {
    it('gives a clear "python3 not found" message for ENOENT', () => {
      const error = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' })
      expect(metricsJob.classifySpawnError(error)).toMatch(/python3 not found on PATH/)
    })

    it('falls back to the raw message for other spawn errors', () => {
      const error = Object.assign(new Error('EACCES'), { code: 'EACCES' })
      expect(metricsJob.classifySpawnError(error)).toBe('failed to start python3: EACCES')
    })
  })

  describe('classifyExitFailure', () => {
    it('adds a pip-install hint for ModuleNotFoundError', () => {
      const stderr = 'Traceback (most recent call last):\nModuleNotFoundError: No module named "pandas"'
      const message = metricsJob.classifyExitFailure(stderr, 1)
      expect(message).toMatch(/ModuleNotFoundError/)
      expect(message).toMatch(/pip install -r metrics\/requirements\.txt/)
    })

    it('returns the trimmed stderr tail when present', () => {
      const stderr = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
      const message = metricsJob.classifyExitFailure(stderr, 1)
      expect(message.split('\n')).toHaveLength(10)
      expect(message.split('\n')[0]).toBe('line 10')
      expect(message.split('\n')[9]).toBe('line 19')
    })

    it('falls back to an exit-code message when stderr is empty', () => {
      expect(metricsJob.classifyExitFailure('', 3)).toBe('metrics job exited with code 3')
    })
  })

  describe('formatNoInterpreterError', () => {
    it('lists every tried interpreter with its reason, ending with the pip hint', () => {
      const message = metricsJob.formatNoInterpreterError([
        { interpreter: 'python3', reason: 'ModuleNotFoundError: No module named "supabase"' },
        { interpreter: '/usr/bin/python3', reason: 'not found' }
      ])
      expect(message).toMatch(/No working python3 interpreter found/)
      expect(message).toMatch(/python3: ModuleNotFoundError/)
      expect(message).toMatch(/\/usr\/bin\/python3: not found/)
      expect(message).toMatch(/pip install -r metrics\/requirements\.txt/)
    })
  })

  // Helper: queue one FakeChildProcess per spawn() call, in call order, and
  // return the array so a test can drive each one's events independently.
  // Probing walks CANDIDATE_INTERPRETERS in order (skipping any where
  // existsSync is false), then — once a candidate passes — one more spawn
  // happens for the actual `-m metrics.compute` run.
  function queueFakes(count: number): FakeChildProcess[] {
    const fakes = Array.from({ length: count }, () => new FakeChildProcess())
    fakes.forEach((fake) => spawnMock.mockReturnValueOnce(fake))
    return fakes
  }

  // Drives a probe FakeChildProcess to a passing (`import ...` exits 0) or
  // failing (ModuleNotFoundError, exit 1) outcome.
  function passProbe(fake: FakeChildProcess): void {
    fake.emit('close', 0)
  }
  function failProbe(fake: FakeChildProcess, stderrText = 'ModuleNotFoundError: No module named "supabase"'): void {
    fake.stderr.emit('data', Buffer.from(`Traceback...\n${stderrText}\n`))
    fake.emit('close', 1)
  }

  describe('resolveInterpreter / probing', () => {
    it('uses the first candidate (python3) when it passes the import probe', async () => {
      const [probe, compute] = queueFakes(2)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()

      passProbe(probe)
      await flush()
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(spawnMock).toHaveBeenNthCalledWith(1, 'python3', expect.arrayContaining(['-c']))
      expect(spawnMock).toHaveBeenNthCalledWith(2, 'python3', ['-m', 'metrics.compute'], expect.anything())
    })

    it('skips a failing candidate and falls through to the next passing one', async () => {
      const [probe1, probe2, compute] = queueFakes(3)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()

      failProbe(probe1)
      await flush()
      passProbe(probe2)
      await flush()
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(spawnMock).toHaveBeenNthCalledWith(1, 'python3', expect.arrayContaining(['-c']))
      expect(spawnMock).toHaveBeenNthCalledWith(2, CANDIDATE_INTERPRETERS[1], expect.arrayContaining(['-c']))
      expect(spawnMock).toHaveBeenNthCalledWith(
        3,
        CANDIDATE_INTERPRETERS[1],
        ['-m', 'metrics.compute'],
        expect.anything()
      )
    })

    it('includes which interpreter ran in the success summary', async () => {
      const [probe, compute] = queueFakes(2)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()

      passProbe(probe)
      await flush()
      compute.stdout.emit('data', Buffer.from('computed_zone2_fitness: 2283 rows\n'))
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(result.summaryLines).toContain('computed_zone2_fitness: 2283 rows')
      expect(result.summaryLines.some((line) => line.includes('python3'))).toBe(true)
    })

    it('skips an absolute candidate that does not exist without spawning it', async () => {
      // python3 fails; the miniforge path doesn't exist on this machine; the
      // next absolute path passes.
      existsSyncMock.mockImplementation((path: string) => path !== CANDIDATE_INTERPRETERS[1])
      const [probe1, probe3, compute] = queueFakes(3)

      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      failProbe(probe1)
      await flush()
      // No spawn for CANDIDATE_INTERPRETERS[1] — existsSync said no, straight to [2].
      passProbe(probe3)
      await flush()
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(spawnMock).toHaveBeenCalledTimes(3) // probe(python3), probe(candidate[2]), compute
      expect(spawnMock).toHaveBeenNthCalledWith(2, CANDIDATE_INTERPRETERS[2], expect.arrayContaining(['-c']))
    })

    it('caches the resolved interpreter across runs — no re-probing on a second success', async () => {
      const [probe, compute1] = queueFakes(2)
      const first = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()
      compute1.emit('close', 0)
      await first

      expect(spawnMock).toHaveBeenCalledTimes(2) // one probe + one compute

      const [compute2] = queueFakes(1)
      const second = metricsJob.runMetricsJob()
      await flush()
      compute2.emit('close', 0)
      const result = await second

      expect(result.ok).toBe(true)
      expect(spawnMock).toHaveBeenCalledTimes(3) // no new probe spawn — cached
      expect(spawnMock).toHaveBeenNthCalledWith(3, 'python3', ['-m', 'metrics.compute'], expect.anything())
    })

    it('re-probes after a failed run instead of reusing the stale cached interpreter', async () => {
      const [probe, compute1] = queueFakes(2)
      const first = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()
      compute1.stderr.emit('data', Buffer.from('ModuleNotFoundError: No module named "pandas"\n'))
      compute1.emit('close', 1)
      const firstResult = await first
      expect(firstResult.ok).toBe(false)

      // Second run must probe again (cache invalidated), not jump straight to compute.
      const [probe2, compute2] = queueFakes(2)
      const second = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe2)
      await flush()
      compute2.emit('close', 0)
      const secondResult = await second

      expect(secondResult.ok).toBe(true)
      expect(spawnMock).toHaveBeenCalledTimes(4) // probe+compute, then probe+compute again
      expect(spawnMock).toHaveBeenNthCalledWith(3, 'python3', expect.arrayContaining(['-c']))
    })

    it('resolves ok:false listing every interpreter tried when none pass', async () => {
      const fakes = queueFakes(CANDIDATE_INTERPRETERS.length)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()

      for (const fake of fakes) {
        failProbe(fake, 'ModuleNotFoundError: No module named "supabase"')
        await flush()
      }

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(spawnMock).toHaveBeenCalledTimes(CANDIDATE_INTERPRETERS.length)
      for (const interpreter of CANDIDATE_INTERPRETERS) {
        expect(result.error).toContain(interpreter)
      }
      expect(result.error).toMatch(/pip install -r metrics\/requirements\.txt/)
    })

    it('treats a probe spawn ENOENT the same as a failed import check', async () => {
      const [probe1, probe2, compute] = queueFakes(3)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()

      probe1.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      await flush()
      passProbe(probe2)
      await flush()
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(spawnMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('runMetricsJob', () => {
    it('resolves ok:true with the tailed stdout summary on a clean exit', async () => {
      const [probe, compute] = queueFakes(2)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()

      compute.stdout.emit('data', Buffer.from('computed_zone2_fitness: 2283 rows\n'))
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(result.summaryLines).toContain('computed_zone2_fitness: 2283 rows')
      expect(result.error).toBeUndefined()
      expect(typeof result.durationMs).toBe('number')
    })

    it('resolves ok:false with a stderr-derived error on non-zero exit', async () => {
      const [probe, compute] = queueFakes(2)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()

      compute.stderr.emit('data', Buffer.from('boom\n'))
      compute.emit('close', 1)

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toBe('boom')
    })

    it('resolves ok:false when the compute spawn itself fails (ENOENT) after a successful probe', async () => {
      const [probe, compute] = queueFakes(2)
      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()

      compute.emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }))

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/python3 not found on PATH/)
    })

    it('rejects a concurrent invocation with an "already running" error instead of spawning twice', async () => {
      const [probe, compute] = queueFakes(2)

      const first = metricsJob.runMetricsJob()
      const second = await metricsJob.runMetricsJob()

      // Only the probe spawn for `first` has happened so far — `second` was
      // short-circuited by the concurrency guard before any spawn of its own.
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/already running/)

      passProbe(probe)
      await flush()
      compute.emit('close', 0)
      await first
    })

    it('allows a new run once the previous one has settled', async () => {
      const [probe1, compute1] = queueFakes(2)
      const first = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe1)
      await flush()
      compute1.emit('close', 0)
      await first

      const [compute2] = queueFakes(1)
      const second = metricsJob.runMetricsJob()
      await flush()
      compute2.emit('close', 0)
      const result = await second

      expect(spawnMock).toHaveBeenCalledTimes(3) // probe + compute1 + compute2 (cached, no re-probe)
      expect(result.ok).toBe(true)
    })

    it('kills the child and reports a timeout after 10 minutes', async () => {
      const [probe, compute] = queueFakes(2)

      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

      const result = await resultPromise
      expect(compute.kill).toHaveBeenCalledWith('SIGKILL')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/timed out after 10 minutes/)
    })
  })

  describe('cloud-first orchestration', () => {
    it('uses the cloud run and never spawns python when a token resolves and dispatch succeeds', async () => {
      resolveGithubTokenMock.mockResolvedValue('tok')
      runCloudMetricsJobMock.mockResolvedValue({
        ok: true,
        summaryLines: ['Metrics recomputed in the cloud (nightly-metrics run #42)'],
        durationMs: 1
      })

      const result = await metricsJob.runMetricsJob()

      expect(result.ok).toBe(true)
      expect(result.summaryLines[0]).toMatch(/cloud/)
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('reports a real cloud run failure without falling back locally', async () => {
      resolveGithubTokenMock.mockResolvedValue('tok')
      runCloudMetricsJobMock.mockResolvedValue({
        ok: false,
        summaryLines: [],
        durationMs: 1,
        error: 'cloud run #43 concluded: failure — https://github.com/x'
      })

      const result = await metricsJob.runMetricsJob()

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/concluded: failure/)
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('falls back to the local run (with a note) when cloud dispatch is unavailable', async () => {
      const { CloudDispatchUnavailable } = await import('../metricsCloud')
      resolveGithubTokenMock.mockResolvedValue('tok')
      runCloudMetricsJobMock.mockRejectedValue(new CloudDispatchUnavailable('GitHub unreachable'))
      const [probe, compute] = queueFakes(2)

      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()
      compute.stdout.emit('data', Buffer.from('computed_daily: 560 rows\n'))
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(result.summaryLines).toContain('computed_daily: 560 rows')
      expect(result.summaryLines.join('\n')).toMatch(/cloud dispatch unavailable .*GitHub unreachable.* ran locally/)
    })

    it('goes straight to the local run when no token resolves', async () => {
      resolveGithubTokenMock.mockResolvedValue(null)
      const [probe, compute] = queueFakes(2)

      const resultPromise = metricsJob.runMetricsJob()
      await flush()
      passProbe(probe)
      await flush()
      compute.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(runCloudMetricsJobMock).not.toHaveBeenCalled()
    })
  })
})
