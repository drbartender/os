import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import api from '../../utils/api';
import PricingBreakdown from '../../components/PricingBreakdown';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import LocationInput from '../../components/LocationInput';
import DrinkPlanSelections from '../../components/DrinkPlanSelections';
import { formatPhone } from '../../utils/formatPhone';

const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', modified: 'Modified',
  accepted: 'Accepted', deposit_paid: 'Deposit Paid', balance_paid: 'Paid in Full',
  confirmed: 'Confirmed', completed: 'Completed',
};
const STATUS_CLASSES = {
  draft: 'badge-inprogress', sent: 'badge-submitted', viewed: 'badge-submitted',
  modified: 'badge-inprogress', accepted: 'badge-approved', deposit_paid: 'badge-approved',
  balance_paid: 'badge-approved', confirmed: 'badge-approved', completed: 'badge-reviewed',
};

const fmt = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Generate 30-minute time slots from 6:00 AM to 11:30 PM
const TIME_OPTIONS = [];
for (let h = 6; h < 24; h++) {
  ['00', '30'].forEach(m => {
    const val = `${String(h).padStart(2, '0')}:${m}`;
    const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ampm = h >= 12 ? 'PM' : 'AM';
    TIME_OPTIONS.push({ value: val, label: `${hour12}:${m} ${ampm}` });
  });
}

