import { type RefObject, useEffect, useRef, useState } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

/**
 * Tracks the visitor's reduced-motion preference, updating if it changes.
 *
 * @returns `true` when animation loops should not run.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Reports whether an element is on screen, so demos only animate while someone can see
 * them.
 *
 * @param ref - Element to observe.
 * @param rootMargin - Margin around the viewport. Defaults to a small pre-roll.
 * @returns `true` while the element intersects the viewport. Always `true` where
 *   IntersectionObserver is unavailable.
 */
export function useInView(ref: RefObject<Element | null>, rootMargin = "0px 0px -10% 0px") {
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/**
 * Runs a callback on an interval. Pass `null` to stop it.
 *
 * @param callback - Called every `delay` ms; the latest version is always used.
 * @param delay - Interval in ms, or `null` to pause.
 */
export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  });
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

/**
 * Tracks a media query.
 *
 * @param query - Media query, e.g. `(min-width: 768px)`.
 * @returns Whether it matches; `false` where `matchMedia` is unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
