import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// metricsJob.ts reads `app.isPackaged` at module load for its cwd resolution
// and imports `electron`'s `app` — stub it so the module loads outside a real
// Electron process. Kept minimal: only what metricsJob.ts touches.
vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

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

describe('metricsJob', () => {
  let metricsJob: typeof import('../metricsJob')

  beforeEach(async () => {
    vi.resetModules()
    spawnMock.mockReset()
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

  describe('runMetricsJob', () => {
    it('resolves ok:true with the tailed stdout summary on a clean exit', async () => {
      const fake = new FakeChildProcess()
      spawnMock.mockReturnValue(fake)

      const resultPromise = metricsJob.runMetricsJob()
      fake.stdout.emit('data', Buffer.from('computed_zone2_fitness: 2283 rows\n'))
      fake.emit('close', 0)

      const result = await resultPromise
      expect(result.ok).toBe(true)
      expect(result.summaryLines).toEqual(['computed_zone2_fitness: 2283 rows'])
      expect(result.error).toBeUndefined()
      expect(typeof result.durationMs).toBe('number')
    })

    it('resolves ok:false with a stderr-derived error on non-zero exit', async () => {
      const fake = new FakeChildProcess()
      spawnMock.mockReturnValue(fake)

      const resultPromise = metricsJob.runMetricsJob()
      fake.stderr.emit('data', Buffer.from('boom\n'))
      fake.emit('close', 1)

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toBe('boom')
    })

    it('resolves ok:false when spawn itself fails (ENOENT)', async () => {
      const fake = new FakeChildProcess()
      spawnMock.mockReturnValue(fake)

      const resultPromise = metricsJob.runMetricsJob()
      fake.emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }))

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/python3 not found on PATH/)
    })

    it('rejects a concurrent invocation with an "already running" error instead of spawning twice', async () => {
      const fake = new FakeChildProcess()
      spawnMock.mockReturnValue(fake)

      const first = metricsJob.runMetricsJob()
      const second = await metricsJob.runMetricsJob()

      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/already running/)

      fake.emit('close', 0)
      await first
    })

    it('allows a new run once the previous one has settled', async () => {
      const fakeOne = new FakeChildProcess()
      spawnMock.mockReturnValueOnce(fakeOne)

      const first = metricsJob.runMetricsJob()
      fakeOne.emit('close', 0)
      await first

      const fakeTwo = new FakeChildProcess()
      spawnMock.mockReturnValueOnce(fakeTwo)
      const second = metricsJob.runMetricsJob()
      fakeTwo.emit('close', 0)
      const result = await second

      expect(spawnMock).toHaveBeenCalledTimes(2)
      expect(result.ok).toBe(true)
    })

    it('kills the child and reports a timeout after 10 minutes', async () => {
      vi.useFakeTimers()
      const fake = new FakeChildProcess()
      spawnMock.mockReturnValue(fake)

      const resultPromise = metricsJob.runMetricsJob()
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

      const result = await resultPromise
      expect(fake.kill).toHaveBeenCalledWith('SIGKILL')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/timed out after 10 minutes/)
    })
  })
})
