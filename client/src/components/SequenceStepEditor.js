import React, { useState } from 'react';
import RichTextEditor from './RichTextEditor';

export default function SequenceStepEditor({ step, onSave, onCancel, onUploadImage }) {
  const [subject, setSubject] = useState(step?.subject || '');
  const [htmlBody, setHtmlBody] = useState(step?.html_body || '');
  const [delayDays, setDelayDays] = useState(step?.delay_days ?? 1);
  const [delayHours, setDelayHours] = useState(step?.delay_hours ?? 0);

  const handleSave = () => {
    if (!subject.trim() || !htmlBody.trim()) return;
    onSave({
      subject: subject.trim(),
      html_body: htmlBody,
      delay_days: delayDays,
      delay_hours: delayHours,
    });
  };

  return (
    <div className="em-step-editor">
      <div className="em-step-delay">
        <label className="form-label">Send after:</label>
        <div className="em-delay-inputs">
          <input
            type="number"
            min="0"
            value={delayDays}
            onChange={e => setDelayDays(parseInt(e.target.value, 10) || 0)}
            className="form-input em-delay-input"
          />
          <span>days</span>
          <input
            type="number"
            min="0"
            max="23"
            value={delayHours}
            onChange={e => setDelayHours(parseInt(e.target.value, 10) || 0)}
            className="form-input em-delay-input"
          />
          <span>hours</span>
          <span className="em-delay-note">after previous step</span>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Subject Line</label>
        <input
          type="text"
          className="form-input"
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="Email subject..."
        />
      </div>

      <div className="form-group">
        <label className="form-label">Email Body</label>
        <RichTextEditor
          content={htmlBody}
          onChange={setHtmlBody}
          onUploadImage={onUploadImage || (() => Promise.resolve(null))}
          placeholder="Write your email content..."
        />
      </div>

      <div className="em-step-actions">
        <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={!subject.trim() || !htmlBody.trim()}>
          {step ? 'Update Step' : 'Add Step'}
        </button>
      </div>
    </div>
  );
}
