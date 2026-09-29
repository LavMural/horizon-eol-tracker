import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useState that is remembered in sessionStorage, so a selection survives tab switches
 * and reloads. Falls back to plain in-memory state if storage is unavailable.
 */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        sessionStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}

/** Calls onOutside when a mousedown happens outside the returned ref's element. */
export function useClickOutside<T extends HTMLElement>(open: boolean, onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, onOutside]);
  return ref;
}
