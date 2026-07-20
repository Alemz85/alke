import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sidebar = readFileSync(new URL('../Sidebar.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../Sidebar.css', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const builder = readFileSync(new URL('../../../../electron-builder.yml', import.meta.url), 'utf8')
const packageJson = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
) as { name: string; author: string }
const readme = readFileSync(new URL('../../../../../README.md', import.meta.url), 'utf8')

describe('Alke brand identity', () => {
  it('renders the lowercase Alke lockup with a decorative Three Flows mark', () => {
    expect(sidebar).toContain('<span className="sidebar-brand-wordmark">alke</span>')
    expect(sidebar).toContain('className="sidebar-brand-mark"')
    expect(sidebar).toContain('aria-hidden="true"')
    expect(sidebar).not.toContain('>Health</div>')
  })

  it('fits the lockup into the existing sidebar brand slot', () => {
    const brandRule = styles.match(/\.sidebar-brand\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(brandRule).toMatch(/display:\s*flex;/)
    expect(brandRule).toMatch(/align-items:\s*center;/)
    expect(brandRule).toMatch(/gap:\s*var\(--space-xs\);/)
    expect(styles).toMatch(/\.sidebar-brand-mark\s*\{[^}]*width:\s*22px;/s)
  })

  it('renames user-visible metadata while preserving internal identity', () => {
    expect(html).toContain('<title>Alke</title>')
    expect(builder).toContain('productName: Alke')
    expect(builder).toContain('appId: com.healthanalytics.app')
    expect(packageJson.name).toBe('health-analytics-app')
    expect(packageJson.author).toBe('Alke')
    expect(readme).toMatch(/^# Alke$/m)
    expect(readme).toContain('xattr -cr "Alke.app"')
    expect(readme).toContain('Support/health-analytics-app/.env')
  })
})
