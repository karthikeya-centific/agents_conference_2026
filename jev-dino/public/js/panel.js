// ============================================================================
//  Live "Model I/O" panel: one entry per call with the exact request body,
//  the raw response, latency and the probabilities behind the decision.
// ============================================================================

const MAX_ENTRIES = 120;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Pretty-print JSON with light syntax colouring. */
export function highlightJson(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  if (text == null) text = '';
  return escapeHtml(text).replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      if (m.startsWith('"')) return m.endsWith(':') ? `<span class="jk">${m}</span>` : `<span class="js">${m}</span>`;
      if (/^(true|false|null)$/.test(m)) return `<span class="jb">${m}</span>`;
      return `<span class="jn">${m}</span>`;
    },
  );
}

const fmtMs = (ms) => (ms == null ? '—' : `${Math.round(ms).toLocaleString()} ms`);
const fmtUsd = (usd) => (usd == null ? '—' : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`);
const clock = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

export class IOPanel {
  constructor(root) {
    this.root = root;
    this.list = root.querySelector('#panelList');
    this.statsEl = root.querySelector('#panelStats');
    this.sessionEl = root.querySelector('#panelSession');
    this.hideRun = root.querySelector('#panelHideRun');
    this.pinLatest = root.querySelector('#panelPinLatest');
    this.autoscroll = true;
    this.entries = [];
    this.latest = null;

    root.querySelector('#panelClear').addEventListener('click', () => this.clear());
    this.hideRun.addEventListener('change', () => this.root.classList.toggle('hide-run', this.hideRun.checked));
    this.list.addEventListener('scroll', () => {
      const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
      this.autoscroll = nearBottom;
    });
  }

  setSession({ providerLabel, model, endpoint, method, stateFormat, cadence, note }) {
    this.sessionEl.innerHTML = `
      <div><span class="k">player</span> ${escapeHtml(providerLabel)}</div>
      <div><span class="k">model</span> <code>${escapeHtml(model)}</code></div>
      <div><span class="k">call</span> <code>${escapeHtml(method)} ${escapeHtml(endpoint)}</code></div>
      <div><span class="k">state</span> ${escapeHtml(stateFormat === 'text' ? 'plain text' : 'JSON object')} · stateless: the full state + rules go with every call</div>
      ${cadence ? `<div><span class="k">cadence</span> ${escapeHtml(cadence)}</div>` : ''}
      ${note ? `<div class="note">${escapeHtml(note)}</div>` : ''}`;
  }

  divider(text) {
    const el = document.createElement('div');
    el.className = 'io-divider';
    el.textContent = text;
    this.list.appendChild(el);
    this.trim();
    this.scrollToEnd();
  }

  begin({ n, provider, model, payload, state }) {
    const el = document.createElement('details');
    el.className = 'io-entry pending';
    el.open = Boolean(this.pinLatest.checked);
    const summaryText = summarizeState(state);
    el.innerHTML = `
      <summary>
        <span class="n">#${n}</span>
        <span class="act pending">…</span>
        <span class="lat">waiting</span>
        <span class="danger"></span>
        <span class="ctx">${escapeHtml(summaryText)}</span>
        <span class="time">${clock()}</span>
      </summary>
      <div class="io-body">
        <div class="io-cols">
          <section class="io-col">
            <h4>request <span class="arrow">→</span> <span class="meta req-meta">${escapeHtml(provider)} · ${escapeHtml(model)}</span></h4>
            <pre class="json">${highlightJson(payload)}</pre>
          </section>
          <section class="io-col">
            <h4>response <span class="arrow">←</span> <span class="meta res-meta">pending…</span></h4>
            <pre class="json res-json">(waiting for the model)</pre>
          </section>
        </div>
        <div class="io-probs"></div>
      </div>`;
    if (this.latest && this.pinLatest.checked) this.latest.open = false;
    this.latest = el;
    this.list.appendChild(el);
    this.entries.push(el);
    this.trim();
    this.scrollToEnd();
    return { el, n, startedAt: performance.now() };
  }

  complete(entry, { ok, error, stale, result, parsed, applied, totalMs, upstreamMs, stateAgeMs }) {
    const el = entry.el;
    el.classList.remove('pending');
    el.classList.add(ok ? 'ok' : 'error');
    if (stale) el.classList.add('stale');
    const action = parsed ? parsed.action : null;
    if (action) el.dataset.action = action;

    const actEl = el.querySelector('.act');
    actEl.className = `act ${action || 'err'}`;
    actEl.textContent = action ? action.toUpperCase() : 'ERROR';
    if (parsed && parsed.confidence != null) actEl.textContent += ` ${(parsed.confidence * 100).toFixed(0)}%`;

    el.querySelector('.lat').textContent = `${fmtMs(upstreamMs)}${stale ? ' · stale' : ''}`;
    const dangerEl = el.querySelector('.danger');
    if (parsed && parsed.danger && parsed.danger.score != null) {
      dangerEl.textContent = `danger ${Number(parsed.danger.score).toFixed(1)}`;
      dangerEl.dataset.level = String(Math.round(parsed.danger.score));
    }

    const meta = [];
    if (result && result.status) meta.push(`HTTP ${result.status}`);
    meta.push(`${fmtMs(upstreamMs)} upstream`);
    if (totalMs != null && Math.abs(totalMs - upstreamMs) > 2) meta.push(`${fmtMs(totalMs)} total`);
    if (stateAgeMs != null) meta.push(`state was ${fmtMs(stateAgeMs)} old when the answer landed`);
    if (result && result.request_id) meta.push(`id ${result.request_id}`);
    if (parsed && parsed.tokensIn) meta.push(`${parsed.tokensIn} tokens in`);
    if (applied) meta.push(`→ ${applied}`);
    el.querySelector('.res-meta').textContent = meta.join(' · ');

    const reqMeta = el.querySelector('.req-meta');
    if (result && result.url) reqMeta.textContent = `POST ${result.url}`;
    if (result && result.sent_headers) reqMeta.title = Object.entries(result.sent_headers).map(([k, v]) => `${k}: ${v}`).join('\n');

    const resJson = el.querySelector('.res-json');
    const body = result && result.response !== undefined ? result.response : (result || {});
    resJson.innerHTML = highlightJson(body) + (error ? `\n<span class="jerr">${escapeHtml(error)}</span>` : '');

    const probs = el.querySelector('.io-probs');
    probs.innerHTML = parsed ? renderProbabilities(parsed) : '';
    if (this.autoscroll) this.scrollToEnd();
  }

  updateStats(s) {
    if (!s) return;
    this.statsEl.innerHTML = `
      <div class="stat"><b>${s.calls}</b><span>calls</span></div>
      <div class="stat"><b>${s.callsPerSecond}</b><span>calls / s</span></div>
      <div class="stat"><b>${s.inFlight != null ? s.inFlight : '—'}</b><span>in flight</span></div>
      <div class="stat"><b>${fmtMs(s.lastLatencyMs)}</b><span>last</span></div>
      <div class="stat"><b>${fmtMs(s.avgLatencyMs)}</b><span>avg</span></div>
      <div class="stat"><b>${fmtMs(s.p50LatencyMs)}</b><span>p50</span></div>
      <div class="stat"><b>${fmtMs(s.maxLatencyMs)}</b><span>max</span></div>
      <div class="stat"><b>${s.tokensIn.toLocaleString()}</b><span>tokens in</span></div>
      <div class="stat"><b>${fmtUsd(s.costUsd)}</b><span>est. cost</span></div>
      <div class="stat ${s.errors ? 'bad' : ''}"><b>${s.errors}</b><span>errors</span></div>`;
  }

  clear() {
    this.list.innerHTML = '';
    this.entries = [];
    this.latest = null;
    this.statsEl.innerHTML = '';
  }

  trim() {
    while (this.entries.length > MAX_ENTRIES) {
      const old = this.entries.shift();
      old.remove();
    }
    while (this.list.children.length > MAX_ENTRIES + 10) this.list.firstElementChild.remove();
  }

  scrollToEnd() {
    if (!this.autoscroll) return;
    this.list.scrollTop = this.list.scrollHeight;
  }

  setCollapsed(collapsed) {
    this.root.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('panel-open', !collapsed);
  }

  get collapsed() { return this.root.classList.contains('collapsed'); }
}

function summarizeState(state) {
  const o = state && state.nearest_obstacle;
  if (!o) return 'no obstacle';
  const what = o.kind === 'pterodactyl' ? `ptero ${o.flying_height.split(' ')[0]}` : `${o.count > 1 ? o.count + '× ' : ''}${o.size} cactus`;
  let timing = '';
  if (o.jump_timing) timing = ` · ${o.jump_timing.split(' ')[0]}`;
  else if (o.time_to_spare_ms != null) timing = o.jump_still_possible_after_answer ? ` · ${o.time_to_spare_ms} ms spare` : ' · too late';
  return `#${o.id} ${what} · ${o.distance_px} px · ${o.arrives_in_ms} ms${timing}`;
}

