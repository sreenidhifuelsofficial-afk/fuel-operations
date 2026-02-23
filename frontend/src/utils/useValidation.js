import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Tiny validation engine for forms
// - values: object of current field values
// - schema: { [field]: { required?: boolean, validate?: (val, values)=>string|'' } }
// - options: { debounceMs?: number }
export default function useValidation(values, schema = {}, options = {}) {
  const debounceMs = options.debounceMs ?? 200;
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const timersRef = useRef({});

  const fields = useMemo(() => Object.keys(schema || {}), [schema]);

  const getRequiredError = (name, val) => {
    const rule = schema[name] || {};
    if (!rule.required) return '';
    if (val === undefined || val === null) return 'This field is required';
    const s = String(val).trim();
    if (s.length === 0) return 'This field is required';
    return '';
  };

  const runValidate = useCallback((name, nextVal) => {
    const rule = schema[name];
    if (!rule) return '';
    const val = nextVal !== undefined ? nextVal : values?.[name];
    let msg = getRequiredError(name, val);
    if (!msg && rule.validate) {
      // validate only when value is present or rule wants to validate empties too
      const present = !(val === undefined || val === null || String(val).trim() === '');
      if (present || rule.alwaysValidate) {
        const out = rule.validate(val, values);
        if (typeof out === 'string') msg = out || '';
        else if (out === false) msg = 'Invalid value';
      }
    }
    setErrors(prev => (prev[name] === msg ? prev : { ...prev, [name]: msg }));
    return msg;
  }, [schema, values]);

  const validateField = useCallback((name) => runValidate(name), [runValidate]);

  const schedule = useCallback((name, nextVal) => {
    setTouched(prev => (prev[name] ? prev : { ...prev, [name]: true }));
    const key = String(name);
    if (timersRef.current[key]) clearTimeout(timersRef.current[key]);
    timersRef.current[key] = setTimeout(() => {
      runValidate(name, nextVal);
      timersRef.current[key] = null;
    }, debounceMs);
  }, [debounceMs, runValidate]);

  const onBlur = useCallback((name) => {
    setTouched(prev => (prev[name] ? prev : { ...prev, [name]: true }));
    runValidate(name);
  }, [runValidate]);

  const validateAll = useCallback(() => {
    let ok = true;
    const nextErrors = {};
    for (const f of fields) {
      const msg = (function () {
        const rule = schema[f];
        if (!rule) return '';
        const val = values?.[f];
        let m = getRequiredError(f, val);
        if (!m && rule.validate) {
          const present = !(val === undefined || val === null || String(val).trim() === '');
          if (present || rule.alwaysValidate) {
            const out = rule.validate(val, values);
            if (typeof out === 'string') m = out || '';
            else if (out === false) m = 'Invalid value';
          }
        }
        return m;
      })();
      nextErrors[f] = msg;
      if (msg) ok = false;
    }
    setErrors(nextErrors);
    // mark all as touched so messages are visible
    setTouched(fields.reduce((acc, k) => { acc[k] = true; return acc; }, {}));
    return ok;
  }, [fields, schema, values]);

  const hasErrors = useMemo(() => Object.values(errors || {}).some(Boolean), [errors]);
  const requiredFieldsOk = useMemo(() => {
    for (const f of fields) {
      if (schema[f]?.required) {
        const val = values?.[f];
        const msg = getRequiredError(f, val);
        if (msg) return false;
      }
    }
    return true;
  }, [fields, schema, values]);

  const canSubmit = useMemo(() => requiredFieldsOk && !hasErrors, [requiredFieldsOk, hasErrors]);

  // Cleanup timers on unmount
  useEffect(() => () => {
    Object.values(timersRef.current || {}).forEach(t => t && clearTimeout(t));
  }, []);

  return {
    errors,
    touched,
    onBlur,
    schedule, // call after setValue in onChange to debounce-validate
    validateField,
    validateAll,
    canSubmit,
  };
}
