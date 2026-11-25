'use client';

import { useEffect } from 'react';

// Phones only. While a text field has focus (so the keyboard is up):
// - <html> gets the class "trip-typing": trip.css hides the bottom bar, the chat globe and the
//   top bars, and keeps pop-ups inside the part of the screen the keyboard doesn't cover.
// - --trip-vv-top / --trip-kb hold where that visible part starts and how tall the keyboard is.
// - The focused field is scrolled to the upper third of what's still visible.
// iOS doesn't reliably scroll a field into view when it sits inside a scrolling panel
// (rather than the page itself), which is why fields ended up behind the keyboard.

const TEXT_INPUT = /^(text|search|email|url|tel|number|password|date|time|datetime-local|month|week)$/;

function isEditable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT.test(el.type || 'text');
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

export function KeyboardAware() {
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const root = document.documentElement;
    const vv = window.visualViewport;
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let sawKeyboard = false;

    const keyboardHeight = () => (vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0);

    const stopTyping = () => {
      clearInterval(watchdog);
      watchdog = undefined;
      sawKeyboard = false;
      root.classList.remove('trip-typing');
      root.style.removeProperty('--trip-vv-top');
      root.style.removeProperty('--trip-kb');
    };

    // Don't trust focus events alone: a field that disappears while focused (a re-render, a
    // closed pop-up) never fires focusout, and the bars stayed hidden. So also check, a few
    // times a second while "typing": is a field still focused and on the page, and is the
    // keyboard still up? If not, bring the bars back.
    const sync = () => {
      const el = document.activeElement;
      if (!isEditable(el) || !el.isConnected) { stopTyping(); return; }
      const kb = keyboardHeight();
      if (kb > 120) sawKeyboard = true;
      else if (sawKeyboard) stopTyping(); // keyboard went down but the field kept focus
    };

    const measure = () => {
      if (!vv) return;
      const top = vv.offsetTop;
      const kb = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
      root.style.setProperty('--trip-vv-top', `${Math.round(top)}px`);
      root.style.setProperty('--trip-kb', `${Math.round(kb)}px`);
    };

    const reveal = () => {
      const el = document.activeElement;
      if (!isEditable(el)) return;
      measure();
      const visTop = vv ? vv.offsetTop : 0;
      const visH = vv ? vv.height : window.innerHeight;
      const r = el.getBoundingClientRect();
      const margin = 12;
      if (r.top >= visTop + margin && r.bottom <= visTop + visH - margin) return; // already in view
      const target = visTop + Math.min(visH * 0.33, Math.max(margin, visH - r.height - margin));
      const delta = r.top - target;
      const sp = scrollParent(el);
      if (sp) sp.scrollBy({ top: delta, behavior: 'smooth' });
      else window.scrollBy({ top: delta, behavior: 'smooth' });
    };

    // The keyboard slides in over ~300 ms; check once it has settled, and again on any resize.
    const scheduleReveal = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(reveal, 320);
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!isEditable(e.target as Element)) return;
      clearTimeout(blurTimer);
      root.classList.add('trip-typing');
      sawKeyboard = false;
      clearInterval(watchdog);
      watchdog = setInterval(sync, 400);
      measure();
      scheduleReveal();
    };
    const onFocusOut = () => {
      clearTimeout(blurTimer);
      // Moving between two fields fires focusout then focusin: wait before showing the bars again.
      blurTimer = setTimeout(sync, 120);
    };
    const onViewport = () => {
      if (!root.classList.contains('trip-typing')) return;
      measure();
      sync();
      if (root.classList.contains('trip-typing')) scheduleReveal();
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', measure);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', measure);
      clearTimeout(blurTimer);
      clearTimeout(settleTimer);
      stopTyping();
    };
  }, []);
  return null;
}
