import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmt$ } from '../../../../components/adminos/format';
import FormBanner from '../../../../components/FormBanner';
import FieldError from '../../../../components/FieldError';
import { rateOf, PAYMENT_METHODS } from '../helpers';

export default function PayoutsTab(props) {
  const {
    profile, payment, seniority, seniorityLoading,
    seniorityForm, setSeniorityForm, saveSeniority, senioritySaving, seniorityError, seniorityFieldErrors,
    editing, editForm, setEditForm, startEditing, cancelEditing, saveProfile, saving, profileError, profileFieldErrors,
  } = props;
  const currentRate = rateOf(profile);

  const updateField = (k, v) => setEditForm(f => ({ ...f, [k]: v }));
  const w9 = !!payment?.w9_file_url;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {/* Pay periods placeholder */}
        <div className="card">
          <div className="card-head">
            <h3>Pay periods</h3>
            <button type="button" className="btn btn-secondary btn-sm" disabled>
              <Icon name="dollar" size={11} />Run payout
            </button>
          </div>
          <div className="card-body muted tiny">
            Pay-period tracking isn't wired up yet. Once you add a payouts table this card will show period rows with shifts / hours / wages / tips / total / status.
          </div>
        </div>

        {/* 1099 / tax — derived from current data */}
        <div className="card">
          <div className="card-head"><h3>1099 / tax</h3></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Classification</dt><dd>1099 Independent Contractor</dd>
              <dt>W-9 on file</dt>
              <dd>{w9 ? <StatusChip kind="ok">Submitted</StatusChip> : <StatusChip kind="danger">Missing</StatusChip>}</dd>
              <dt>YTD earnings</dt><dd className="num muted">Tracking pending</dd>
              <dt>1099 threshold</dt><dd className="num muted">$600</dd>
            </dl>
          </div>
        </div>

        {/* Seniority */}
        <div className="card">
          <div className="card-head"><h3>Seniority</h3></div>
          <div className="card-body">
            {seniorityLoading || !seniority ? (
              <div className="muted tiny">Loading seniority…</div>
            ) : (
              <>
                <div className="stat-row" style={{ marginBottom: 12 }}>
                  <div className="stat">
                    <div className="stat-label">Score</div>
                    <div className="stat-value">{seniority.computed_score ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Events worked</div>
                    <div className="stat-value">{seniority.events_worked ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Months tenure</div>
                    <div className="stat-value">{seniority.tenure_months ?? 0}</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Hire date</div>
                    <input
                      className="input"
                      type="date"
                      value={seniorityForm.hire_date}
                      onChange={(e) => setSeniorityForm(f => ({ ...f, hire_date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Manual adjustment</div>
                    <input
                      className="input num"
                      type="number"
                      value={seniorityForm.seniority_adjustment}
                      onChange={(e) => setSeniorityForm(f => ({ ...f, seniority_adjustment: e.target.value }))}
                    />
                    <div className="tiny muted" style={{ marginTop: 3 }}>+ to boost · − to reduce</div>
                  </div>
                </div>
                <FormBanner error={seniorityError} fieldErrors={seniorityFieldErrors} />
                <div className="hstack" style={{ marginTop: 12, gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={senioritySaving} onClick={saveSeniority}>
                    {senioritySaving ? 'Saving…' : 'Save seniority'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Compensation</h3>
            {editing ? (
              <div className="hstack" style={{ gap: 4 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={cancelEditing}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveProfile}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={startEditing}>
                <Icon name="pen" size={11} />Edit
              </button>
            )}
          </div>
          <div className="card-body">
            {editing ? (
              <div className="vstack" style={{ gap: 10 }}>
                <FormBanner error={profileError} fieldErrors={profileFieldErrors} />
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Hourly rate</div>
                  <div className="input-group" style={{ padding: '0 10px' }}>
                    <span className="tiny" style={{ color: 'var(--ink-3)' }}>$</span>
                    <input
                      className="num"
                      type="number"
                      min="0"
                      max="1000"
                      step="0.5"
                      value={editForm.hourly_rate}
                      onChange={(e) => updateField('hourly_rate', e.target.value)}
                      style={{ flex: 1, textAlign: 'right' }}
                    />
                    <span className="tiny" style={{ color: 'var(--ink-3)' }}>/hr</span>
                  </div>
                  <FieldError error={profileFieldErrors?.hourly_rate} />
                  <div className="tiny muted" style={{ marginTop: 3 }}>Defaults to $20/hr for new contractors.</div>
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Payout method</div>
                  <select className="select" value={editForm.preferred_payment_method} onChange={(e) => updateField('preferred_payment_method', e.target.value)}>
                    <option value="">—</option>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Username / handle</div>
                  <input className="input" value={editForm.payment_username} onChange={(e) => updateField('payment_username', e.target.value)} />
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Routing number</div>
                  <input className="input" value={editForm.routing_number} onChange={(e) => updateField('routing_number', e.target.value)} />
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Account number</div>
                  <input className="input" value={editForm.account_number} onChange={(e) => updateField('account_number', e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="vstack" style={{ gap: 10 }}>
                <dl className="dl">
                  <dt>Hourly rate</dt>
                  <dd className="num"><strong>{fmt$(currentRate)}</strong>/hr</dd>
                  <dt>Tip share</dt>
                  <dd className="muted">Pooled · 1.0×</dd>
                </dl>
                {payment?.preferred_payment_method ? (
                  <div className="hstack" style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}>
                    <Icon name="dollar" size={14} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: 12.5 }}>{payment.preferred_payment_method}</strong>
                      <div className="tiny muted">{payment.payment_username || (payment.account_number ? `Account ··· ${String(payment.account_number).slice(-4)}` : 'Not configured')}</div>
                    </div>
                  </div>
                ) : (
                  <div className="hstack">
                    <StatusChip kind="warn">Payout method not configured</StatusChip>
                  </div>
                )}
                <dl className="dl">
                  <dt>W-9</dt>
                  <dd>{w9 ? <StatusChip kind="ok">On file</StatusChip> : <StatusChip kind="danger">Missing</StatusChip>}</dd>
                </dl>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>YTD totals</h3></div>
          <div className="card-body">
            <div className="muted tiny">
              YTD earnings tracking will plug in here once payout records exist. For now, see Shifts tab for a count.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
