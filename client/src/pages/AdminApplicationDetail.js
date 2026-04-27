import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { formatPhone } from '../utils/formatPhone';
import { useToast } from '../context/ToastContext';

// ─── Shared Helpers ───────────────────────────────────────────────

const STATUS_MAP = {
  applied:      ['badge-submitted',   'Applied'],
  interviewing: ['badge-inprogress',  'Interviewing'],
  hired:        ['badge-approved',    'Hired'],
  rejected:     ['badge-deactivated', 'Archived'],
  in_progress:  ['badge-inprogress',  'In Progress'],
  submitted:    ['badge-submitted',   'Submitted'],
  reviewed:     ['badge-reviewed',    'Reviewed'],
  approved:     ['badge-approved',    'Approved'],
  deactivated:  ['badge-deactivated', 'Deactivated'],
};

function StatusBadge({ status }) {
  const [cls, label] = STATUS_MAP[status] || ['badge-inprogress', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function FieldLabel({ children }) {
  return (
    <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.2rem' }}>
      {children}
    </div>
  );
}

function Field({ label, value, long }) {
  return (
    <div style={{ marginBottom: long ? '1rem' : '0.7rem' }}>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ fontSize: '0.9rem', color: 'var(--deep-brown)', lineHeight: long ? 1.65 : 1.4, whiteSpace: long ? 'pre-wrap' : undefined }}>
        {value || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not provided</span>}
      </div>
    </div>
  );
}

function SectionCard({ title, children, style }) {
  return (
    <div className="card" style={style}>
      <h3 style={{ marginBottom: '1.1rem', color: 'var(--deep-brown)', borderBottom: '1px solid var(--border)', paddingBottom: '0.6rem', fontSize: '1rem', letterSpacing: '0.03em' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

// Zone 2: quick-glance stat
function QuickStat({ label, value, boolVal }) {
  const isYes = boolVal === true  || value === 'yes' || value === 'Yes';
  const isNo  = boolVal === false || value === 'no'  || value === 'No';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <FieldLabel>{label}</FieldLabel>
      {isYes ? (
        <span style={{ display: 'inline-block', background: '#E8F5E8', color: '#1A6B1A', border: '1px solid #90CC90', borderRadius: '99px', padding: '0.2rem 0.7rem', fontSize: '0.8rem', fontWeight: 700, width: 'fit-content' }}>Yes</span>
      ) : isNo ? (
        <span style={{ display: 'inline-block', background: '#F5F5F5', color: '#666', border: '1px solid #CCC', borderRadius: '99px', padding: '0.2rem 0.7rem', fontSize: '0.8rem', fontWeight: 700, width: 'fit-content' }}>No</span>
      ) : (
        <div style={{ fontSize: '0.9rem', color: 'var(--deep-brown)', fontWeight: 600 }}>{value || '—'}</div>
      )}
    </div>
  );
}

// Avatar — headshot or initials fallback
function Avatar({ name, imgUrl, size = 52 }) {
  const [imgFailed, setImgFailed] = useState(false);
  const initials = (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '2px solid rgba(212,149,74,0.6)', flexShrink: 0, overflow: 'hidden',
      fontFamily: 'var(--font-display)', fontSize: size * 0.33, color: 'white', fontWeight: 700,
      letterSpacing: '0.05em',
    }}>
      {imgUrl && !imgFailed
        ? <img src={`/api${imgUrl}`} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgFailed(true)} />
        : initials}
    </div>
  );
}

