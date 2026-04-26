import React, { useState, useEffect, useCallback } from 'react';
import api from '../utils/api';
import { LEAD_SOURCES } from '../utils/leadSources';

export default function AudienceSelector({ targetSources, targetEventTypes, onChange, selectedLeadIds, onLeadIdsChange }) {
  const [leads, setLeads] = useState([]);
  const [matchCount, setMatchCount] = useState(null);
  const [selectMode, setSelectMode] = useState(selectedLeadIds?.length > 0 ? 'manual' : 'filter');

  const fetchMatchCount = useCallback(async () => {
    try {
      const params = {};
      if (targetSources?.length) params.lead_source = targetSources[0]; // simplified
      const res = await api.get('/email-marketing/leads', { params: { ...params, limit: 1 } });
      setMatchCount(res.data.total);
    } catch (err) {
      console.error('Error fetching match count:', err);
    }
  }, [targetSources]);

  useEffect(() => {
    if (selectMode === 'filter') fetchMatchCount();
  }, [selectMode, fetchMatchCount]);

  const fetchLeads = useCallback(async () => {
    try {
      const res = await api.get('/email-marketing/leads', { params: { status: 'active', limit: 500 } });
      setLeads(res.data.leads);
    } catch (err) {
      console.error('Error fetching leads:', err);
    }
  }, []);

  useEffect(() => {
    if (selectMode === 'manual') fetchLeads();
  }, [selectMode, fetchLeads]);

  const handleSourceToggle = (source) => {
    const current = targetSources || [];
    const updated = current.includes(source)
      ? current.filter(s => s !== source)
      : [...current, source];
    onChange({ targetSources: updated, targetEventTypes });
  };

  const handleLeadToggle = (leadId) => {
    const current = selectedLeadIds || [];
    const updated = current.includes(leadId)
      ? current.filter(id => id !== leadId)
      : [...current, leadId];
    if (onLeadIdsChange) onLeadIdsChange(updated);
  };

  const handleSelectAll = () => {
    if (onLeadIdsChange) onLeadIdsChange(leads.map(l => l.id));
  };

  const handleDeselectAll = () => {
    if (onLeadIdsChange) onLeadIdsChange([]);
  };

  return (
    <div className="em-audience-selector">
      <div className="em-audience-mode-toggle">
        <button
          type="button"
          className={`btn btn-sm ${selectMode === 'filter' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSelectMode('filter')}
        >
          Filter by Source
        </button>
        <button
          type="button"
          className={`btn btn-sm ${selectMode === 'manual' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSelectMode('manual')}
        >
          Select Manually
        </button>
      </div>

      {selectMode === 'filter' && (
        <div className="em-audience-filters">
          <label className="form-label">Lead Sources:</label>
          <div className="em-source-chips">
            {LEAD_SOURCES.map(source => (
              <button
                key={source}
                type="button"
                className={`em-chip ${(targetSources || []).includes(source) ? 'em-chip-active' : ''}`}
                onClick={() => handleSourceToggle(source)}
              >
                {source.replace('_', ' ')}
              </button>
            ))}
          </div>
          {matchCount !== null && (
            <p className="em-match-count">
              {!targetSources?.length ? 'All active leads' : `${matchCount} matching leads`}
            </p>
          )}
        </div>
      )}

      {selectMode === 'manual' && (
        <div className="em-audience-manual">
          <div className="em-audience-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleSelectAll}>Select All</button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleDeselectAll}>Deselect All</button>
            <span className="em-match-count">{(selectedLeadIds || []).length} selected</span>
          </div>
          <div className="em-lead-list-scroll">
            {leads.map(lead => (
              <label key={lead.id} className="em-lead-checkbox">
                <input
                  type="checkbox"
                  checked={(selectedLeadIds || []).includes(lead.id)}
                  onChange={() => handleLeadToggle(lead.id)}
                />
                <span>{lead.name}</span>
                <span className="em-lead-email">{lead.email}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
