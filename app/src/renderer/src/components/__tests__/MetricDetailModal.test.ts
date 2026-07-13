import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MetricDetailModal } from '../MetricDetailModal'

describe('MetricDetailModal', () => {
  it('labels both series for a combined CTL and ATL detail chart', () => {
    const markup = renderToStaticMarkup(
      createElement(MetricDetailModal, {
        config: {
          title: 'CTL / ATL · Training load',
          currentValueDisplay: '42.0',
          currentValueCaption: 'CTL · ATL 51.0',
          series: [{ date: '2026-07-12', label: '12 Jul', value: 42 }],
          secondarySeries: [{ date: '2026-07-12', label: '12 Jul', value: 51 }],
          seriesName: 'CTL',
          secondarySeriesName: 'ATL',
          domain: 'load'
        } as never,
        onClose: () => undefined
      })
    )

    expect(markup).toContain('metric-modal-series-key')
    expect(markup).toContain('>CTL<')
    expect(markup).toContain('>ATL<')
  })
})
