import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Warn before leaving a page with unsaved work.
 *
 * The flow editor holds everything in memory until Save, so clicking a
 * nav tab throws away however long you spent wiring a flow with no
 * indication that anything was lost. Nothing on the page even looked
 * like it was in progress.
 *
 * Three exits have to be covered, and they need different mechanisms:
 *
 *  - **Closing the tab or reloading.** `beforeunload`, which is the only
 *    hook the browser gives us and deliberately shows its own wording —
 *    ours is ignored.
 *  - **Clicking a link.** Every in-app link renders an `<a href>`, so a
 *    capture-phase listener on the document catches them all without
 *    each one having to opt in. Capture matters: react-router's own
 *    handler is on the anchor, and we need to win before it navigates.
 *  - **Programmatic navigate().** Buttons that route in code never touch
 *    an anchor, so they call `guardedNavigate` instead.
 *
 * Not covered: the browser back button. Blocking `popstate` means
 * pushing a sentinel entry and re-pushing it on every attempt, which
 * breaks forward navigation and can trap somebody on the page — worse
 * than the problem. Doing it properly needs `useBlocker`, which is a
 * data-router API, and this app mounts a plain `BrowserRouter`.
 */
export function useUnsavedGuard(dirty: boolean) {
  const navigate = useNavigate();
  // Read through a ref inside the listeners: they are installed once,
  // and a stale closure over `dirty` would guard the page against the
  // state it had when it mounted.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome still wants returnValue set, even though no browser has
      // rendered a custom string for years.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      // Let the browser handle anything that was never a plain
      // left-click navigation: new tabs, downloads, modified clicks.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      // Only same-origin in-app routes. An external link leaves the SPA
      // entirely, where beforeunload is already the right guard.
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === window.location.pathname + window.location.search) return;

      e.preventDefault();
      e.stopPropagation();
      setPending(to);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  /** For navigation that happens in code rather than through a link. */
  const guardedNavigate = useCallback(
    (to: string) => {
      if (dirtyRef.current) setPending(to);
      else navigate(to);
    },
    [navigate],
  );

  const confirmLeave = useCallback(() => {
    const to = pending;
    setPending(null);
    if (to) navigate(to);
  }, [navigate, pending]);

  return {
    /** Non-null while we are asking. Render a dialog when it is set. */
    pendingPath: pending,
    stay: useCallback(() => setPending(null), []),
    leave: confirmLeave,
    guardedNavigate,
  };
}
