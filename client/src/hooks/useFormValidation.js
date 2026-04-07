import { useState, useCallback } from 'react';

/**
 * Lightweight form validation hook.
 *
 * Usage:
 *   const { touched, validate, fieldClass, inputClass, clearField, clearAll } = useFormValidation();
 *
 *   const rules = [
 *     { field: 'email', label: 'Email' },                          // required (truthy + non-blank string)
 *     { field: 'age', label: 'Age', test: v => Number(v) >= 21 },  // custom test
 *     { field: 'pw2', label: null, test: (v, data) => v === data.password },  // highlight only, no label in message
 *   ];
 *
 *   const result = validate(rules, formData);
 *   // => { valid: false, missing: ['email'], message: 'Please fill in: Email' }
 */
export default function useFormValidation() {
  const [touched, setTouched] = useState({});

  const validate = useCallback((rules, formData) => {
    const failed = [];
    const marks = {};

    for (const rule of rules) {
      const value = formData[rule.field];
      const pass = rule.test
        ? rule.test(value, formData)
        : (typeof value === 'string' ? value.trim() !== '' : !!value);

      if (!pass) {
        failed.push(rule);
        marks[rule.field] = true;
      }
    }

    setTouched(failed.length > 0 ? marks : {});

    const labeled = failed.filter(r => r.label);
    return {
      valid: failed.length === 0,
      missing: failed.map(r => r.field),
      message: labeled.length > 0
        ? `Please fill in: ${labeled.map(r => r.label).join(', ')}`
        : '',
    };
  }, []);

  const fieldClass = useCallback((name) => touched[name] ? ' field-error' : '', [touched]);
  const inputClass = useCallback((name) => touched[name] ? ' input-error' : '', [touched]);

  const clearField = useCallback((name) => setTouched(t => {
    if (!t[name]) return t;
    const next = { ...t };
    delete next[name];
    return next;
  }), []);

  const clearAll = useCallback(() => setTouched({}), []);

  return { touched, validate, fieldClass, inputClass, clearField, clearAll };
}