export default function ProposalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isEventContext = location.pathname.includes('/events/');
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [paymentLinkUrl, setPaymentLinkUrl] = useState('');
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkError, setLinkError] = useState('');

  // Balance / autopay state
  const [balanceDueDate, setBalanceDueDate] = useState('');
  const [savingDueDate, setSavingDueDate] = useState(false);
  const [chargingBalance, setChargingBalance] = useState(false);
  const [chargeResult, setChargeResult] = useState('');

  // Record payment state
  const [showRecordPayment, setShowRecordPayment] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentPaidInFull, setPaymentPaidInFull] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [paymentResult, setPaymentResult] = useState('');

  // Drink plan state (event context only)
  const [drinkPlan, setDrinkPlan] = useState(null);
  const [drinkPlanLoading, setDrinkPlanLoading] = useState(false);
  const [drinkPlanCopied, setDrinkPlanCopied] = useState(false);
  const [planCocktails, setPlanCocktails] = useState([]);
  const [planMocktails, setPlanMocktails] = useState([]);
  const [drinkPlanNotes, setDrinkPlanNotes] = useState('');
  const [savingDrinkPlanNotes, setSavingDrinkPlanNotes] = useState(false);

  // Staffing state (event context only)
  const [shift, setShift] = useState(null);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftRequests, setShiftRequests] = useState([]);
  const [autoAssignPreview, setAutoAssignPreview] = useState(null);
  const [autoAssignLoading, setAutoAssignLoading] = useState(false);
  const [equipmentForm, setEquipmentForm] = useState({ portable_bar: false, cooler: false, table_with_spandex: false, auto_assign_days_before: '' });
  const [savingEquipment, setSavingEquipment] = useState(false);

  // Event context: collapsible sections & manual assign
  const [showRequests, setShowRequests] = useState(false);
  const [showPackageDetails, setShowPackageDetails] = useState(false);
  const [showPaymentActions, setShowPaymentActions] = useState(false);
  const [assignSearch, setAssignSearch] = useState('');
  const [activeStaff, setActiveStaff] = useState([]);
  const [showAssignPicker, setShowAssignPicker] = useState(false);
  const [assigningStaff, setAssigningStaff] = useState(false);
  const [assignPosition, setAssignPosition] = useState('');
  const [selectedStaffToAssign, setSelectedStaffToAssign] = useState(null);
  const [setupMinutes, setSetupMinutes] = useState(60);
  const [savingSetup, setSavingSetup] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [editForm, setEditForm] = useState(null);
  const [editPreview, setEditPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [staffError, setStaffError] = useState('');
  const [editError, setEditError] = useState('');

  const loadProposal = () => {
    return api.get(`/proposals/${id}`).then(res => {
      setProposal(res.data);
      setNotes(res.data.admin_notes || '');
      setBalanceDueDate(res.data.balance_due_date ? res.data.balance_due_date.slice(0, 10) : '');
    }).catch(() => navigate(isEventContext ? '/admin/events' : '/admin/proposals')).finally(() => setLoading(false));
  };

  useEffect(() => { loadProposal(); }, [id]); // eslint-disable-line

  // Fetch drink plan + cocktail/mocktail data when viewing as event
  useEffect(() => {
    if (!isEventContext || !id) return;
    setDrinkPlanLoading(true);
    Promise.all([
      api.get(`/drink-plans/by-proposal/${id}`),
      api.get('/cocktails'),
      api.get('/mocktails').catch(() => ({ data: { mocktails: [] } })),
    ])
      .then(([planRes, cocktailsRes, mocktailsRes]) => {
        setDrinkPlan(planRes.data);
        setDrinkPlanNotes(planRes.data.admin_notes || '');
        setPlanCocktails(cocktailsRes.data.cocktails || []);
        setPlanMocktails(mocktailsRes.data.mocktails || []);
      })
      .catch(() => setDrinkPlan(null))
      .finally(() => setDrinkPlanLoading(false));
  }, [id, isEventContext]);

  // Fetch shift data when viewing as event
  const loadShift = (proposalId) => {
    return api.get(`/shifts/by-proposal/${proposalId}`).then(res => {
      setShift(res.data);
      setSetupMinutes(res.data.setup_minutes_before ?? 60);
      let required = [];
      try { required = JSON.parse(res.data.equipment_required || '[]'); } catch (e) {}
      setEquipmentForm({
        portable_bar: required.includes('portable_bar'),
        cooler: required.includes('cooler'),
        table_with_spandex: required.includes('table_with_spandex'),
        auto_assign_days_before: res.data.auto_assign_days_before ?? '',
      });
      return api.get(`/shifts/${res.data.id}/requests`);
    }).then(res => { if (res) setShiftRequests(res.data); })
      .catch(() => setShift(null));
  };

  useEffect(() => {
    if (!isEventContext || !id) return;
    setShiftLoading(true);
    loadShift(id).finally(() => setShiftLoading(false));
  }, [id, isEventContext]); // eslint-disable-line

  // Fetch active staff for manual assign picker (event context)
  useEffect(() => {
    if (!isEventContext) return;
    api.get('/admin/active-staff?limit=100')
      .then(res => setActiveStaff(res.data.staff || []))
      .catch(() => setActiveStaff([]));
  }, [isEventContext]);

  const handleManualAssign = async (userId, position) => {
    if (!shift) return;
    setAssigningStaff(true);
    try {
      await api.post(`/shifts/${shift.id}/assign`, { user_id: userId, position });
      setShowAssignPicker(false);
      setAssignSearch('');
      setSelectedStaffToAssign(null);
      setAssignPosition('');
      refreshShift();
    } catch (e) {
      console.error('Failed to assign staff:', e);
      setStaffError(e.response?.data?.error || 'Failed to assign staff');
    } finally { setAssigningStaff(false); }
  };

  const saveSetupTime = async () => {
    if (!shift) return;
    setSavingSetup(true);
    try {
      await api.put(`/shifts/${shift.id}`, { ...shift, setup_minutes_before: parseInt(setupMinutes, 10) || 60 });
      refreshShift();
    } catch (e) {
      console.error('Failed to save setup time:', e);
      setStaffError('Failed to save setup time');
    } finally { setSavingSetup(false); }
  };

  const loadRequests = (shiftId) => {
    api.get(`/shifts/${shiftId}/requests`)
      .then(res => setShiftRequests(res.data))
      .catch(e => console.error(e));
  };

  const refreshShift = () => { if (id) loadShift(id); };

  const updateRequestStatus = async (requestId, status) => {
    try {
      await api.put(`/shifts/requests/${requestId}`, { status });
      if (shift) loadRequests(shift.id);
      refreshShift();
    } catch (e) { console.error(e); }
  };

  const handleAutoAssignPreview = async () => {
    if (!shift) return;
    setAutoAssignLoading(true);
    try {
      const res = await api.post(`/shifts/${shift.id}/auto-assign`, { dry_run: true });
      setAutoAssignPreview({ shiftId: shift.id, ...res.data });
    } catch (e) {
      console.error('Auto-assign preview failed:', e);
      setStaffError(e.response?.data?.error || 'Auto-assign failed');
    } finally { setAutoAssignLoading(false); }
  };

  const handleAutoAssignConfirm = async () => {
    if (!autoAssignPreview) return;
    try {
      await api.post(`/shifts/${autoAssignPreview.shiftId}/auto-assign`, { dry_run: false });
      setAutoAssignPreview(null);
      refreshShift();
    } catch (e) {
      console.error('Auto-assign confirm failed:', e);
      setStaffError(e.response?.data?.error || 'Auto-assign failed');
    }
  };

  const saveEquipmentConfig = async () => {
    if (!shift) return;
    const equipment_required = ['portable_bar', 'cooler', 'table_with_spandex'].filter(k => equipmentForm[k]);
    const days = equipmentForm.auto_assign_days_before;
    setSavingEquipment(true);
    try {
      await api.put(`/shifts/${shift.id}`, {
        equipment_required,
        auto_assign_days_before: days !== '' ? parseInt(days, 10) : null,
      });
      refreshShift();
    } catch (e) {
      console.error('Failed to save equipment config:', e);
      setStaffError('Failed to save');
    } finally { setSavingEquipment(false); }
  };

  // Fetch packages/addons when edit mode is opened
  useEffect(() => {
    if (!editing) return;
    Promise.all([
      api.get('/proposals/packages'),
      api.get('/proposals/addons')
    ]).then(([pkgRes, addonRes]) => {
      setPackages(pkgRes.data);
      setAddons(addonRes.data);
    });
    // Pre-populate edit form from current proposal
    if (proposal && !editForm) {
      const currentAddonIds = (proposal.addons || []).map(a => a.addon_id);
      setEditForm({
        // Client fields
        client_name: proposal.client_name || '',
        client_email: proposal.client_email || '',
        client_phone: proposal.client_phone || '',
        client_source: proposal.client_source || 'thumbtack',
        // Event fields
        event_name: proposal.event_name || '',
        event_date: proposal.event_date ? proposal.event_date.slice(0, 10) : '',
        event_start_time: proposal.event_start_time || '',
        event_duration_hours: Number(proposal.event_duration_hours) || 4,
        event_location: proposal.event_location || '',
        guest_count: proposal.guest_count || 50,
        package_id: proposal.package_id || '',
        needs_bar: proposal.num_bars > 0,
        addon_ids: currentAddonIds,
      });
    }
  }, [editing]); // eslint-disable-line

  // Live pricing preview in edit mode
  useEffect(() => {
    if (!editing || !editForm || !editForm.package_id) { setEditPreview(null); return; }
    api.post('/proposals/calculate', {
      package_id: Number(editForm.package_id),
      guest_count: Number(editForm.guest_count) || 50,
      duration_hours: Number(editForm.event_duration_hours) || 4,
      num_bars: editForm.needs_bar ? 1 : 0,
      addon_ids: (editForm.addon_ids || []).map(Number)
    }).then(res => setEditPreview(res.data)).catch(() => setEditPreview(null));
  }, [editing, editForm?.package_id, editForm?.guest_count, editForm?.event_duration_hours, editForm?.needs_bar, editForm?.addon_ids]); // eslint-disable-line

  const updateEdit = (field, value) => setEditForm(f => ({ ...f, [field]: value }));

  const toggleEditAddon = (id) => {
    setEditForm(f => ({
      ...f,
      addon_ids: f.addon_ids.includes(id) ? f.addon_ids.filter(a => a !== id) : [...f.addon_ids, id]
    }));
  };

  const handleSaveEdit = async () => {
    if (!editForm.package_id) { setEditError('Please select a package.'); return; }
    setEditError('');
    setSaving(true);
    try {
      // Update client record if we have a client_id
      if (proposal.client_id) {
        await api.put(`/clients/${proposal.client_id}`, {
          name: editForm.client_name,
          email: editForm.client_email,
          phone: editForm.client_phone,
          source: editForm.client_source,
        });
      }
      // Update proposal event/package details
      await api.patch(`/proposals/${id}`, {
        event_name: editForm.event_name,
        event_date: editForm.event_date,
        event_start_time: editForm.event_start_time,
        event_duration_hours: Number(editForm.event_duration_hours),
        event_location: editForm.event_location,
        guest_count: Number(editForm.guest_count),
        package_id: Number(editForm.package_id),
        num_bars: editForm.needs_bar ? 1 : 0,
        addon_ids: (editForm.addon_ids || []).map(Number)
      });
      setLoading(true);
      await loadProposal();
      setEditing(false);
      setEditForm(null);
    } catch (err) {
      setEditError(err.response?.data?.error || 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  };

  const copyLink = () => {
    const url = `${window.location.origin}/proposal/${proposal.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage('Copied!');
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      await api.patch(`/proposals/${id}/notes`, { admin_notes: notes });
    } catch (err) {
      console.error('Failed to save notes:', err);
    } finally { setSavingNotes(false); }
  };

  const generatePaymentLink = async () => {
    setGeneratingLink(true);
    setLinkError('');
    try {
      const res = await api.post(`/stripe/payment-link/${id}?token=${proposal.token}`);
      setPaymentLinkUrl(res.data.url);
    } catch (err) {
      setLinkError(err.response?.data?.error || 'Failed to generate payment link. Check that Stripe env vars are set in Render.');
    } finally {
      setGeneratingLink(false);
    }
  };

  const copyPaymentLink = () => {
    navigator.clipboard.writeText(paymentLinkUrl).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  const updateStatus = async (status) => {
    try {
      const res = await api.patch(`/proposals/${id}/status`, { status });
      setProposal(prev => ({ ...prev, status: res.data.status }));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const saveBalanceDueDate = async () => {
    if (!balanceDueDate) return;
    setSavingDueDate(true);
    try {
      await api.patch(`/proposals/${id}/balance-due-date`, { balance_due_date: balanceDueDate });
      setProposal(prev => ({ ...prev, balance_due_date: balanceDueDate }));
    } catch (err) {
      console.error('Failed to save due date:', err);
    } finally { setSavingDueDate(false); }
  };

  const chargeBalance = async () => {
    setChargingBalance(true);
    setChargeResult('');
    try {
      const res = await api.post(`/stripe/charge-balance/${id}`);
      setChargeResult(`Charged ${fmt(res.data.amount / 100)} successfully.`);
      await loadProposal();
    } catch (err) {
      setChargeResult(err.response?.data?.error || 'Failed to charge balance.');
    } finally { setChargingBalance(false); }
  };

  const recordPayment = async () => {
    if (!paymentPaidInFull && (!paymentAmount || Number(paymentAmount) <= 0)) {
      setPaymentResult('Please enter a valid amount.');
      return;
    }
    setRecordingPayment(true);
    setPaymentResult('');
    try {
      await api.post(`/proposals/${id}/record-payment`, {
        amount: paymentPaidInFull ? undefined : Number(paymentAmount),
        paid_in_full: paymentPaidInFull,
        method: paymentMethod,
      });
      setPaymentResult(`Payment of ${fmt(paymentPaidInFull ? Number(proposal.total_price) - Number(proposal.amount_paid || 0) : Number(paymentAmount))} recorded successfully.`);
      setShowRecordPayment(false);
      setPaymentAmount('');
      setPaymentPaidInFull(false);
      await loadProposal();
    } catch (err) {
      setPaymentResult(err.response?.data?.error || 'Failed to record payment.');
    } finally { setRecordingPayment(false); }
  };

  const formatDate = (d, options) => {
    if (!d) return '—';
    const dateStr = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', options || { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDateWithDay = (d) => formatDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const formatDateTime = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const formatTime12 = (t) => {
    if (!t) return '?';
    const [h, m] = t.split(':').map(Number);
    const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const getServiceTime = () => {
    const start = proposal?.event_start_time;
    const duration = Number(proposal?.event_duration_hours) || 0;
    if (!start) return '—';
    const [h, m] = start.split(':').map(Number);
    const endH = h + Math.floor(duration) + Math.floor((m + (duration % 1) * 60) / 60);
    const endM = (m + (duration % 1) * 60) % 60;
    const endTime = `${String(endH).padStart(2, '0')}:${String(Math.round(endM)).padStart(2, '0')}`;
    return `${formatTime12(start)} – ${formatTime12(endTime)} (${duration}hr${duration !== 1 ? 's' : ''})`;
  };

  if (loading) return <div className="page-container" style={{ textAlign: 'center', padding: '3rem' }}><div className="spinner" /></div>;
  if (!proposal) return null;

  const snapshot = proposal.pricing_snapshot;
  const bartenders = snapshot?.staffing?.actual;
  const durationHours = snapshot?.inputs?.durationHours;
  const rawIncludes = proposal.package_includes || [];
  const includes = rawIncludes.map(item => {
    let text = item;
    if (durationHours != null) text = text.replace(/\{hours\}/g, durationHours);
    if (bartenders != null) {
      text = text.replace(/\{bartenders\}/g, bartenders);
      text = text.replace(/\{bartenders_s\}/g, bartenders !== 1 ? 's' : '');
    }
    return text;
  });

  // Edit mode — derived state
  const editSelectedPkg = editForm && packages.find(p => p.id === Number(editForm?.package_id));
  const isHostedPkg = editSelectedPkg && (editSelectedPkg.pricing_type === 'per_guest' || editSelectedPkg.pricing_type === 'per_guest_timed');
  const editFilteredAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && (!editSelectedPkg || a.applies_to !== editSelectedPkg.category)) return false;
    if (isHostedPkg && /bartender/i.test((a.name || '') + (a.slug || ''))) return false;
    return true;
  });

  // Staffing derived values
  let shiftPositions = [];
  if (shift) { try { shiftPositions = JSON.parse(shift.positions_needed || '[]'); } catch (e) {} }
  const approvedRequests = shiftRequests.filter(r => r.status === 'approved');
  const shiftApprovedCount = approvedRequests.length;
  const pendingRequests = shiftRequests.filter(r => r.status === 'pending');
  const neededCount = shiftPositions.length;
  const openCount = Math.max(0, neededCount - shiftApprovedCount);

  // Equipment flags
  let equipmentList = [];
  if (shift) { try { equipmentList = JSON.parse(shift.equipment_required || '[]'); } catch (e) {} }
  const EQUIP_LABELS = { portable_bar: 'Portable Bar', cooler: 'Cooler', table_with_spandex: '6ft Table w/ Spandex' };

  // Setup time calculation
  const getSetupTime = () => {
    if (!proposal?.event_start_time) return null;
    const mins = shift?.setup_minutes_before ?? 60;
    const [h, m] = proposal.event_start_time.split(':').map(Number);
    const totalMins = h * 60 + m - mins;
    const setupH = Math.floor(totalMins / 60);
    const setupM = totalMins % 60;
    return formatTime12(`${String(setupH).padStart(2, '0')}:${String(setupM).padStart(2, '0')}`);
  };

  // Staffing names for header
  const getStaffingDisplay = () => {
    if (!shift || neededCount === 0) return null;
    const names = approvedRequests.map(r => {
      const name = r.preferred_name || r.email;
      if (!name) return '?';
      const parts = name.split(' ');
      return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
    });
    if (shiftApprovedCount === 0) return `Unstaffed (${neededCount} needed)`;
    return `${shiftApprovedCount}/${neededCount} — ${names.join(', ')}`;
  };

  // Staffing status label
  const getStaffingStatus = () => {
    if (!shift || neededCount === 0) return null;
    if (shiftApprovedCount === 0) return 'Unstaffed';
    if (shiftApprovedCount >= neededCount) return 'Fully Staffed';
    return 'Partially Staffed';
  };

  // Open roles (count unfilled positions)
  const getOpenRoles = () => {
    if (!shift || openCount <= 0) return [];
    const filledPositions = approvedRequests.map(r => r.position || 'Bartender');
    const allPositions = [...shiftPositions];
    const open = [];
    for (const pos of allPositions) {
      const idx = filledPositions.indexOf(pos);
      if (idx >= 0) { filledPositions.splice(idx, 1); }
      else { open.push(pos); }
    }
    return open.length > 0 ? open : Array(openCount).fill('Bartender');
  };

  // Balance
  const totalPrice = Number(proposal.total_price || 0);
  const amountPaid = Number(proposal.amount_paid || 0);
  const balanceDue = totalPrice - amountPaid;

  // Assign picker: filter staff
  const filteredStaff = assignSearch.length >= 1
    ? activeStaff.filter(s => {
        const name = (s.preferred_name || s.email || '').toLowerCase();
        return name.includes(assignSearch.toLowerCase());
      }).slice(0, 8)
    : [];

  // Signature drink from drink plan
  const getSignatureDrink = () => {
    if (!drinkPlan || !drinkPlan.cocktail_selections) return null;
    let selections = drinkPlan.cocktail_selections;
    if (typeof selections === 'string') { try { selections = JSON.parse(selections); } catch (e) { return null; } }
    if (!Array.isArray(selections) || selections.length === 0) return null;
    const cocktailId = selections[0];
    const cocktail = planCocktails.find(c => c.id === cocktailId);
    return cocktail ? cocktail.name : null;
  };

  return (
    <div className="page-container wide">
      {/* ─── EVENT CONTEXT VIEW ─── */}
      {isEventContext && !editing && (
        <>
          {/* Header Band */}
          <div className="event-header">
            <div className="event-breadcrumb">
              <a href="/admin/events" onClick={e => { e.preventDefault(); navigate('/admin/events'); }}>Events</a>
              <span> / {proposal.event_name || `Event #${proposal.id}`}</span>
            </div>
            <div className="event-header-top">
              <h1 className="event-title">
                {proposal.event_name || (proposal.client_name ? `${proposal.client_name}'s Event` : `Event #${proposal.id}`)}
              </h1>
              <div className="event-header-actions">
                <button className="event-detail-btn" onClick={() => setEditing(true)}>Edit</button>
                <button className="event-detail-btn" onClick={copyLink}>{copyMessage || 'Copy Link'}</button>
              </div>
            </div>
            <div className="event-meta-row">
              <div className="event-meta-item">{formatDateWithDay(proposal.event_date)}</div>
              <div className="event-meta-item">{getServiceTime()}</div>
              {proposal.event_location && (
                <div className="event-meta-item">{proposal.event_location}</div>
              )}
              <div className="event-meta-item">{proposal.guest_count} guests</div>
            </div>
            {shift && (
              <div className="event-meta-row" style={{ marginTop: '0.25rem' }}>
                <div className="event-meta-item">Setup at {getSetupTime() || '--'}</div>
                <div className="event-meta-item">{getStaffingDisplay() || '--'}</div>
              </div>
            )}
          </div>

          {/* Operational Tags — hidden when completed */}
          {proposal.status !== 'completed' && (
            <div className="event-tags">
              {balanceDue > 0 && (
                <span className={`event-tag ${amountPaid === 0 ? 'event-tag-highlight' : ''}`}
                  title={`${fmt(balanceDue)} balance due`}>
                  $$$
                </span>
              )}
              {shift && openCount > 0 && (
                <span className={`event-tag ${shiftApprovedCount === 0 ? 'event-tag-highlight' : ''}`}
                  title={`${openCount} open position${openCount !== 1 ? 's' : ''} of ${neededCount} needed`}>
                  Staff
                </span>
              )}
              {!drinkPlanLoading && drinkPlan && drinkPlan.status === 'submitted' && (
                <span className="event-tag" title="Drink plan submitted, needs review">
                  List
                </span>
              )}
              {proposal.feedback_request_sent_at && proposal.feedback_status !== 'received' && (
                <span className="event-tag" title="Feedback requested, awaiting response">
                  Feedback
                </span>
              )}
            </div>
          )}

          {/* Two-column: Client+Staffing | Event Details */}
          <div className="event-columns">
            {/* Left Column */}
            <div>
              {/* Client Card */}
              <div className="card mb-2">
                <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
                  {proposal.client_name || 'Client'}
                </h3>
                {proposal.client_email && (
                  <div className="client-contact-item">
                    <span className="client-contact-icon">&#9993;</span>
                    <a href={`mailto:${proposal.client_email}`} style={{ color: 'inherit', textDecoration: 'none' }}>{proposal.client_email}</a>
                  </div>
                )}
                {proposal.client_phone && (
                  <div className="client-contact-item">
                    <span className="client-contact-icon">&#9742;</span>
                    <a href={`tel:${proposal.client_phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{formatPhone(proposal.client_phone)}</a>
                  </div>
                )}
                {proposal.client_id && (
                  <button className="section-toggle" style={{ marginTop: '0.5rem' }}
                    onClick={() => navigate(`/admin/clients/${proposal.client_id}`)}>
                    View Client Profile
                  </button>
                )}
              </div>

              {/* Staffing Summary */}
              {staffError && <div className="alert alert-error mb-1" style={{ cursor: 'pointer' }} onClick={() => setStaffError('')}>{staffError}</div>}
              <div className="card mb-2">
                <div className="flex-between" style={{ alignItems: 'center', marginBottom: '0.75rem' }}>
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>Staffing</h3>
                  {shift && (
                    <span className={`badge ${
                      getStaffingStatus() === 'Fully Staffed' ? 'badge-approved' :
                      getStaffingStatus() === 'Partially Staffed' ? 'badge-inprogress' :
                      'badge-deactivated'
                    }`}>
                      {getStaffingStatus()}
                    </span>
                  )}
                </div>

                {shiftLoading ? (
                  <div style={{ padding: '1rem', textAlign: 'center' }}><div className="spinner" /></div>
                ) : !shift ? (
                  <p className="text-muted text-small" style={{ margin: 0 }}>No shift created yet.</p>
                ) : (
                  <>
                    {/* Stats */}
                    <div className="staffing-stats">
                      <div className="staffing-stat"><strong>{neededCount}</strong> Needed</div>
                      <div className="staffing-stat"><strong>{shiftApprovedCount}</strong> Assigned</div>
                      <div className="staffing-stat"><strong>{openCount}</strong> Open</div>
                    </div>

                    {/* Assigned staff */}
                    {approvedRequests.map(req => (
                      <div className="assigned-staff-item" key={req.id}>
                        <span>{req.preferred_name || req.email}</span>
                        <span className="badge badge-approved">{req.position || 'Bartender'}</span>
                      </div>
                    ))}

                    {/* Open roles */}
                    {getOpenRoles().map((role, i) => (
                      <div className="open-role-item" key={i}>-- {role} (open)</div>
                    ))}

                    {/* Manual assign picker */}
                    {openCount > 0 && (
                      <div style={{ marginTop: '0.75rem' }}>
                        {!showAssignPicker ? (
                          <button className="section-toggle" onClick={() => setShowAssignPicker(true)}>
                            + Assign Staff Manually
                          </button>
                        ) : (
                          <div className="staff-assign-wrapper">
                            <input
                              className="staff-assign-search"
                              placeholder="Search staff by name..."
                              value={assignSearch}
                              onChange={e => { setAssignSearch(e.target.value); setSelectedStaffToAssign(null); }}
                              autoFocus
                            />
                            {filteredStaff.length > 0 && !selectedStaffToAssign && (
                              <div className="staff-assign-dropdown">
                                {filteredStaff.map(s => (
                                  <div key={s.id} className="staff-assign-item" onClick={() => {
                                    setSelectedStaffToAssign(s);
                                    setAssignSearch(s.preferred_name || s.email);
                                  }}>
                                    <div className="staff-assign-item-name">{s.preferred_name || s.email}</div>
                                    <div className="staff-assign-item-meta">{s.email}{s.city ? ` \u00b7 ${s.city}` : ''}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {selectedStaffToAssign && (
                              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                <select className="form-select" value={assignPosition} onChange={e => setAssignPosition(e.target.value)}
                                  style={{ fontSize: '0.82rem', padding: '0.3rem 0.5rem', flex: '0 0 auto' }}>
                                  <option value="">Position...</option>
                                  <option value="Bartender">Bartender</option>
                                  <option value="Barback">Barback</option>
                                  <option value="Server">Server</option>
                                </select>
                                <button className="btn btn-sm btn-primary" disabled={assigningStaff}
                                  onClick={() => handleManualAssign(selectedStaffToAssign.id, assignPosition || 'Bartender')}>
                                  {assigningStaff ? 'Assigning...' : 'Assign'}
                                </button>
                                <button className="btn btn-sm btn-secondary" onClick={() => {
                                  setShowAssignPicker(false);
                                  setAssignSearch('');
                                  setSelectedStaffToAssign(null);
                                  setAssignPosition('');
                                }}>Cancel</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Collapsible requests */}
                    <div style={{ marginTop: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <button className="section-toggle" onClick={() => setShowRequests(!showRequests)}>
                          {showRequests ? 'Hide Requests' : `View Requests (${shiftRequests.length})`}
                        </button>
                        {showRequests && pendingRequests.length > 0 && shift.status === 'open' && (
                          <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }}
                            disabled={autoAssignLoading} onClick={handleAutoAssignPreview}>
                            {autoAssignLoading ? 'Analyzing...' : 'Auto-Assign'}
                          </button>
                        )}
                      </div>
                      {showRequests && (
                        <div style={{ marginTop: '0.5rem' }}>
                          {shiftRequests.length === 0 ? (
                            <p className="text-muted text-small" style={{ margin: 0 }}>No staff requests yet.</p>
                          ) : (
                            <table className="admin-table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th>Staff</th>
                                  <th>Position</th>
                                  <th>Status</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {shiftRequests.map(req => (
                                  <tr key={req.id}>
                                    <td>
                                      <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{req.preferred_name || req.email}</div>
                                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{req.phone ? formatPhone(req.phone) : req.email}</div>
                                    </td>
                                    <td style={{ fontSize: '0.82rem' }}>{req.position || '--'}</td>
                                    <td>
                                      <span className={`badge ${req.status === 'approved' ? 'badge-approved' : req.status === 'denied' ? 'badge-deactivated' : 'badge-inprogress'}`}>
                                        {req.status}
                                      </span>
                                    </td>
                                    <td>
                                      <div style={{ display: 'flex', gap: '0.3rem' }}>
                                        {req.status !== 'approved' && (
                                          <button className="btn btn-primary btn-sm" onClick={() => updateRequestStatus(req.id, 'approved')}>Approve</button>
                                        )}
                                        {req.status !== 'denied' && (
                                          <button className="btn btn-danger btn-sm" onClick={() => updateRequestStatus(req.id, 'denied')}>Deny</button>
                                        )}
                                        {req.status !== 'pending' && (
                                          <button className="btn btn-secondary btn-sm" onClick={() => updateRequestStatus(req.id, 'pending')}>Reset</button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right Column */}
            <div>
              {/* Event Details — combined service config + financial */}
              <div className="card mb-2">
                <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
                  {proposal.package_name || 'Event Details'}
                </h3>
                <div style={{ fontSize: '0.9rem', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
                  {proposal.guest_count} guests &middot; {Number(proposal.event_duration_hours) || 0}hrs
                </div>
                {equipmentList.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                    {equipmentList.map(eq => (
                      <span key={eq} className="equipment-badge">{EQUIP_LABELS[eq] || eq}</span>
                    ))}
                  </div>
                )}
                {getSignatureDrink() && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>
                    Signature: {getSignatureDrink()}
                  </div>
                )}

                {/* Line items + total */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.5rem' }}>
                  <PricingBreakdown snapshot={snapshot} />
                </div>

                {/* Package descriptions (expandable) */}
                {includes.length > 0 && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <button className="section-toggle" onClick={() => setShowPackageDetails(!showPackageDetails)}>
                      {showPackageDetails ? 'Hide Package Details' : 'View Package Details'}
                    </button>
                    {showPackageDetails && (
                      <ul style={{ margin: '0.5rem 0 0 0', padding: '0 0 0 1.2rem', color: 'var(--warm-brown)' }}>
                        {includes.map((item, i) => <li key={i} className="text-small" style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                      </ul>
                    )}
                  </div>
                )}

                {/* Paid / Balance */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.75rem' }}>
                  <div className="financial-row">
                    <span className="financial-label">Paid</span>
                    <span className="financial-amount">{fmt(amountPaid)}</span>
                  </div>
                  <div className="financial-row">
                    <span className="financial-label">Balance</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className="financial-amount">{fmt(balanceDue)}</span>
                      {balanceDue > 0 && <span className="financial-badge-due">Due</span>}
                    </span>
                  </div>
                  {proposal.autopay_enrolled && (
                    <div className="financial-row">
                      <span className="financial-label">Autopay</span>
                      <span style={{ color: '#2d6a4f', fontWeight: 500, fontSize: '0.85rem' }}>Enrolled</span>
                    </div>
                  )}
                </div>

                {/* Collapsible payment actions */}
                {balanceDue > 0 && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <button className="section-toggle" onClick={() => setShowPaymentActions(!showPaymentActions)}>
                      {showPaymentActions ? 'Hide Payment Actions' : 'Payment Actions'}
                    </button>
                    {showPaymentActions && (
                      <div style={{ marginTop: '0.75rem' }}>
                        {proposal.status === 'deposit_paid' && (
                          <div style={{ marginBottom: '0.75rem' }}>
                            <label className="text-muted text-small" style={{ display: 'block', marginBottom: '0.3rem' }}>Balance Due Date</label>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                              <input type="date" className="form-input" value={balanceDueDate}
                                onChange={e => setBalanceDueDate(e.target.value)}
                                style={{ flex: 1, fontSize: '0.85rem', padding: '0.35rem 0.5rem' }} />
                              <button className="btn btn-sm btn-secondary" onClick={saveBalanceDueDate} disabled={savingDueDate}>
                                {savingDueDate ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        )}
                        {proposal.status === 'deposit_paid' && proposal.autopay_enrolled && proposal.stripe_payment_method_id && (
                          <div style={{ marginBottom: '0.75rem' }}>
                            <button className="btn btn-sm" onClick={chargeBalance} disabled={chargingBalance}>
                              {chargingBalance ? 'Charging...' : `Charge Balance (${fmt(balanceDue)})`}
                            </button>
                            {chargeResult && (
                              <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', color: chargeResult.includes('success') ? '#2d6a4f' : '#c0392b' }}>
                                {chargeResult}
                              </p>
                            )}
                          </div>
                        )}
                        {!['deposit_paid', 'balance_paid', 'confirmed', 'completed'].includes(proposal.status) && (
                          <div style={{ marginBottom: '0.75rem' }}>
                            <button className="btn btn-sm" onClick={generatePaymentLink} disabled={generatingLink}>
                              {generatingLink ? 'Generating...' : 'Generate Payment Link'}
                            </button>
                            {linkError && <p style={{ color: '#c0392b', fontSize: '0.85rem', marginTop: '0.5rem' }}>{linkError}</p>}
                            {paymentLinkUrl && (
                              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <input readOnly value={paymentLinkUrl} onClick={e => e.target.select()}
                                  style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.5rem', border: '1px solid var(--cream-dark)', borderRadius: '4px', background: '#faf5ef', color: 'var(--deep-brown)' }} />
                                <button className="btn btn-sm btn-secondary" onClick={copyPaymentLink}>
                                  {linkCopied ? 'Copied!' : 'Copy'}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {!['balance_paid', 'confirmed', 'completed'].includes(proposal.status) && (
                          <div>
                            {!showRecordPayment ? (
                              <button className="btn btn-sm btn-secondary" onClick={() => setShowRecordPayment(true)}>Record Payment</button>
                            ) : (
                              <div>
                                <label className="text-muted text-small" style={{ display: 'block', marginBottom: '0.4rem' }}>Record Outside Payment</label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                  <select className="form-select" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}
                                    style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem' }}>
                                    <option value="cash">Cash</option>
                                    <option value="venmo">Venmo</option>
                                    <option value="zelle">Zelle</option>
                                    <option value="check">Check</option>
                                    <option value="other">Other</option>
                                  </select>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--deep-brown)' }}>
                                    <input type="checkbox" checked={paymentPaidInFull}
                                      onChange={e => { setPaymentPaidInFull(e.target.checked); if (e.target.checked) setPaymentAmount(''); }}
                                      style={{ accentColor: 'var(--deep-brown)' }} />
                                    Paid in full ({fmt(balanceDue)} remaining)
                                  </label>
                                  {!paymentPaidInFull && (
                                    <input type="number" className="form-input" placeholder="Amount ($)" value={paymentAmount}
                                      onChange={e => setPaymentAmount(e.target.value)} min="0.01" step="0.01"
                                      style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem' }} />
                                  )}
                                  <div className="flex gap-05">
                                    <button className="btn btn-sm" onClick={recordPayment} disabled={recordingPayment}>
                                      {recordingPayment ? 'Recording...' : 'Confirm'}
                                    </button>
                                    <button className="btn btn-sm btn-secondary" onClick={() => { setShowRecordPayment(false); setPaymentResult(''); }}>
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                            {paymentResult && (
                              <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', color: paymentResult.includes('success') ? '#2d6a4f' : '#c0392b' }}>
                                {paymentResult}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Equipment & Setup config */}
                {shift && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
                    <div className="service-config-label">Equipment &amp; Setup</div>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                      {[
                        { key: 'portable_bar', label: 'Portable Bar' },
                        { key: 'cooler', label: 'Cooler' },
                        { key: 'table_with_spandex', label: '6ft Table w/ Spandex' },
                      ].map(item => (
                        <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                          <input type="checkbox" checked={equipmentForm[item.key]}
                            onChange={e => setEquipmentForm(f => ({ ...f, [item.key]: e.target.checked }))} />
                          {item.label}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Auto-assign</span>
                      <input type="number" className="form-input" style={{ width: 60, fontSize: '0.82rem', padding: '0.2rem 0.4rem' }}
                        placeholder="--" min="0" max="30"
                        value={equipmentForm.auto_assign_days_before}
                        onChange={e => setEquipmentForm(f => ({ ...f, auto_assign_days_before: e.target.value }))} />
                      <span style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>days before</span>
                      <button className="btn btn-sm btn-secondary" onClick={saveEquipmentConfig} disabled={savingEquipment}>
                        {savingEquipment ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
                      <span style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Setup</span>
                      <input type="number" className="form-input" style={{ width: 60, fontSize: '0.82rem', padding: '0.2rem 0.4rem' }}
                        min="0" max="180" step="15"
                        value={setupMinutes}
                        onChange={e => setSetupMinutes(e.target.value)} />
                      <span style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>min before</span>
                      <button className="btn btn-sm btn-secondary" onClick={saveSetupTime} disabled={savingSetup}>
                        {savingSetup ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Secondary Row: Potion Planner | Admin Notes */}
          <div className="event-columns" style={{ marginTop: '1.5rem' }}>
            {/* Potion Planner */}
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>Potion Planner</h3>
              {drinkPlanLoading ? (
                <div style={{ padding: '1rem', textAlign: 'center' }}><div className="spinner" /></div>
              ) : drinkPlan ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <span className={`badge ${drinkPlan.status === 'submitted' ? 'badge-submitted' : drinkPlan.status === 'reviewed' ? 'badge-approved' : 'badge-inprogress'}`}>
                      {drinkPlan.status === 'pending' ? 'Pending' : drinkPlan.status === 'draft' ? 'Draft' : drinkPlan.status === 'submitted' ? 'Submitted' : 'Reviewed'}
                    </span>
                    {drinkPlan.submitted_at && (
                      <span className="text-muted text-small">Submitted {formatDateTime(drinkPlan.submitted_at)}</span>
                    )}
                  </div>
                  <div className="flex gap-05 mb-2" style={{ flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" onClick={() => navigate(`/admin/drink-plans/${drinkPlan.id}`)}>View Full Details</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => {
                      const url = `${window.location.origin}/plan/${drinkPlan.token}`;
                      navigator.clipboard.writeText(url).then(() => { setDrinkPlanCopied(true); setTimeout(() => setDrinkPlanCopied(false), 2000); });
                    }}>{drinkPlanCopied ? 'Copied!' : 'Copy Client Link'}</button>
                    {drinkPlan.status === 'submitted' && (
                      <button className="btn btn-sm btn-success" onClick={async () => {
                        try { const res = await api.patch(`/drink-plans/${drinkPlan.id}/status`, { status: 'reviewed' }); setDrinkPlan(prev => ({ ...prev, status: res.data.status })); }
                        catch (err) { console.error('Failed to update status:', err); }
                      }}>Mark as Reviewed</button>
                    )}
                  </div>
                  {drinkPlan.status !== 'pending' && (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <DrinkPlanSelections plan={drinkPlan} cocktails={planCocktails} mocktails={planMocktails} />
                    </div>
                  )}
                  {/* Drink plan admin notes */}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem' }}>Plan Notes</strong>
                    <textarea className="form-textarea" rows={3} placeholder="Internal notes about this plan..."
                      value={drinkPlanNotes} onChange={e => setDrinkPlanNotes(e.target.value)} />
                    <button className="btn btn-sm mt-1" onClick={async () => {
                      setSavingDrinkPlanNotes(true);
                      try { await api.patch(`/drink-plans/${drinkPlan.id}/notes`, { admin_notes: drinkPlanNotes }); }
                      catch (err) { console.error('Failed to save notes:', err); }
                      finally { setSavingDrinkPlanNotes(false); }
                    }} disabled={savingDrinkPlanNotes}>
                      {savingDrinkPlanNotes ? 'Saving...' : 'Save Notes'}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-muted text-small" style={{ margin: 0 }}>No drink plan created yet.</p>
              )}
            </div>

            {/* Admin Notes */}
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Admin Notes</h3>
              <textarea className="form-input" rows={4} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Internal notes about this event..." style={{ resize: 'vertical' }} />
              <button className="btn btn-sm mt-1" onClick={saveNotes} disabled={savingNotes}>
                {savingNotes ? 'Saving...' : 'Save Notes'}
              </button>
            </div>
          </div>

          {/* Activity Log */}
          {proposal.activity && proposal.activity.length > 0 && (
            <div className="card" style={{ marginTop: '1.5rem' }}>
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Activity</h3>
              <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {proposal.activity.map((entry, i) => (
                  <div key={i} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--cream-dark, #e8e0d4)' }}>
                    <span className="text-small" style={{ fontWeight: 500 }}>{entry.action}</span>
                    <span className="text-muted text-small" style={{ marginLeft: '0.5rem' }}>
                      {entry.actor_type} &middot; {formatDateTime(entry.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── PROPOSAL CONTEXT / EDIT MODE ─── */}
      {(!isEventContext || editing) && (<>
      {/* Header */}
      <div className="flex-between mb-2">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', margin: 0 }}>
            {proposal.event_name
              || (proposal.client_name ? `${proposal.client_name}'s Event` : null)
              || (isEventContext ? `Event #${proposal.id}` : `Proposal #${proposal.id}`)}
          </h1>
          <span className={`badge ${STATUS_CLASSES[proposal.status] || ''}`} style={{ fontSize: '0.9rem' }}>
            {STATUS_LABELS[proposal.status] || proposal.status}
          </span>
        </div>
        <div className="flex gap-1">
          <button className="btn btn-secondary" onClick={() => navigate(isEventContext ? '/admin/events' : '/admin/proposals')}>Back</button>
          {!editing && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
          <button className="btn" onClick={copyLink}>{copyMessage || 'Copy Link'}</button>
        </div>
      </div>

      {/* Event context: overview card at top */}
      {isEventContext && !editing && (
        <div className="card mb-2">
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--deep-brown)' }}>{formatDateWithDay(proposal.event_date)}</div>
              <div style={{ fontSize: '0.9rem', color: 'var(--warm-brown)' }}>{getServiceTime()}</div>
              {proposal.event_location && <div style={{ fontSize: '0.9rem', color: 'var(--warm-brown)' }}>{proposal.event_location}</div>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <div style={{ fontSize: '0.9rem', color: 'var(--warm-brown)' }}>{proposal.guest_count} guests</div>
              <div style={{ fontSize: '0.9rem', color: 'var(--warm-brown)' }}>{proposal.package_name || '—'} &middot; {fmt(proposal.total_price)}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--deep-brown)' }}>{proposal.client_name || '—'}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)' }}>{formatPhone(proposal.client_phone)}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)' }}>{proposal.client_email || '—'}</div>
            </div>
          </div>
        </div>
      )}

      {/* Proposal context: original status card */}
      {!isEventContext && (
        <div className="card mb-2">
          <div className="flex-between" style={{ alignItems: 'center' }}>
            <div>
              <span className={`badge ${STATUS_CLASSES[proposal.status] || ''}`} style={{ fontSize: '0.9rem' }}>
                {STATUS_LABELS[proposal.status] || proposal.status}
              </span>
              {proposal.view_count > 0 && (
                <span className="text-muted text-small" style={{ marginLeft: '0.75rem' }}>
                  Viewed {proposal.view_count} time{proposal.view_count !== 1 ? 's' : ''}
                  {proposal.last_viewed_at && <> · Last: {formatDateTime(proposal.last_viewed_at)}</>}
                </span>
              )}
            </div>
            <div className="flex gap-05">
              {proposal.status === 'draft' && <button className="btn btn-sm" onClick={() => updateStatus('sent')}>Mark Sent</button>}
              {proposal.status === 'viewed' && <button className="btn btn-sm" onClick={() => updateStatus('accepted')}>Mark Accepted</button>}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Left column */}
        <div>
          {/* Client Info — proposal context shows labeled grid with source; event context skips (shown in overview) */}
          {!isEventContext && (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Client</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div><span className="text-muted text-small">Name</span><div>{proposal.client_name || '—'}</div></div>
                <div><span className="text-muted text-small">Email</span><div>{proposal.client_email || '—'}</div></div>
                <div><span className="text-muted text-small">Phone</span><div>{formatPhone(proposal.client_phone)}</div></div>
                <div><span className="text-muted text-small">Source</span><div>{proposal.client_source || '—'}</div></div>
              </div>
            </div>
          )}

          {/* Event Details — view or edit */}
          {editing && editForm ? (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Edit Proposal</h3>
              {editError && <div style={{ color: '#c0392b', marginBottom: '0.75rem', fontSize: '0.9rem' }}>{editError}</div>}

              <h4 style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Client</h4>
              <div className="two-col" style={{ gap: '0.75rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input className="form-input" value={editForm.client_name} onChange={e => updateEdit('client_name', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={editForm.client_email} onChange={e => updateEdit('client_email', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone</label>
                  <input className="form-input" type="tel" value={formatPhoneInput(editForm.client_phone)} onChange={e => updateEdit('client_phone', stripPhone(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Source</label>
                  <select className="form-select" value={editForm.client_source} onChange={e => updateEdit('client_source', e.target.value)}>
                    <option value="thumbtack">Thumbtack</option>
                    <option value="direct">Direct</option>
                    <option value="referral">Referral</option>
                    <option value="website">Website</option>
                  </select>
                </div>
              </div>

              <h4 style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Event</h4>
              <div className="two-col" style={{ gap: '0.75rem' }}>
                <div className="form-group">
                  <label className="form-label">Event Name</label>
                  <input className="form-input" value={editForm.event_name} onChange={e => updateEdit('event_name', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Event Date</label>
                  <input className="form-input" type="date" value={editForm.event_date} onChange={e => updateEdit('event_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Start Time</label>
                  <select className="form-select" value={editForm.event_start_time} onChange={e => updateEdit('event_start_time', e.target.value)}>
                    <option value="">— Select time —</option>
                    {TIME_OPTIONS.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Duration (hours)</label>
                  <input className="form-input" type="number" min="1" max="12" step="0.5" value={editForm.event_duration_hours} onChange={e => updateEdit('event_duration_hours', e.target.value)} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Location</label>
                  <LocationInput
                    value={editForm.event_location}
                    onChange={val => updateEdit('event_location', val)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Guest Count</label>
                  <input className="form-input" type="number" min="1" max="1000" value={editForm.guest_count} onChange={e => updateEdit('guest_count', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Portable Bar Needed?</label>
                  <select className="form-select" value={editForm.needs_bar ? 'yes' : 'no'} onChange={e => updateEdit('needs_bar', e.target.value === 'yes')}>
                    <option value="yes">Yes</option>
                    <option value="no">No — venue has a bar</option>
                  </select>
                </div>
              </div>

              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: '1rem 0 0.75rem' }}>Package</h3>
              <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '1rem' }}>
                {packages.map(pkg => (
                  <label key={pkg.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem',
                    borderRadius: '6px', cursor: 'pointer',
                    border: Number(editForm.package_id) === pkg.id ? '2px solid var(--deep-brown)' : '1px solid var(--cream-dark, #e8e0d4)',
                    background: Number(editForm.package_id) === pkg.id ? 'var(--cream-light, #faf5ef)' : 'transparent'
                  }}>
                    <input type="radio" name="edit-package" value={pkg.id} checked={Number(editForm.package_id) === pkg.id}
                      onChange={e => { updateEdit('package_id', e.target.value); updateEdit('addon_ids', []); }} />
                    <span style={{ fontWeight: 600, color: 'var(--deep-brown)', fontSize: '0.9rem' }}>{pkg.name}</span>
                  </label>
                ))}
              </div>

              {editFilteredAddons.length > 0 && (
                <>
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: '0 0 0.75rem' }}>Add-ons</h3>
                  <div style={{ display: 'grid', gap: '0.4rem', marginBottom: '1rem' }}>
                    {editFilteredAddons.map(addon => (
                      <label key={addon.id} style={{
                        display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0.75rem',
                        borderRadius: '6px', cursor: 'pointer',
                        background: editForm.addon_ids.includes(addon.id) ? 'var(--cream-light, #faf5ef)' : 'transparent'
                      }}>
                        <input type="checkbox" checked={editForm.addon_ids.includes(addon.id)} onChange={() => toggleEditAddon(addon.id)} />
                        <span style={{ color: 'var(--deep-brown)', fontSize: '0.9rem' }}>{addon.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              <div className="flex gap-1">
                <button className="btn" onClick={handleSaveEdit} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button className="btn btn-secondary" onClick={() => { setEditing(false); setEditForm(null); setEditError(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : !isEventContext ? (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Event</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div><span className="text-muted text-small">Event</span><div>{proposal.event_name || (proposal.client_name ? `${proposal.client_name}'s Event` : '—')}</div></div>
                <div><span className="text-muted text-small">Date</span><div>{formatDateWithDay(proposal.event_date)}</div></div>
                <div><span className="text-muted text-small">Service Time</span><div>{getServiceTime()}</div></div>
                <div><span className="text-muted text-small">Guests</span><div>{proposal.guest_count}</div></div>
                <div style={{ gridColumn: '1 / -1' }}><span className="text-muted text-small">Location</span><div>{proposal.event_location || '—'}</div></div>
              </div>
            </div>
          ) : null}

          {/* Admin Notes */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Admin Notes</h3>
            <textarea
              className="form-input"
              rows={4}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal notes about this event..."
              style={{ resize: 'vertical' }}
            />
            <button className="btn btn-sm mt-1" onClick={saveNotes} disabled={savingNotes}>
              {savingNotes ? 'Saving...' : 'Save Notes'}
            </button>
          </div>
        </div>

        {/* Right column */}
        <div>
          {/* Staffing — event context only */}
          {isEventContext && (
            <div className="card mb-2">
              <div className="flex-between" style={{ alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>Staffing</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {shift && (
                    <span className={`badge ${shift.status === 'open' ? 'badge-approved' : shift.status === 'filled' ? 'badge-reviewed' : 'badge-deactivated'}`}>
                      {shift.status}
                    </span>
                  )}
                  {shiftPositions.length > 0 && (
                    <span style={{
                      fontSize: '0.85rem', fontWeight: 600,
                      color: shiftApprovedCount >= shiftPositions.length ? 'var(--success)' : 'var(--warm-brown)',
                    }}>
                      {shiftApprovedCount}/{shiftPositions.length} filled
                    </span>
                  )}
                </div>
              </div>

              {shiftLoading ? (
                <div style={{ padding: '1rem', textAlign: 'center' }}><div className="spinner" /></div>
              ) : !shift ? (
                <p className="text-muted text-small" style={{ margin: 0 }}>No shift created yet.</p>
              ) : (
                <>
                  {/* Equipment config */}
                  <div style={{ borderBottom: '1px solid var(--cream-dark, #e8e0d4)', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
                    <strong style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--warm-brown)' }}>Required Equipment</strong>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                      {[
                        { key: 'portable_bar', label: 'Portable Bar' },
                        { key: 'cooler', label: 'Cooler' },
                        { key: 'table_with_spandex', label: '6ft Table w/ Spandex' },
                      ].map(item => (
                        <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                          <input type="checkbox" checked={equipmentForm[item.key]}
                            onChange={(e) => setEquipmentForm(f => ({ ...f, [item.key]: e.target.checked }))} />
                          {item.label}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Auto-assign</span>
                      <input type="number" className="form-input" style={{ width: 60, fontSize: '0.82rem', padding: '0.2rem 0.4rem' }}
                        placeholder="—" min="0" max="30"
                        value={equipmentForm.auto_assign_days_before}
                        onChange={(e) => setEquipmentForm(f => ({ ...f, auto_assign_days_before: e.target.value }))} />
                      <span style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>days before</span>
                      <button className="btn btn-sm btn-secondary" onClick={saveEquipmentConfig} disabled={savingEquipment} style={{ marginLeft: 'auto' }}>
                        {savingEquipment ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>

                  {/* Auto-assign + requests */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <strong style={{ fontSize: '0.85rem', color: 'var(--warm-brown)' }}>Requests ({shiftRequests.length})</strong>
                    {pendingRequests.length > 0 && shift.status === 'open' && (
                      <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }}
                        disabled={autoAssignLoading}
                        onClick={handleAutoAssignPreview}>
                        {autoAssignLoading ? 'Analyzing...' : 'Auto-Assign'}
                      </button>
                    )}
                  </div>

                  {shiftRequests.length === 0 ? (
                    <p className="text-muted text-small" style={{ margin: 0 }}>No staff requests yet.</p>
                  ) : (
                    <table className="admin-table" style={{ margin: 0 }}>
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th>Position</th>
                          <th>Notes</th>
                          <th>Status</th>
                          <th>Requested</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shiftRequests.map(req => (
                          <tr key={req.id}>
                            <td>
                              <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{req.preferred_name || req.email}</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{req.phone ? formatPhone(req.phone) : req.email}</div>
                            </td>
                            <td style={{ fontSize: '0.82rem' }}>{req.position || '—'}</td>
                            <td style={{ fontSize: '0.82rem', maxWidth: 180 }}>{req.notes || '—'}</td>
                            <td>
                              <span className={`badge ${req.status === 'approved' ? 'badge-approved' : req.status === 'denied' ? 'badge-deactivated' : 'badge-inprogress'}`}>
                                {req.status}
                              </span>
                            </td>
                            <td style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                              {new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: '0.3rem' }}>
                                {req.status !== 'approved' && (
                                  <button className="btn btn-primary btn-sm" onClick={() => updateRequestStatus(req.id, 'approved')}>Approve</button>
                                )}
                                {req.status !== 'denied' && (
                                  <button className="btn btn-danger btn-sm" onClick={() => updateRequestStatus(req.id, 'denied')}>Deny</button>
                                )}
                                {req.status !== 'pending' && (
                                  <button className="btn btn-secondary btn-sm" onClick={() => updateRequestStatus(req.id, 'pending')}>Reset</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          )}

          {/* Package & Pricing */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
              {editing && editSelectedPkg ? editSelectedPkg.name : (proposal.package_name || 'Package')}
            </h3>
            {!editing && includes.length > 0 && (
              <ul style={{ margin: '0 0 1rem 0', padding: '0 0 0 1.2rem', color: 'var(--warm-brown, #6b4226)' }}>
                {includes.map((item, i) => <li key={i} className="text-small" style={{ marginBottom: '0.2rem' }}>{item}</li>)}
              </ul>
            )}
            <PricingBreakdown snapshot={editing ? editPreview : snapshot} />
          </div>

          {/* Payment Status */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Payment</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <div>
                <span className="text-muted text-small">Total</span>
                <div>{fmt(proposal.total_price)}</div>
              </div>
              <div>
                <span className="text-muted text-small">Paid</span>
                <div>{fmt(proposal.amount_paid || 0)}</div>
              </div>
              <div>
                <span className="text-muted text-small">Balance</span>
                <div>{fmt(Number(proposal.total_price || 0) - Number(proposal.amount_paid || 0))}</div>
              </div>
              <div>
                <span className="text-muted text-small">Type</span>
                <div>{proposal.payment_type === 'full' ? 'Paid in Full' : 'Deposit'}</div>
              </div>
              {proposal.autopay_enrolled && (
                <div>
                  <span className="text-muted text-small">Autopay</span>
                  <div style={{ color: '#2d6a4f', fontWeight: 500 }}>Enrolled</div>
                </div>
              )}
            </div>

            {proposal.status === 'deposit_paid' && (
              <div style={{ borderTop: '1px solid var(--cream-dark, #e8e0d4)', paddingTop: '0.75rem', marginBottom: '0.75rem' }}>
                <label className="text-muted text-small" style={{ display: 'block', marginBottom: '0.3rem' }}>Balance Due Date</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="date"
                    className="form-input"
                    value={balanceDueDate}
                    onChange={e => setBalanceDueDate(e.target.value)}
                    style={{ flex: 1, fontSize: '0.85rem', padding: '0.35rem 0.5rem' }}
                  />
                  <button className="btn btn-sm btn-secondary" onClick={saveBalanceDueDate} disabled={savingDueDate}>
                    {savingDueDate ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {proposal.status === 'deposit_paid' && proposal.autopay_enrolled && proposal.stripe_payment_method_id && (
              <div style={{ borderTop: '1px solid var(--cream-dark, #e8e0d4)', paddingTop: '0.75rem' }}>
                <button className="btn btn-sm" onClick={chargeBalance} disabled={chargingBalance}>
                  {chargingBalance ? 'Charging...' : `Charge Balance Now (${fmt(Number(proposal.total_price || 0) - Number(proposal.amount_paid || 0))})`}
                </button>
                {chargeResult && (
                  <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', color: chargeResult.includes('success') ? '#2d6a4f' : '#c0392b' }}>
                    {chargeResult}
                  </p>
                )}
              </div>
            )}

            {!['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status) && (
              <div style={{ borderTop: '1px solid var(--cream-dark, #e8e0d4)', paddingTop: '0.75rem' }}>
                <p className="text-muted text-small" style={{ marginBottom: '0.5rem' }}>
                  Generate a payment link to share with the client.
                </p>
                <button className="btn btn-sm" onClick={generatePaymentLink} disabled={generatingLink}>
                  {generatingLink ? 'Generating...' : 'Generate Payment Link'}
                </button>
                {linkError && <p style={{ color: '#c0392b', fontSize: '0.85rem', marginTop: '0.5rem' }}>{linkError}</p>}
                {paymentLinkUrl && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      readOnly value={paymentLinkUrl} onClick={e => e.target.select()}
                      style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.5rem', border: '1px solid var(--cream-dark)', borderRadius: '4px', background: '#faf5ef', color: 'var(--deep-brown)' }}
                    />
                    <button className="btn btn-sm btn-secondary" onClick={copyPaymentLink}>
                      {linkCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {!['balance_paid', 'confirmed'].includes(proposal.status) && (
              <div style={{ borderTop: '1px solid var(--cream-dark, #e8e0d4)', paddingTop: '0.75rem' }}>
                {!showRecordPayment ? (
                  <button className="btn btn-sm btn-secondary" onClick={() => setShowRecordPayment(true)}>
                    Record Payment
                  </button>
                ) : (
                  <div>
                    <label className="text-muted text-small" style={{ display: 'block', marginBottom: '0.4rem' }}>Record Outside Payment</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <select
                        className="form-select"
                        value={paymentMethod}
                        onChange={e => setPaymentMethod(e.target.value)}
                        style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem' }}
                      >
                        <option value="cash">Cash</option>
                        <option value="venmo">Venmo</option>
                        <option value="zelle">Zelle</option>
                        <option value="check">Check</option>
                        <option value="other">Other</option>
                      </select>

                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--deep-brown)' }}>
                        <input
                          type="checkbox"
                          checked={paymentPaidInFull}
                          onChange={e => { setPaymentPaidInFull(e.target.checked); if (e.target.checked) setPaymentAmount(''); }}
                          style={{ accentColor: 'var(--deep-brown)' }}
                        />
                        Paid in full ({fmt(Number(proposal.total_price || 0) - Number(proposal.amount_paid || 0))} remaining)
                      </label>

                      {!paymentPaidInFull && (
                        <input
                          type="number"
                          className="form-input"
                          placeholder="Amount ($)"
                          value={paymentAmount}
                          onChange={e => setPaymentAmount(e.target.value)}
                          min="0.01"
                          step="0.01"
                          style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem' }}
                        />
                      )}

                      <div className="flex gap-05">
                        <button className="btn btn-sm" onClick={recordPayment} disabled={recordingPayment}>
                          {recordingPayment ? 'Recording...' : 'Confirm'}
                        </button>
                        <button className="btn btn-sm btn-secondary" onClick={() => { setShowRecordPayment(false); setPaymentResult(''); }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {paymentResult && (
                  <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', color: paymentResult.includes('success') ? '#2d6a4f' : '#c0392b' }}>
                    {paymentResult}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Event Shift — proposal context only (link to events) */}
          {!isEventContext && (['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status)) && (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>Event Shift</h3>
              <p className="text-muted text-small" style={{ marginBottom: '0.75rem' }}>
                A shift has been created for this event. Staff can now request to work it.
              </p>
              <button className="btn btn-sm" onClick={() => navigate(`/admin/events/${proposal.id}`)}>
                View in Events
              </button>
            </div>
          )}

          {/* Potion Planner (event context) */}
          {isEventContext && (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>Potion Planner</h3>
              {drinkPlanLoading ? (
                <div style={{ padding: '1rem', textAlign: 'center' }}><div className="spinner" /></div>
              ) : drinkPlan ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <span className={`badge ${drinkPlan.status === 'submitted' ? 'badge-submitted' : drinkPlan.status === 'reviewed' ? 'badge-approved' : 'badge-inprogress'}`}>
                      {drinkPlan.status === 'pending' ? 'Pending' : drinkPlan.status === 'draft' ? 'Draft' : drinkPlan.status === 'submitted' ? 'Submitted' : 'Reviewed'}
                    </span>
                    {drinkPlan.submitted_at && (
                      <span className="text-muted text-small">
                        Submitted {formatDateTime(drinkPlan.submitted_at)}
                      </span>
                    )}
                  </div>

                  <div className="flex gap-05 mb-2" style={{ flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" onClick={() => navigate(`/admin/drink-plans/${drinkPlan.id}`)}>
                      View Full Details
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => {
                      const url = `${window.location.origin}/plan/${drinkPlan.token}`;
                      navigator.clipboard.writeText(url).then(() => {
                        setDrinkPlanCopied(true);
                        setTimeout(() => setDrinkPlanCopied(false), 2000);
                      });
                    }}>
                      {drinkPlanCopied ? 'Copied!' : 'Copy Client Link'}
                    </button>
                    {drinkPlan.status === 'submitted' && (
                      <button className="btn btn-sm btn-success" onClick={async () => {
                        try {
                          const res = await api.patch(`/drink-plans/${drinkPlan.id}/status`, { status: 'reviewed' });
                          setDrinkPlan(prev => ({ ...prev, status: res.data.status }));
                        } catch (err) {
                          console.error('Failed to update status:', err);
                        }
                      }}>
                        Mark as Reviewed
                      </button>
                    )}
                  </div>

                  {drinkPlan.status !== 'pending' && (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginBottom: '0.75rem' }}>
                      <DrinkPlanSelections plan={drinkPlan} cocktails={planCocktails} mocktails={planMocktails} />
                    </div>
                  )}

                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Admin Notes</strong>
                    <textarea
                      className="form-textarea"
                      rows={3}
                      placeholder="Internal notes about this plan..."
                      value={drinkPlanNotes}
                      onChange={(e) => setDrinkPlanNotes(e.target.value)}
                    />
                    <button
                      className="btn btn-sm mt-1"
                      onClick={async () => {
                        setSavingDrinkPlanNotes(true);
                        try {
                          await api.patch(`/drink-plans/${drinkPlan.id}/notes`, { admin_notes: drinkPlanNotes });
                        } catch (err) {
                          console.error('Failed to save notes:', err);
                        } finally {
                          setSavingDrinkPlanNotes(false);
                        }
                      }}
                      disabled={savingDrinkPlanNotes}
                    >
                      {savingDrinkPlanNotes ? 'Saving...' : 'Save Notes'}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-muted text-small" style={{ margin: 0 }}>
                  No drink plan has been created for this event yet.
                </p>
              )}
            </div>
          )}

          {/* Activity Log */}
          {proposal.activity && proposal.activity.length > 0 && (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Activity</h3>
              <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {proposal.activity.map((entry, i) => (
                    <div key={i} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--cream-dark, #e8e0d4)' }}>
                      <span className="text-small" style={{ fontWeight: 500 }}>{entry.action}</span>
                      <span className="text-muted text-small" style={{ marginLeft: '0.5rem' }}>
                        {entry.actor_type} · {formatDateTime(entry.created_at)}
                      </span>
                    </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      </>)}

      {/* Auto-Assign Preview Modal */}
      {autoAssignPreview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setAutoAssignPreview(null)}>
          <div className="card" style={{ maxWidth: 700, width: '95%', maxHeight: '80vh', overflow: 'auto', padding: '1.5rem' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>Auto-Assign Preview</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1rem' }}>
              {autoAssignPreview.slots_remaining} position{autoAssignPreview.slots_remaining !== 1 ? 's' : ''} to fill. Top candidates will be approved.
            </p>
            {autoAssignPreview.scores?.length > 0 ? (
              <table className="admin-table" style={{ margin: 0, fontSize: '0.82rem' }}>
                <thead>
                  <tr>
                    <th></th>
                    <th>Name</th>
                    <th>Location</th>
                    <th>Total</th>
                    <th>Seniority</th>
                    <th>Geography</th>
                    <th>Equipment</th>
                    <th>Distance</th>
                    <th>Events</th>
                  </tr>
                </thead>
                <tbody>
                  {autoAssignPreview.scores.map((s, i) => {
                    const isSelected = autoAssignPreview.selected?.includes(s.request_id);
                    return (
                      <tr key={s.request_id} style={{ background: isSelected ? 'rgba(76, 175, 80, 0.08)' : undefined }}>
                        <td style={{ fontWeight: 600 }}>{isSelected ? '>' : ''} {i + 1}</td>
                        <td style={{ fontWeight: 600 }}>{s.preferred_name || `User ${s.user_id}`}</td>
                        <td style={{ fontSize: '0.78rem' }}>{[s.city, s.state].filter(Boolean).join(', ') || '—'}</td>
                        <td style={{ fontWeight: 700 }}>{s.scores.total}</td>
                        <td>{s.scores.seniority}</td>
                        <td>{s.scores.geography}</td>
                        <td>{s.scores.equipment}</td>
                        <td>{s.scores.distance_miles != null ? `${s.scores.distance_miles} mi` : '—'}</td>
                        <td>{s.scores.events_worked}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-muted">No pending requests to score.</p>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setAutoAssignPreview(null)}>Cancel</button>
              {autoAssignPreview.selected?.length > 0 && (
                <button className="btn btn-primary" onClick={handleAutoAssignConfirm}>
                  Approve {autoAssignPreview.selected.length} Staff
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
