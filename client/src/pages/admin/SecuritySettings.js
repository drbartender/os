import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import ConfirmModal from '../../components/ConfirmModal';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';

// Passkey management (mobile-admin spec 2026-08-13 section 8 escape hatch).
// Revoke is the lost-phone kill switch: it deletes the credential AND bumps
// token_version, a global logout by design, this desktop session included.
export default function SecuritySettings() {
  const toast = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [creds, setCreds] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    api.get('/auth/webauthn/credentials')
      .then((r) => setCreds(r.data.credentials))
      .catch(() => setLoadError(true));
  }, []);

  const onRevoke = async () => {
    setRevoking(true);
    try {
      await api.delete(`/auth/webauthn/credentials/${pendingRevoke.id}`);
      toast.success('Passkey revoked. All sessions are signed out.');
      logout();
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(err?.message || 'Could not revoke the passkey.');
      setRevoking(false);
      setPendingRevoke(null);
    }
  };

  if (loadError) {
    return <div className="card" style={{ padding: '1.5rem' }}>Could not load passkeys. Try refreshing.</div>;
  }
  if (creds === null) {
    return <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div className="card" style={{ padding: '1.5rem', maxWidth: 560 }}>
      <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Passkeys</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Fingerprint unlock credentials for the phone app. Revoking one signs out every
        session everywhere (this one included), so the phone loses access to live data
        right away. It is not a remote wipe: a phone that is offline keeps what it already
        downloaded until its saved session expires, then clears it on the next open.
      </p>
      {creds.length === 0 ? (
        <p style={{ fontSize: '0.85rem' }}>
          No passkeys enrolled. On your phone, open More and choose Set up fingerprint unlock.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {creds.map((c) => (
            <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{c.label || 'Passkey'}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Added {new Date(c.created_at).toLocaleDateString()}
                  {c.last_used_at ? `, last used ${new Date(c.last_used_at).toLocaleDateString()}` : ', never used'}
                </div>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPendingRevoke(c)} disabled={revoking}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal
        isOpen={!!pendingRevoke}
        title="Revoke this passkey?"
        message="Revoking signs out every session, including this one. You will log back in with your password."
        onConfirm={onRevoke}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