// Zone 5: file thumbnail tile
function FileTile({ label, url, filename, onDownload }) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext);
  const [imgFailed, setImgFailed] = useState(false);
  const [hovered, setHovered] = useState(false);

  const extBadge = {
    display: 'inline-block', padding: '0.15rem 0.45rem', borderRadius: '99px',
    fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    ...(ext === 'pdf'
      ? { background: '#E8F4FF', color: '#1A5C9E', border: '1px solid #A0C8F0' }
      : { background: '#FFF3DC', color: '#8B5E0A', border: '1px solid #E5C97A' }),
  };

  return (
    <div
      onClick={() => onDownload(url, filename)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: 'pointer', borderRadius: 'var(--radius)',
        border: `2px solid ${hovered ? 'var(--amber)' : 'var(--border)'}`,
        overflow: 'hidden', background: 'var(--parchment)', width: 160, flexShrink: 0,
        boxShadow: hovered ? '0 4px 16px rgba(193,125,60,0.2)' : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      <div style={{ height: 110, background: '#ddd6c8', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {isImage && !imgFailed
          ? <img src={`/api${url}`} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgFailed(true)} />
          : <div style={{ textAlign: 'center' }}><span style={{ fontSize: '2.5rem' }}>{ext === 'pdf' ? '📑' : '📄'}</span></div>
        }
      </div>
      <div style={{ padding: '0.5rem 0.65rem' }}>
        <FieldLabel>{label}</FieldLabel>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.25rem', marginTop: '0.2rem' }}>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{filename}</span>
          <span style={extBadge}>{ext.toUpperCase()}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────

export default function AdminApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [customMessage, setCustomMessage] = useState('');

  useEffect(() => {
    api.get(`/admin/applications/${id}`)
      .then(r => setData(r.data))
      .catch(() => toast.error('Failed to load application. Try refreshing.'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function updateStatus(newStatus, message) {
    setConfirmAction(null);
    setCustomMessage('');
    setStatusLoading(true);
    try {
      const payload = { status: newStatus };
      const trimmed = (message || '').trim();
      if (trimmed) payload.customMessage = trimmed;
      await api.put(`/admin/users/${id}/status`, payload);
      // Refetch to get fresh data + auto-logged status change note
      const fresh = await api.get(`/admin/applications/${id}`);
      setData(fresh.data);
      const successMsg = newStatus === 'hired'
        ? 'Application approved.'
        : newStatus === 'rejected'
          ? 'Application rejected.'
          : `Status changed to ${(STATUS_MAP[newStatus] && STATUS_MAP[newStatus][1]) || newStatus}.`;
      toast.success(successMsg);
    } catch (e) {
      toast.error(e.message || 'Failed to update status.');
    } finally {
      setStatusLoading(false);
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setNoteLoading(true);
    try {
      const r = await api.post(`/admin/applications/${id}/notes`, { note: noteText });
      setData(d => ({ ...d, notes: r.data }));
      setNoteText('');
      toast.success('Note added.');
    } catch (e) {
      toast.error(e.message || 'Failed to add note.');
    } finally {
      setNoteLoading(false);
    }
  }

  async function deleteNote(noteId) {
    try {
      await api.delete(`/admin/notes/${noteId}`);
      setData(d => ({ ...d, notes: d.notes.filter(n => n.id !== noteId) }));
      toast.success('Note deleted.');
    } catch (e) {
      toast.error(e.message || 'Failed to delete note.');
    }
  }

  async function downloadFile(url) {
    try {
      const response = await api.get(url);
      window.open(response.data.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e.message || 'Could not open file.');
    }
  }

  if (loading) return <div className="loading"><div className="spinner" />Loading application...</div>;
  if (!data) return <div className="page-container"><div className="alert alert-error">Application not found.</div></div>;

  const { user, application: app, notes } = data;
  const status = user.onboarding_status;

  let positions = [];
  try { positions = JSON.parse(app.positions_interested || '[]'); } catch (e) { positions = []; }

  let expTypes = [];
  try { expTypes = JSON.parse(app.experience_types || '[]'); } catch (e) { expTypes = []; }

  const BAR_TOOLS = [
    ['tools_none_will_start', 'Will Start Kit'],
    ['tools_mixing_tins', 'Mixing Tins'],
    ['tools_strainer', 'Strainer'],
    ['tools_ice_scoop', 'Ice Scoop'],
    ['tools_bar_spoon', 'Bar Spoon'],
    ['tools_tongs', 'Tongs'],
    ['tools_ice_bin', 'Ice Bin'],
    ['tools_bar_mats', 'Bar Mats'],
    ['tools_bar_towels', 'Bar Towels'],
  ];

  const EQUIPMENT = [
    ['equipment_portable_bar', 'Portable Bar'],
    ['equipment_cooler', 'Cooler'],
    ['equipment_table_with_spandex', '6ft Table w/ Spandex'],
    ['equipment_none_but_open', 'Open to Getting Equipment'],
    ['equipment_no_space', 'No Storage Space'],
  ];

  const dobStr = app.birth_month && app.birth_day && app.birth_year
    ? `${app.birth_month}/${app.birth_day}/${app.birth_year}` : null;

  const addrStr = [app.street_address, app.city, app.state, app.zip_code].filter(Boolean).join(', ');
  const hasFiles = app.resume_file_url || app.basset_file_url || app.headshot_file_url;

  // Show notes oldest-first for timeline readability
  const chronologicalNotes = [...notes].reverse();

  const fmtDate = iso => new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  return (
    <>
      <div style={{ padding: '1rem 1.5rem 0' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/staffing')}>← Staff</button>
      </div>

      {/* ══ ZONE 1 — Profile Header Bar (sticky) ══ */}
      <div style={{
        background: 'rgba(26,20,16,0.97)',
        borderBottom: '1px solid rgba(193,125,60,0.35)',
        padding: '0.75rem 1.5rem',
        position: 'sticky', top: 74, zIndex: 90,
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>

          {/* Left: Avatar + Identity + Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <Avatar name={app.full_name} imgUrl={app.headshot_file_url} size={46} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--cream-text)' }}>
                  {app.full_name}
                </span>
                <StatusBadge status={status} />
              </div>
              <div style={{ fontSize: '0.76rem', color: 'var(--parchment)', opacity: 0.75, marginTop: '0.1rem' }}>
                Applied {new Date(app.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {app.city && <> · {app.city}, {app.state}</>}
              </div>
            </div>
          </div>

          {/* Right: Action Buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {status === 'applied' && (
              <button className="btn btn-secondary btn-sm" disabled={statusLoading}
                onClick={() => updateStatus('interviewing')}>
                📋 Move to Interview
              </button>
            )}
            {status === 'interviewing' && (
              <button className="btn btn-secondary btn-sm" disabled={statusLoading}
                onClick={() => updateStatus('applied')}>
                ← Back to Applied
              </button>
            )}
            {status !== 'hired' && status !== 'approved' && (
              <button className="btn btn-success btn-sm" disabled={statusLoading}
                onClick={() => setConfirmAction({ status: 'hired', label: 'Hire this applicant?', description: `This will mark ${app.full_name} as hired and allow them to begin onboarding.` })}>
                ✓ Hire
              </button>
            )}
            {status !== 'rejected' && status !== 'hired' && status !== 'approved' && (
              <button className="btn btn-danger btn-sm" disabled={statusLoading}
                onClick={() => setConfirmAction({ status: 'rejected', label: 'Reject & Archive this applicant?', description: `This will archive ${app.full_name}'s application and remove their portal access. You can restore them to Applied at any time.` })}>
                Reject
              </button>
            )}
            {status === 'rejected' && (
              <button className="btn btn-secondary btn-sm" disabled={statusLoading}
                onClick={() => updateStatus('applied')}>
                Restore to Applied
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="page-container wide">

        {/* ══ ZONE 2 — Quick-Glance Card ══ */}
        <div className="card" style={{ marginTop: '1.5rem', background: 'linear-gradient(135deg, var(--card-bg) 0%, #FFF8F0 100%)', borderColor: 'var(--amber)' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: '1rem' }}>
            ⚡ Quick Glance — Hiring Viability
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '1.25rem 1.5rem' }}>
            <QuickStat label="Position Applied For" value={positions.length > 0 ? positions.join(', ') : '—'} />
            <QuickStat label="Location & Travel"    value={[app.city && `${app.city}, ${app.state}`, app.travel_distance].filter(Boolean).join(' · ') || '—'} />
            <QuickStat label="Transportation"       value={app.reliable_transportation}
              boolVal={app.reliable_transportation?.toLowerCase() === 'yes' ? true : app.reliable_transportation?.toLowerCase() === 'no' ? false : undefined} />
            <QuickStat label="Bar Experience"
              value={!app.has_bartending_experience ? 'No' : (app.bartending_years || 'Yes')}
              boolVal={!app.has_bartending_experience ? false : (app.bartending_years ? undefined : true)} />
            <QuickStat label="Last Bartended"
              value={app.has_bartending_experience ? (app.last_bartending_time || '—') : 'N/A'} />
            <QuickStat label="Setup Confidence"     value={app.setup_confidence ? `${app.setup_confidence} / 5` : '—'} />
            <QuickStat label="Works Alone"          value={app.comfortable_working_alone}
              boolVal={app.comfortable_working_alone?.toLowerCase() === 'yes' ? true : app.comfortable_working_alone?.toLowerCase() === 'no' ? false : undefined} />
          </div>
        </div>

        {/* ══ ZONE 3 — About Section (2 columns) ══ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <SectionCard title="Contact & Identity">
            <Field label="Full Name" value={app.full_name} />
            <Field label="Email" value={user.email} />
            <Field label="Phone" value={formatPhone(app.phone)} />
            <Field label="Address" value={addrStr} />
            <Field label="Date of Birth" value={dobStr} />
            {app.favorite_color && <Field label="Favorite Color" value={app.favorite_color} />}

            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <FieldLabel>Emergency Contact</FieldLabel>
              {app.emergency_contact_name ? (
                <div style={{ marginTop: '0.2rem' }}>
                  <div style={{ fontSize: '0.9rem', color: 'var(--deep-brown)', fontWeight: 600 }}>{app.emergency_contact_name}</div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    {[app.emergency_contact_relationship, app.emergency_contact_phone ? formatPhone(app.emergency_contact_phone) : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ) : <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Not provided</span>}
            </div>
          </SectionCard>

          <SectionCard title="In Their Own Words">
            <Field label="Why Dr. Bartender?" value={app.why_dr_bartender} long />
            <Field label="Customer Service Approach" value={app.customer_service_approach} long />
            {app.additional_info && <Field label="Additional Info" value={app.additional_info} long />}

            {app.has_bartending_experience && (
              <div style={{ marginTop: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                <FieldLabel>Experience Background</FieldLabel>
                <div style={{ marginTop: '0.4rem' }}>
                  <Field label="Last Worked" value={app.last_bartending_time} />
                  {app.bartending_experience_description && (
                    <Field label="Description" value={app.bartending_experience_description} long />
                  )}
                  {expTypes.length > 0 && (
                    <div>
                      <FieldLabel>Experience Types</FieldLabel>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.35rem' }}>
                        {expTypes.map(t => <span key={t} className="badge badge-inprogress">{t}</span>)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </SectionCard>
        </div>

        {/* ══ ZONE 4 — Skills & Equipment (2 columns) ══ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <SectionCard title="Tools & Equipment">
            <div style={{ marginBottom: '1rem' }}>
              <FieldLabel>Bar Tools Owned</FieldLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.4rem' }}>
                {BAR_TOOLS.filter(([key]) => app[key]).map(([key, label]) => (
                  <span key={key} className="badge badge-inprogress">{label}</span>
                ))}
                {BAR_TOOLS.every(([key]) => !app[key]) && (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>None listed</span>
                )}
              </div>
            </div>
            <div>
              <FieldLabel>Equipment</FieldLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.4rem' }}>
                {EQUIPMENT.filter(([key]) => app[key]).map(([key, label]) => (
                  <span key={key} className="badge badge-inprogress">{label}</span>
                ))}
                {EQUIPMENT.every(([key]) => !app[key]) && (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>None listed</span>
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Roles & Availability">
            <div style={{ marginBottom: '1rem' }}>
              <FieldLabel>Positions Interested In</FieldLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.4rem' }}>
                {positions.length > 0
                  ? positions.map(p => <span key={p} className="badge badge-approved">{p}</span>)
                  : <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Not specified</span>}
              </div>
            </div>
            <Field label="Available Saturdays" value={app.available_saturdays} />
            <Field label="Other Commitments" value={app.other_commitments} />
          </SectionCard>
        </div>

        {/* ══ ZONE 5 — Uploaded Files ══ */}
        {hasFiles && (
          <SectionCard title="Uploaded Files">
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              {app.resume_file_url && (
                <FileTile label="Resume" url={app.resume_file_url} filename={app.resume_filename} onDownload={downloadFile} />
              )}
              {app.basset_file_url && (
                <FileTile label="BASSET Cert" url={app.basset_file_url} filename={app.basset_filename} onDownload={downloadFile} />
              )}
              {app.headshot_file_url && (
                <FileTile label="Headshot" url={app.headshot_file_url} filename={app.headshot_filename} onDownload={downloadFile} />
              )}
            </div>
          </SectionCard>
        )}

        {/* ══ ZONE 6 — Interview Notes & Stage Log ══ */}
        <SectionCard title="Interview Notes & Activity Log">

          {/* Add note */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', alignItems: 'flex-end' }}>
            <textarea
              className="form-input" rows={2}
              style={{ marginBottom: 0, flex: 1, resize: 'vertical' }}
              placeholder="Add an interview note..."
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" style={{ flexShrink: 0, alignSelf: 'flex-end' }}
              disabled={noteLoading || !noteText.trim()} onClick={addNote}>
              {noteLoading ? '…' : 'Add Note'}
            </button>
          </div>

          {/* Timeline — chronological, oldest first */}
          {notes.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.9rem' }}>No notes yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {chronologicalNotes.map(note => {
                const isChange = note.note_type === 'status_change';

                if (isChange) {
                  return (
                    <div key={note.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0.5rem' }}>
                      <div style={{
                        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                        background: 'var(--parchment)', border: '2px solid var(--border)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.75rem', color: 'var(--warm-brown)',
                      }}>↔</div>
                      <div>
                        <span style={{ fontSize: '0.85rem', color: 'var(--warm-brown)', fontWeight: 700 }}>
                          {note.note}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.6rem' }}>
                          {note.admin_email} · {fmtDate(note.created_at)}
                        </span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={note.id} style={{
                    padding: '0.85rem 1rem', background: 'var(--parchment)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  }}>
                    <div style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap', color: 'var(--deep-brown)', lineHeight: 1.6 }}>
                      {note.note}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.45rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>{note.admin_email}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        {fmtDate(note.created_at)}
                        <button
                          style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', fontSize: '0.75rem', opacity: 0.65, transition: 'opacity 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '0.65'}
                          onClick={() => deleteNote(note.id)}
                        >Delete</button>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

      </div>

      {/* ── Confirmation Modal ── */}
      {confirmAction && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div className="card" style={{ maxWidth: 480, width: '100%', margin: 0 }}>
            <h3 style={{ marginBottom: '0.5rem' }}>{confirmAction.label}</h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>{confirmAction.description}</p>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
              Personal note (optional — included in the email to {app.full_name})
            </label>
            <textarea
              className="form-input"
              rows={3}
              value={customMessage}
              onChange={e => setCustomMessage(e.target.value)}
              placeholder="e.g. We were impressed by your experience with cocktail menus — looking forward to chatting."
              style={{ marginBottom: '1.5rem', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setConfirmAction(null); setCustomMessage(''); }}>Cancel</button>
              <button
                className={`btn ${confirmAction.status === 'rejected' ? 'btn-danger' : 'btn-success'}`}
                onClick={() => updateStatus(confirmAction.status, customMessage)}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
