import React, { useRef, useEffect, useState } from 'react';

export default function SignaturePad({ onChange, value }) {
  const [mode, setMode] = useState('draw'); // 'draw' or 'type'
  const [typedName, setTypedName] = useState('');
  const [typeConsent, setTypeConsent] = useState(false);
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasSignature = useRef(false);

  useEffect(() => {
    if (mode !== 'draw') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    resizeCanvas();

    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, [mode]);

  function resizeCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = 140;
  }

  function getPos(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  }

  function startDraw(e) {
    e.preventDefault();
    drawing.current = true;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  }

  function draw(e) {
    e.preventDefault();
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1A1410';
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    hasSignature.current = true;
  }

  function stopDraw() {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    const data = canvas.toDataURL('image/png');
    onChange(data, 'draw');
  }

  function clearDraw() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasSignature.current = false;
    onChange('', null);
  }

  function switchMode(newMode) {
    if (newMode === mode) return;
    // Clear current signature when switching
    if (mode === 'draw' && canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      hasSignature.current = false;
    }
    setTypedName('');
    setTypeConsent(false);
    onChange('', null);
    setMode(newMode);
  }

  function handleTypedChange(name) {
    setTypedName(name);
    // Only emit value when consent is checked and name is non-empty
    if (typeConsent && name.trim()) {
      onChange(name.trim(), 'type');
    } else {
      onChange('', null);
    }
  }

  function handleConsentChange(checked) {
    setTypeConsent(checked);
    if (checked && typedName.trim()) {
      onChange(typedName.trim(), 'type');
    } else {
      onChange('', null);
    }
  }

  const isDrawCaptured = mode === 'draw' && value;
  const isTypeCaptured = mode === 'type' && value;

  return (
    <div>
      {/* Mode toggle */}
      <div className="sig-mode-toggle" role="tablist" aria-label="Signature method">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'draw'}
          className={`sig-mode-btn ${mode === 'draw' ? 'sig-mode-active' : ''}`}
          onClick={() => switchMode('draw')}
        >
          Draw Signature
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'type'}
          className={`sig-mode-btn ${mode === 'type' ? 'sig-mode-active' : ''}`}
          onClick={() => switchMode('type')}
        >
          Type Name
        </button>
      </div>

      {mode === 'draw' ? (
        <div>
          <div className="signature-container">
            <canvas
              ref={canvasRef}
              style={{ cursor: 'crosshair', display: 'block', background: 'white' }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={stopDraw}
            />
            <div className="signature-controls">
              <button type="button" className="btn btn-secondary btn-sm" onClick={clearDraw}>
                Clear
              </button>
            </div>
          </div>
          {!isDrawCaptured && (
            <p className="form-helper">Sign above using your mouse or finger.</p>
          )}
          {isDrawCaptured && (
            <p style={{ fontSize: '0.8rem', color: 'var(--success)', marginTop: '0.3rem' }}>✓ Signature captured</p>
          )}
        </div>
      ) : (
        <div>
          <div className="sig-type-container">
            <input
              type="text"
              className="form-input sig-type-input"
              value={typedName}
              onChange={e => handleTypedChange(e.target.value)}
              placeholder="Type your full legal name"
            />
            {typedName.trim() && (
              <div className="sig-type-preview">
                <span className="sig-type-rendered">{typedName}</span>
              </div>
            )}
          </div>
          <label className="checkbox-group sig-consent-row">
            <input
              type="checkbox"
              checked={typeConsent}
              onChange={e => handleConsentChange(e.target.checked)}
            />
            <span className="checkbox-label sig-consent-text">
              By typing my name, I agree this is my electronic signature.
            </span>
          </label>
          {isTypeCaptured && (
            <p style={{ fontSize: '0.8rem', color: 'var(--success)', marginTop: '0.3rem' }}>✓ Signature captured</p>
          )}
        </div>
      )}
    </div>
  );
}
