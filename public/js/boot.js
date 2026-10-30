// public/js/boot.js — loaded synchronously in <head> (tiny, no dependencies).
// Marks the document as JS-capable before first paint so scroll-reveal styles
// only hide content when the script that reveals it is guaranteed to run.
document.documentElement.classList.add('js');
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('reduced-motion');
}