export function renderProbabilities(parsed) {
  const rows = ['jump', 'duck', 'run'].map((k) => {
    const p = parsed.probabilities ? parsed.probabilities[k] || 0 : 0;
    return `<div class="prob ${k === parsed.action ? 'chosen' : ''}"><span class="lbl">${k}</span><span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span><span class="val">${(p * 100).toFixed(0)}%</span></div>`;
  });
  let extra = '';
  if (parsed.nextAction) {
    const np = parsed.nextProbabilities;
    extra += `<div class="next-action">next obstacle: <b>${escapeHtml(parsed.nextAction)}</b>${np ? ` (${['jump', 'duck', 'run'].map((k) => `${k} ${((np[k] || 0) * 100).toFixed(0)}%`).join(' · ')})` : ''}</div>`;
  }
  if (parsed.danger && parsed.danger.probabilities) {
    const d = parsed.danger;
    const cells = Object.keys(d.probabilities).sort().map((k) => `<span class="dcell" title="${escapeHtml(d.legend ? d.legend[k] : '')}"><i style="height:${(d.probabilities[k] * 100).toFixed(0)}%"></i><b>${k}</b></span>`).join('');
    extra = `<div class="danger-dist"><span class="lbl">danger ${Number(d.score).toFixed(2)}</span>${cells}</div>`;
  } else if (parsed.danger && parsed.danger.score != null) {
    extra = `<div class="danger-dist"><span class="lbl">danger ${parsed.danger.score}</span></div>`;
  }
  if (parsed.reason) extra += `<div class="reason">“${escapeHtml(parsed.reason)}”</div>`;
  if (parsed.reasoning) extra += `<details class="reasoning"><summary>model reasoning</summary><pre>${escapeHtml(parsed.reasoning)}</pre></details>`;
  return `<div class="probs">${rows.join('')}</div>${extra}`;
}
