// public/js/boot.js — loaded synchronously in <head> (tiny, no dependencies).
// Runs before first paint so the page never flashes the wrong theme, and marks
// the document as JS-capable so scroll-reveal styles only hide content when the
// script that reveals it is guaranteed to run.
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('reduced-motion');
  }

  var KEY = 'shereboy_theme';
  var COLORS = { dark: '#0b0f17', light: '#ffffff' };
  var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var listeners = [];

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) { return 'system'; }
  }
  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return systemDark && !systemDark.matches ? 'light' : 'dark';
  }
  function apply() {
    var pref = stored();
    var theme = resolve(pref);
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
    listeners.forEach(function (fn) { fn(theme, pref); });
  }

  window.shereboyTheme = {
    current: function () { return resolve(stored()); },
    preference: stored,
    set: function (pref) {
      try {
        if (pref === 'light' || pref === 'dark') localStorage.setItem(KEY, pref);
        else localStorage.removeItem(KEY);
      } catch (e) { /* the choice just won't be remembered */ }
      apply();
    },
    toggle: function () { this.set(resolve(stored()) === 'dark' ? 'light' : 'dark'); },
    onChange: function (fn) { listeners.push(fn); fn(resolve(stored()), stored()); }
  };

  apply();
  if (systemDark && systemDark.addEventListener) systemDark.addEventListener('change', apply);
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });

  // Every theme button on the page, in the public site and the admin dashboard
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (btn) window.shereboyTheme.toggle();
  });
  document.addEventListener('DOMContentLoaded', function () {
    window.shereboyTheme.onChange(function (theme) {
      var label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
        b.setAttribute('aria-label', label);
        b.setAttribute('title', label);
      });
    });
  });
})();
