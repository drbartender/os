import React, { useEffect, useState } from 'react';
import useUrlListState from '../../hooks/useUrlListState';
import CocktailMenuDashboard from './CocktailMenuDashboard';
import RecipesTab from './potions/RecipesTab';
import PantryParsTab from './potions/PantryParsTab';
import PackagesTab from './potions/PackagesTab';
import PlansDrawer from './potions/PlansDrawer';
import StatusChip from '../../components/adminos/StatusChip';
import api from '../../utils/api';

// Potions: the bar-program home (design layout 1a). Menu = the published
// catalog (the existing CocktailMenuDashboard, embedded untouched), Recipes =
// the formulas, Pars = the stock catalog; client plans ride in a drawer.
// Replaces the two old sidebar items (Drink Plans + Cocktail Menu).
const TABS = ['menu', 'recipes', 'pars', 'packages'];

export default function PotionsPage() {
  const [state, setState] = useUrlListState({ tab: 'menu', drawer: '', drink: '' });
  const tab = TABS.includes(state.tab) ? state.tab : 'menu';
  const [pendingLists, setPendingLists] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get('/admin/badge-counts')
      .then((res) => { if (!cancelled) setPendingLists(res.data?.pending_shopping_lists || 0); })
      .catch(() => { /* badge is decorative; the drawer still shows truth */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Potions</div>
          <div className="page-subtitle">The formulary: menu, recipes, par stock, and package contents in one place. Client drink plans feed in here.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setState({ drawer: 'plans' })}>
            Client plans
            {pendingLists > 0 && <StatusChip kind="warn">{pendingLists}</StatusChip>}
          </button>
        </div>
      </div>

      <div className="seg potions-tabs">
        <button type="button" className={tab === 'menu' ? 'active' : ''} onClick={() => setState({ tab: 'menu' })}>Menu</button>
        <button type="button" className={tab === 'recipes' ? 'active' : ''} onClick={() => setState({ tab: 'recipes' })}>Recipes</button>
        <button type="button" className={tab === 'pars' ? 'active' : ''} onClick={() => setState({ tab: 'pars' })}>Pars</button>
        <button type="button" className={tab === 'packages' ? 'active' : ''} onClick={() => setState({ tab: 'packages' })}>Packages</button>
      </div>

      {tab === 'menu' && <CocktailMenuDashboard embedded />}
      {tab === 'recipes' && (
        <RecipesTab
          focusDrinkId={state.drink || null}
          onConsumeFocus={() => setState({ drink: '' })}
          goToPars={() => setState({ tab: 'pars' })}
        />
      )}
      {tab === 'pars' && <PantryParsTab />}
      {tab === 'packages' && (
        <PackagesTab onOpenRecipe={(id) => setState({ tab: 'recipes', drink: id })} />
      )}

      <PlansDrawer open={state.drawer === 'plans'} onClose={() => setState({ drawer: '' })} />
    </div>
  );
}
