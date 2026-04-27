import React from 'react';
import { getPackageBySlug } from '../../../../data/packages';

export default function PackageStep({ form, update, handleBarTypeChange, filteredPackages }) {
  return (
    <div className="wz-card">
      {/* Bar type picker */}
      {!form.bar_type ? (
        <>
          <h3>What are you serving?</h3>
          <div className="wz-choice-group wz-choice-group-lg">
            <button type="button" className="wz-choice-btn"
              onClick={() => handleBarTypeChange('full_bar')}>
              <strong>Full bar with cocktails</strong>
              <span>Spirits, beer, wine, and mixed drinks</span>
            </button>
            <button type="button" className="wz-choice-btn"
              onClick={() => handleBarTypeChange('beer_and_wine')}>
              <strong>Beer &amp; wine only</strong>
              <span>No liquor or mixed drinks</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="wz-package-header">
            <h3>Choose your package</h3>
            <button type="button" className="wz-change-type"
              onClick={() => handleBarTypeChange('')}>
              Change bar type
            </button>
          </div>
          <div className="wz-pkg-list">
            {filteredPackages.map(pkg => (
              <label key={pkg.id} className={`wz-pkg-option ${Number(form.package_id) === pkg.id ? 'selected' : ''}`}>
                <input type="radio" name="package" value={pkg.id}
                  checked={Number(form.package_id) === pkg.id}
                  onChange={e => { update('package_id', e.target.value); update('addon_ids', []); }}
                />
                <div className="wz-pkg-content">
                  <div className="wz-pkg-name">{pkg.name}</div>
                  {(() => {
                    const detail = getPackageBySlug(pkg.slug);
                    return detail ? (
                      <div className="wz-pkg-desc">{detail.tagline}</div>
                    ) : pkg.description ? (
                      <div className="wz-pkg-desc">{pkg.description}</div>
                    ) : null;
                  })()}
                  <div className="wz-pkg-price">
                    {pkg.pricing_type === 'per_guest' ? (
                      <>From ${Number(pkg.base_rate_4hr)}/guest</>
                    ) : (
                      <>From ${Number(pkg.base_rate_3hr || pkg.base_rate_4hr)}{pkg.base_rate_3hr ? '/3hr' : '/4hr'}</>
                    )}
                  </div>
                  {(() => {
                    const detail = getPackageBySlug(pkg.slug);
                    if (!detail) return null;
                    const isSelected = Number(form.package_id) === pkg.id;
                    if (isSelected) {
                      return (
                        <div className="wz-pkg-sections">
                          <div className="wz-pkg-expand-hint">What's included</div>
                          {detail.sections.map((section, si) => (
                            <div key={si} className="wz-pkg-section">
                              <div className="wz-pkg-section-heading">{section.heading}</div>
                              <ul className="wz-pkg-section-list">
                                {section.items.map((item, i) => <li key={i}>{item}</li>)}
                              </ul>
                            </div>
                          ))}
                        </div>
                      );
                    }
                    return <div className="wz-pkg-expand-hint">Select to see what's included</div>;
                  })()}
                </div>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
