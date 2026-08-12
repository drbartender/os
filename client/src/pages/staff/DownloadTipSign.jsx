import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../utils/api';
import './DownloadTipSign.css';

import SignLayout from './tipCard/SignLayout';
import { BizCardFront, BizCardBack } from './tipCard/BizCardLayout';
import { SIGN_SIZES, CARD_SIZE, DISPLAY_SIGN_SIZE } from './tipCard/sizes';
import { captureNode, downloadCanvasImage, downloadCanvasesPdf } from './tipCard/renderToFile';
import { buildTipCardMarks } from '../../utils/tipCardMarks';
import { buildDownloadFilename } from '../../utils/downloadFilename';

const IMAGE_FORMATS = [
  { key: 'jpg', label: 'JPG' },
  { key: 'png', label: 'PNG' },
  { key: 'pdf', label: 'PDF' },
];

export default function DownloadTipSign() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const signRefs = useRef({});
  const cardFrontRef = useRef(null);
  const cardBackRef = useRef(null);

  useEffect(() => {
    api.get('/me/tip-page')
      .then((r) => setData(r.data))
      .catch((e) => setLoadError(e?.message || 'Could not load your tip page.'));
  }, []);

  const marks = buildTipCardMarks(data?.methods);
  // Mirror the public endpoint's COALESCE(display_name, preferred_name). Using
  // preferred_name alone printed one name on the sign while the chooser page a
  // guest lands on showed another.
  const name = data?.display_name || data?.preferred_name || 'your bartender';
  // Filenames take the raw name, so a bartender with none set gets
  // "Tip Sign 5x7.jpg" rather than "Tip Sign 5x7 - your bartender.jpg".
  const filePart = data?.display_name || data?.preferred_name || '';

  const downloadSign = useCallback(async (size, format) => {
    setError('');
    setBusy(`${size}:${format}`);
    try {
      const S = SIGN_SIZES[size];
      const canvas = await captureNode(signRefs.current[size]);
      const filename = buildDownloadFilename(`Tip Sign ${S.fileLabel}`, filePart, format);
      if (format === 'pdf') {
        await downloadCanvasesPdf([canvas], filename, { inW: S.inW, inH: S.inH });
      } else {
        await downloadCanvasImage(canvas, filename, format);
      }
    } catch (err) {
      // Capture, don't swallow. Every real failure here is invisible otherwise:
      // a tainted canvas, an OOM at 300 DPI on a low-end phone, a jsPDF import
      // failure. The bartender sees a message; nobody learns the sign pipeline
      // is broken for a whole class of device.
      Sentry.captureException(err, { tags: { surface: 'download-tip-sign', size, format } });
      setError('Could not build that file. Try again, or pick another format.');
    } finally {
      setBusy('');
    }
  }, [filePart]);

  const downloadCards = useCallback(async () => {
    setError('');
    setBusy('card:pdf');
    try {
      const front = await captureNode(cardFrontRef.current);
      const back = await captureNode(cardBackRef.current);
      await downloadCanvasesPdf(
        [front, back],
        buildDownloadFilename('Tip Cards', filePart, 'pdf'),
        { inW: CARD_SIZE.inW, inH: CARD_SIZE.inH }
      );
    } catch (err) {
      Sentry.captureException(err, { tags: { surface: 'download-tip-sign', kind: 'card-pdf' } });
      setError('Could not build the card PDF. Try again.');
    } finally {
      setBusy('');
    }
  }, [filePart]);

  if (loadError) return <p className="dts-msg">{loadError}</p>;
  if (!data) return <p className="dts-msg">Loading…</p>;

  // Gate on `active`, not just on `url`. /me/tip-page derives url from token
  // presence alone, independent of tip_page_active, and /my-tip-page/print
  // still redirects here, so a bookmark would otherwise walk straight past the
  // portal's active gate and print a stack of QRs that resolve to a 404.
  if (!data.active || !data.url) {
    return <p className="dts-msg">Your tip page isn&rsquo;t active yet.</p>;
  }

  const anyBusy = busy !== '';

  return (
    <div className="dts-root drb">
      <div className="dts-panel">
        <h1>Download your sign</h1>
        <p className="dts-help">
          Take the 5 × 7 to any photo counter (Walmart, CVS, Walgreens) and
          print it like a photo. JPG is the safest bet at a kiosk.
        </p>

        <div className="dts-preview" aria-hidden="true">
          <div className="dts-preview-inner">
            <SignLayout size={DISPLAY_SIGN_SIZE} name={name} tipUrl={data.url} marks={marks} />
          </div>
        </div>

        <section className="dts-group">
          <h2>Bar sign</h2>
          {Object.entries(SIGN_SIZES).map(([size, S]) => (
            <div className="dts-row" key={size}>
              <span className="dts-row-label">{S.label}</span>
              <span className="dts-row-buttons">
                {IMAGE_FORMATS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className="dts-btn"
                    disabled={anyBusy}
                    aria-label={`Download the ${S.label} sign as ${f.label}`}
                    onClick={() => downloadSign(size, f.key)}
                  >
                    {busy === `${size}:${f.key}` ? '…' : f.label}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </section>

        <section className="dts-group">
          <h2>Hand-out cards</h2>
          <p className="dts-note">
            PDF only. A print shop wants a PDF, and a two-sided card cannot be
            one image. Front and back come down as pages 1 and 2.
          </p>
          <div className="dts-row">
            <span className="dts-row-label">3.5 × 2, 2-sided</span>
            <span className="dts-row-buttons">
              <button
                type="button"
                className="dts-btn"
                disabled={anyBusy}
                aria-label="Download the two-sided hand-out cards as PDF"
                onClick={downloadCards}
              >
                {busy === 'card:pdf' ? '…' : 'PDF'}
              </button>
            </span>
          </div>
        </section>

        <p className="dts-error" role="status" aria-live="polite">{error}</p>
      </div>

      {/* Capture surfaces. Off-screen rather than display:none, because
          html2canvas has to be able to measure a laid-out node. */}
      <div className="dts-capture" aria-hidden="true">
        {Object.keys(SIGN_SIZES).map((size) => (
          <div
            key={size}
            ref={(n) => { signRefs.current[size] = n; }}
            style={{ width: SIGN_SIZES[size].w, height: SIGN_SIZES[size].h }}
          >
            <SignLayout size={size} name={name} tipUrl={data.url} marks={marks} />
          </div>
        ))}
        <div ref={cardFrontRef} style={{ width: CARD_SIZE.w, height: CARD_SIZE.h }}>
          <BizCardFront name={name} tipUrl={data.url} marks={marks} />
        </div>
        <div ref={cardBackRef} style={{ width: CARD_SIZE.w, height: CARD_SIZE.h }}>
          <BizCardBack name={name} />
        </div>
      </div>
    </div>
  );
}
