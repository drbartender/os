import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { API_BASE_URL } from '../utils/api';

const ClientAuthContext = createContext(null);

const STORAGE_KEY = 'db_client_token';

export function ClientAuthProvider({ children }) {
  const [clientUser, setClientUser] = useState(null);
  const [clientLoading, setClientLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(STORAGE_KEY);
    if (token) {
      fetch(`${API_BASE_URL}/client-auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => {
          if (!res.ok) throw new Error('Unauthorized');
          return res.json();
        })
        .then(data => setClientUser(data.client))
        .catch(() => localStorage.removeItem(STORAGE_KEY))
        .finally(() => setClientLoading(false));
    } else {
      setClientLoading(false);
    }
  }, []);

  const clientLogin = useCallback((token, user) => {
    localStorage.setItem(STORAGE_KEY, token);
    setClientUser(user);
  }, []);

  const clientLogout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setClientUser(null);
  }, []);

  const isClientAuthenticated = !!clientUser;

  return (
    <ClientAuthContext.Provider value={{ clientUser, clientLoading, clientLogin, clientLogout, isClientAuthenticated }}>
      {children}
    </ClientAuthContext.Provider>
  );
}

export const useClientAuth = () => useContext(ClientAuthContext);
