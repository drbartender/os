import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ToastContainer from '../components/Toast';

const ToastContext = createContext(null);

const MAX_VISIBLE = 3;
const SUCCESS_TIMEOUT_MS = 5000;
const ERROR_TIMEOUT_MS = 8000;
const INFO_TIMEOUT_MS = 5000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);
  const timeoutsRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    const handle = timeoutsRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((type, message, timeoutMs) => {
    const id = ++idCounter.current;
    setToasts((prev) => {
      const next = [...prev, { id, type, message }];
      if (next.length > MAX_VISIBLE) {
        // Drop oldest, clear its pending timeout
        const dropped = next.slice(0, next.length - MAX_VISIBLE);
        dropped.forEach((t) => {
          const h = timeoutsRef.current.get(t.id);
          if (h) {
            clearTimeout(h);
            timeoutsRef.current.delete(t.id);
          }
        });
        return next.slice(next.length - MAX_VISIBLE);
      }
      return next;
    });
    const handle = setTimeout(() => dismiss(id), timeoutMs);
    timeoutsRef.current.set(id, handle);
  }, [dismiss]);

  // Clear all pending timeouts on unmount
  useEffect(() => () => {
    timeoutsRef.current.forEach((h) => clearTimeout(h));
    timeoutsRef.current.clear();
  }, []);

  const value = useMemo(() => ({
    success: (m) => push('success', m, SUCCESS_TIMEOUT_MS),
    error:   (m) => push('error',   m, ERROR_TIMEOUT_MS),
    info:    (m) => push('info',    m, INFO_TIMEOUT_MS),
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};
