import { initUI } from './ui.js';

initUI().catch((err) => {
  console.error(err);
  const el = document.createElement('div');
  el.className = 'fatal';
  el.textContent = `The demo could not start: ${err.message}`;
  document.body.prepend(el);
});
