import { getHomePath } from './userRoutes';

// getHomePath reads window.location at call time, so each test swaps in a
// stub location with the hostname under test and a spyable replace().
const realLocation = window.location;

function setHostname(hostname) {
  delete window.location;
  window.location = { hostname, replace: jest.fn() };
}

afterEach(() => {
  window.location = realLocation;
  localStorage.clear();
});

describe('getHomePath — admin/manager host awareness', () => {
  test('null user → /login', () => {
    setHostname('admin.drbartender.com');
    expect(getHomePath(null)).toBe('/login');
  });

  test('admin on admin host lands on /dashboard, no kick', () => {
    setHostname('admin.drbartender.com');
    const path = getHomePath({ role: 'admin', onboarding_status: 'approved' });
    expect(path).toBe('/dashboard');
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  test('non-portal manager on staff host is kicked to the admin app (the blank-page loop)', () => {
    setHostname('staff.drbartender.com');
    localStorage.setItem('token', 'stale-jwt');
    getHomePath({ role: 'manager', onboarding_status: 'hired' });
    expect(window.location.replace).toHaveBeenCalledWith('https://admin.drbartender.com/dashboard');
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('non-portal admin on hiring host is kicked to the admin app', () => {
    setHostname('hiring.drbartender.com');
    getHomePath({ role: 'admin', onboarding_status: 'hired' });
    expect(window.location.replace).toHaveBeenCalledWith('https://admin.drbartender.com/dashboard');
  });

  test('portal-status admin on staff host stays (may browse the staff portal)', () => {
    setHostname('staff.drbartender.com');
    const path = getHomePath({ role: 'admin', onboarding_status: 'approved' });
    expect(path).toBe('/dashboard');
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  test('non-portal manager on localhost stays on /dashboard (dev app context)', () => {
    setHostname('localhost');
    const path = getHomePath({ role: 'manager', onboarding_status: 'hired' });
    expect(path).toBe('/dashboard');
    expect(window.location.replace).not.toHaveBeenCalled();
  });
});

describe('getHomePath — cross-domain kicks clear the stale token', () => {
  test('portal staff on admin host: kicked to staff AND token cleared (no poisoned origin)', () => {
    setHostname('admin.drbartender.com');
    localStorage.setItem('token', 'staff-account-jwt');
    getHomePath({ role: 'staff', onboarding_status: 'approved' });
    expect(window.location.replace).toHaveBeenCalledWith('https://staff.drbartender.com/dashboard');
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('applicant on staff host: kicked to hiring AND token cleared', () => {
    setHostname('staff.drbartender.com');
    localStorage.setItem('token', 'applicant-jwt');
    getHomePath({ role: 'staff', onboarding_status: 'applied', has_application: true });
    expect(window.location.replace).toHaveBeenCalledWith('https://hiring.drbartender.com/application-status');
    expect(localStorage.getItem('token')).toBeNull();
  });
});
