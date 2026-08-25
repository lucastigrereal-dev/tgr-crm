import { useRef } from "react";

type Noop = (...args: never[]) => unknown;

/**
 * usePersistFn instead of useCallback to reduce cognitive load
 */
export function usePersistFn<T extends Noop>(fn: T): T {
  const fnRef = useRef<T>(fn);
  fnRef.current = fn;

  const persistFn = useRef<T>(null);
  if (!persistFn.current) {
    persistFn.current = ((...args: Parameters<T>): ReturnType<T> => fnRef.current!(...args) as ReturnType<T>) as T;
  }

  return persistFn.current!;
}
