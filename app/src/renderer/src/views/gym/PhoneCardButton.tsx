import { useEffect, useState, type ReactElement } from 'react'
import { Check, Copy, Smartphone } from 'lucide-react'
import { toDataURL } from 'qrcode'
// Direct path, not the components barrel: the barrel pulls in the map
// components (leaflet touches `window` at import time) and would break the
// node-env source tests that import this tab.
import { ButtonSoft } from '../../components/ButtonSoft'
import '../GymView.css'

/**
 * "On your phone" pairing: renders the gymcard Edge Function's tokenized URL
 * as a QR code, scanned once and kept as a home-screen bookmark. It lives
 * with the templates it serves (Gym › Templates), not on the overview — the
 * card is a gym tool, and the Dashboard is not where template setup happens.
 *
 * The URL is a capability — anyone holding it can read the templates — so the
 * modal says so plainly instead of pretending it's a login. Renders nothing
 * when the environment carries no GYMCARD_TOKEN (feature not set up).
 */
export function PhoneCardButton(): ReactElement | null {
  const [url, setUrl] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.api.getGymCardUrl().then(setUrl, () => setUrl(null))
  }, [])

  useEffect(() => {
    if (!open || url == null) return
    void toDataURL(url, { margin: 1, width: 480 }).then(setQr, () => setQr(null))
  }, [open, url])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (url == null) return null

  return (
    <>
      <ButtonSoft onClick={() => setOpen(true)} title="Open the gym card on your phone">
        <Smartphone size={14} strokeWidth={1.75} />
        On your phone
      </ButtonSoft>
      {open && (
        <div className="gym-modal-overlay" onClick={() => setOpen(false)}>
          <div
            className="gym-modal gym-phone-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Open the gym card on your phone"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gym-modal-head">
              <h3 className="gym-modal-title">Gym card on your phone</h3>
              <button
                type="button"
                className="gym-modal-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="gym-modal-body gym-phone-body">
              {qr ? (
                <img className="gym-phone-qr" src={qr} alt="QR code for the gym card link" />
              ) : (
                <p className="gym-quicklog-hint">Generating code…</p>
              )}
              <ol className="gym-phone-steps">
                <li>Scan with your phone camera.</li>
                <li>In the browser, Share → Add to Home Screen.</li>
                <li>The card always shows the current templates — nothing to re-sync.</li>
              </ol>
              <p className="gym-phone-warning">
                The link contains a private key: anyone who has it can read your templates. Keep it
                off shared channels.
              </p>
              <button
                type="button"
                className="gym-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(url).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1600)
                  })
                }}
              >
                {copied ? <Check size={14} strokeWidth={1.8} /> : <Copy size={14} strokeWidth={1.6} />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
