import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// resolveGithubToken shells out to `gh auth token` via child_process.execFile.
const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...(args as [])),
  spawn: vi.fn()
}))

type FetchArgs = [string, RequestInit?]

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response
}

describe('metricsCloud', () => {
  let metricsCloud: typeof import('../metricsCloud')
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>()

  beforeEach(async () => {
    vi.resetModules()
    execFileMock.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.GITHUB_TOKEN
    metricsCloud = await import('../metricsCloud')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.GITHUB_TOKEN
  })

  describe('resolveGithubToken', () => {
    it('prefers GITHUB_TOKEN from the environment without shelling out', async () => {
      process.env.GITHUB_TOKEN = ' env-tok '
      await expect(metricsCloud.resolveGithubToken()).resolves.toBe('env-tok')
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('falls back to `gh auth token` when the env var is absent', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'gh-tok\n', ''))
      await expect(metricsCloud.resolveGithubToken()).resolves.toBe('gh-tok')
      expect(execFileMock).toHaveBeenCalledWith(
        'gh',
        ['auth', 'token'],
        expect.anything(),
        expect.any(Function)
      )
    })

    it('resolves null when gh is missing or errors', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('ENOENT'), '', ''))
      await expect(metricsCloud.resolveGithubToken()).resolves.toBeNull()
    })
  })

  describe('runCloudMetricsJob', () => {
    const run = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
      id: 7,
      run_number: 42,
      status: 'completed',
      conclusion: 'success',
      created_at: new Date().toISOString(),
      html_url: 'https://github.com/x/runs/7',
      ...over
    })

    it('dispatches, finds the run, and maps a successful conclusion', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(204)) // dispatch
        .mockResolvedValueOnce(jsonResponse(200, { workflow_runs: [run()] })) // find

      const result = await metricsCloud.runCloudMetricsJob('tok', Date.now())

      expect(result.ok).toBe(true)
      expect(result.summaryLines[0]).toMatch(/run #42/)
      expect(fetchMock.mock.calls[0][0]).toMatch(/dispatches$/)
      const dispatchInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(dispatchInit.method).toBe('POST')
      expect(JSON.parse(dispatchInit.body as string)).toEqual({ ref: 'main' })
    })

    it('polls an in-progress run to completion and reports a failed conclusion without throwing', async () => {
      vi.useFakeTimers()
      try {
        fetchMock
          .mockResolvedValueOnce(jsonResponse(204))
          .mockResolvedValueOnce(
            jsonResponse(200, { workflow_runs: [run({ status: 'in_progress', conclusion: null })] })
          )
          .mockResolvedValueOnce(jsonResponse(200, run({ conclusion: 'failure' })))

        const resultPromise = metricsCloud.runCloudMetricsJob('tok', Date.now())
        await vi.advanceTimersByTimeAsync(6000)
        const result = await resultPromise

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/concluded: failure/)
        expect(result.error).toMatch(/github\.com/)
      } finally {
        vi.useRealTimers()
      }
    })

    it('throws CloudDispatchUnavailable when the dispatch is rejected', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401))
      await expect(metricsCloud.runCloudMetricsJob('tok', Date.now())).rejects.toBeInstanceOf(
        metricsCloud.CloudDispatchUnavailable
      )
    })

    it('throws CloudDispatchUnavailable when GitHub is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
      await expect(metricsCloud.runCloudMetricsJob('tok', Date.now())).rejects.toBeInstanceOf(
        metricsCloud.CloudDispatchUnavailable
      )
    })
  })
})
