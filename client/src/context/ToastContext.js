import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import ToastContainer from '../components/Toast';

const ToastContext = createContext(null);

const MAX_VISIBLE = 3;
const SUCCESS_TIMEOUT_MS = 5000;
const ERROR_TIMEOUT_MS = 8000;
const INFO_TIMEOUT_MS = 5000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((type, message, timeoutMs) => {
    const id = ++idCounter.current;
    setToasts((prev) => {
      const next = [...prev, { id, type, message }];
      // If over max, drop the oldest
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
    setTimeout(() => dismiss(id), timeoutMs);
  }, [dismiss]);

  const value = {
    success: useCallback((m) => push('success', m, SUCCESS_TIMEOUT_MS), [push]),
    error: useCallback((m) => push('error', m, ERROR_TIMEOUT_MS), [push]),
    info: useCallback((m) => push('info', m, INFO_TIMEOUT_MS), [push]),
  };

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
