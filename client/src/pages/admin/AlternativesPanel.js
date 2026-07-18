import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import EntityLink from '../../components/EntityLink';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { proposalStatusMeta } from '../../utils/proposalStatusMap';
import SendModal, { describeSendResult } from '../../components/SendModal';

// Alternatives panel on ProposalDetail: manage this proposal's option group
// ("compare your options"). Extracted from ProposalDetail to keep that file
// under the size cap. The parent owns the group fetch (GET /proposals/:id/group)
// and passes it down; onChanged asks the parent to refetch group + proposal.

const GROUPABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified'];
const fmt$ = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AlternativesPanel({ proposalId, proposal, group, onChanged }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  if (!group || !proposal) return null; // group state still loading

  const members = group.members || [];
  const decided = !!group.decided;
  const sourceGroupable = GROUPABLE_STATUSES.includes(proposal.status) && !(Number(proposal.amount_paid) > 0);
  const canAdd = !decided && members.length < 3 && (group.grouped || sourceGroupable);
  const hasDraft = members.some((m) => m.status === 'draft');

  const apiError = (err, fallback) => err?.response?.data?.error
    || (typeof err?.response?.data === 'string' ? err.response.data : null)
    || err.message || fallback;

  const addAlternative = async () => {
    setBusy('add');
    try {
      const res = await api.post(`/proposals/${proposalId}/alternative`);
      toast.success('Alternative created. Swap its package and adjust as needed.');
      navigate(`/proposals/${res.data.new_proposal_id}?edit=1`);
    } catch (err) {
      toast.error(apiError(err, 'Could not add an alternative.'));
    } finally {
      setBusy('');
    }
  };

  const removeMember = async (m) => {
    const ok = window.confirm('Remove this option from the comparison? If only one option remains, the comparison is dissolved.');
    if (!ok) return;
    setBusy(`remove-${m.id}`);
    try {
      const res = await api.delete(`/proposals/${m.id}/group-membership`);
      toast.success(res.data.dissolved ? 'Comparison dissolved.' : 'Option removed.');
      onChanged();
    } catch (err) {
      toast.error(apiError(err, 'Could not remove this option.'));
    } finally {
      setBusy('');
    }
  };

  // Fires after the SendModal's confirm resolved (any per-channel outcome). A
  // Cancel never calls this, so the group only refetches on a real send. onChanged
  // re-reads the server (some members flip to 'sent'); the toast tells the truth.
  const handleSendComplete = (results) => {
    const { hadFailure, message } = describeSendResult(results);
    if (hadFailure) toast.error(message);
    else toast.success(message);
    onChanged();
  };

  const copyCompareLink = async () => {
    try {
      await navigator.clipboard.writeText(`${PUBLIC_SITE_URL}/compare/${group.group_token}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy the link.');
    }
  };

  // Solo proposal: offer the affordance only while it can still take alternatives.
  if (!group.grouped) {
    if (!canAdd) return null;
    return (
      <div className="card">
        <div className="card-head"><h3>Alternatives</h3></div>
        <div className="card-body">
          <div className="muted tiny" style={{ marginBottom: 10 }}>
            Give this client more than one option to compare side by side (say, BYOB next to hosted).
            Adding an alternative copies this proposal into a sibling option; swap its package after.
          </div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={addAlternative}>
            <Icon name="plus" size={12} />{busy === 'add' ? 'Adding…' : 'Add an alternative'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Alternatives</h3>
        <span className="k">{members.length} option{members.length === 1 ? '' : 's'}</span>
      </div>
      <div className="card-body">
        {decided && (
          <div className="muted tiny" style={{ marginBottom: 8 }}>
            The client booked one of these options. The others are archived.
          </div>
        )}
        <div className="vstack" style={{ gap: 6 }}>
          {members.map((m) => (
            <div key={m.id} className="hstack" style={{ gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {Number(m.id) === Number(proposalId) ? (
                  <strong>{m.package_name || 'No package yet'}</strong>
                ) : (
                  <EntityLink to={`/proposals/${m.id}`} className="btn btn-ghost btn-sm" style={{ padding: 0 }}>
                    {m.package_name || 'No package yet'}
                  </EntityLink>
                )}
                {Number(m.id) === Number(proposalId) && <span className="sub"> (this one)</span>}
              </div>
              <span className="num muted">{fmt$(m.total_price)}</span>
              <StatusChip kind={proposalStatusMeta(m.status).kind}>{m.status}</StatusChip>
              {!decided && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Remove this option"
                  disabled={!!busy}
                  onClick={() => removeMember(m)}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="hstack" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {canAdd && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={addAlternative}>
              <Icon name="plus" size={12} />{busy === 'add' ? 'Adding…' : 'Add an alternative'}
            </button>
          )}
          {hasDraft && !decided && (
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || sendOpen} onClick={() => setSendOpen(true)}>
              <Icon name="send" size={12} />Send options
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyCompareLink}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />{copied ? 'Copied' : 'Copy compare link'}
          </button>
        </div>
        {sendOpen && (
          <SendModal
            action="proposal_send_group"
            entityId={proposalId}
            title="Send Compare Link"
            confirmLabel="Send"
            onClose={() => setSendOpen(false)}
            onComplete={handleSendComplete}
          />
        )}
      </div>
    </div>
  );
}
