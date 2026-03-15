import React, { useRef, useEffect } from 'react';

export default function SignaturePad({ onChange, value }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasSignature = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    resizeCanvas();

    // If value exists and canvas is empty, could restore — skip for simplicity
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, []);

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

  function stopDraw(e) {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    const data = canvas.toDataURL('image/png');
    onChange(data);
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasSignature.current = false;
    onChange('');
  }

  return (
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
          <button type="button" className="btn btn-secondary btn-sm" onClick={clear}>
            Clear
          </button>
        </div>
      </div>
      {!value && (
        <p className="form-helper">Sign above using your mouse or finger.</p>
      )}
      {value && (
        <p style={{ fontSize: '0.8rem', color: 'var(--success)', marginTop: '0.3rem' }}>✓ Signature captured</p>
      )}
    </div>
  );
}
