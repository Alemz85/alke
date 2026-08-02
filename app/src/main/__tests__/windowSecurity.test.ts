import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('BrowserWindow security contract', () => {
  it('keeps renderer privileges behind the isolated preload bridge', () => {
    expect(source).toContain('contextIsolation: true')
    expect(source).toContain('nodeIntegration: false')
  })

  it('blocks same-window navigation and only hands http(s) links to the OS', () => {
    expect(source).toContain("webContents.on('will-navigate'")
    expect(source).toContain('event.preventDefault()')
    expect(source).toContain('openExternalHttp(details.url)')
    expect(source).toContain('openExternalHttp(url)')
  })

  it('denies renderer permission requests by default', () => {
    expect(source).toContain('setPermissionRequestHandler')
    expect(source).toContain('callback(false)')
  })
})
