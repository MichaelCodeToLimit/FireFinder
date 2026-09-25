// FireFinder developer console. Plain DOM, no dependencies.
// All server data is rendered with textContent, never innerHTML.

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  key: sessionStorage.getItem('firefinder:key') ?? '',
  clientId: getClientId(),
};

function getClientId() {
  let id = null;
  try {
    id = localStorage.getItem('firefinder:client-id');
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      id = `console-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      localStorage.setItem('firefinder:client-id', id);
    }
  } catch {
    id = 'console-ephemeral';
  }
  return id;
}

async function api(method, path, body) {
  const headers = { 'x-firefinder-client': state.clientId };
  if (state.key) headers['x-api-key'] = state.key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    const details = Array.isArray(error?.details) ? ` (${error.details.map((d) => `${d.path}: ${d.message}`).join('; ')})` : '';
    throw new Error(`${error?.message ?? `HTTP ${response.status}`}${details}`);
  }
  return data;
}

function formData(form) {
  const data = {};
  for (const [name, value] of new FormData(form)) {
    if (typeof value === 'string' && value.trim()) data[name] = value.trim();
  }
  return data;
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${name}${value === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

function notice(container, message, isError = false) {
  const div = document.createElement('div');
  div.className = `notice${isError ? ' error' : ''}`;
  div.textContent = message;
  container.replaceChildren(div);
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function renderTrust(el, solution) {
  el.replaceChildren(
    span('ok', `✓ Confirmed by ${solution.confirmation_count}`),
    document.createTextNode('   '),
    span('bad', `✕ Reported failed by ${solution.failure_count}`),
    document.createTextNode(`   ·   Last confirmed: ${timeAgo(solution.last_confirmed_at)}`),
  );
}

function renderBadge(el, solution) {
  const label = solution.status !== 'active' ? solution.status.replace('_', ' ') : solution.verification_status;
  el.className = `badge ${solution.status !== 'active' ? solution.status : solution.verification_status}`;
  el.textContent = label;
}

function card(solution) {
  const node = $('#card-template').content.firstElementChild.cloneNode(true);
  $('.fire', node).textContent = `🔥 FIRE #${solution.fire_number}`;
  renderBadge($('.badge', node), solution);
  if (typeof solution.similarity === 'number') {
    $('.scores', node).textContent = `similarity ${solution.similarity.toFixed(2)} · score ${solution.score.toFixed(2)}`;
  }
  $('.problem', node).textContent = solution.problem;
  $('.error', node).textContent = solution.error_message ?? '';
  $('.solution', node).textContent = solution.solution;

  const env = [solution.software && `${solution.software}${solution.software_version ? ` ${solution.software_version}` : ''}`, solution.operating_system]
    .filter(Boolean)
    .join(' · ');
  const match = solution.environment_match
    ? Object.entries(solution.environment_match)
        .filter(([, level]) => level !== 'unknown')
        .map(([field, level]) => `${field.replace('_', ' ')}: ${level.replace('_', ' ')}`)
        .join(', ')
    : '';
  $('.env', node).textContent = [env, match && `(${match})`].filter(Boolean).join(' ');
  renderTrust($('.trust', node), solution);

  const feedback = $('.feedback', node);
  const vote = (action) => async () => {
    feedback.textContent = 'Saving…';
    try {
      const result = await api('POST', `/solutions/${solution.id}/${action}`, {});
      renderTrust($('.trust', node), result.solution);
      renderBadge($('.badge', node), result.solution);
      feedback.textContent =
        result.outcome === 'duplicate' ? 'Already counted from this browser.' : action === 'confirm' ? 'Confirmation recorded.' : 'Failure report recorded.';
    } catch (error) {
      feedback.textContent = error.message;
    }
  };
  $('.worked', node).addEventListener('click', vote('confirm'));
  $('.failed', node).addEventListener('click', vote('report'));
  return node;
}

// --- Tabs -------------------------------------------------------------------
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-tab]')) other.setAttribute('aria-selected', String(other === tab));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    if (tab.dataset.tab === 'recent') loadRecent();
  });
}

// --- API key ----------------------------------------------------------------
$('#api-key').value = state.key;
$('#save-key').addEventListener('click', () => {
  state.key = $('#api-key').value.trim();
  sessionStorage.setItem('firefinder:key', state.key);
  $('#save-key').textContent = 'Saved ✓';
  setTimeout(() => ($('#save-key').textContent = 'Use key'), 1200);
});

// --- Search -----------------------------------------------------------------
$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const results = $('#search-results');
  $('#search-meta').textContent = 'Searching…';
  try {
    const response = await api('POST', '/search', formData(event.target));
    $('#search-meta').textContent = `${response.results.length} result(s) in ${response.took_ms} ms`;
    if (response.results.length === 0) {
      notice(results, 'No previously solved problem matches yet. Solve it, then submit the fix so the next person finds it.');
    } else {
      results.replaceChildren(...response.results.map(card));
    }
  } catch (error) {
    $('#search-meta').textContent = '';
    notice(results, error.message, true);
  }
});

// --- Submit -----------------------------------------------------------------
$('#submit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const output = $('#submit-result');
  const body = formData(event.target);
  body.worked = event.target.elements.worked.checked;
  try {
    const result = await api('POST', '/solutions', { ...body, source: 'console' });
    const messages = {
      created: 'Saved as a new fire.',
      merged: 'Already known — your confirmation was added to the existing solution.',
      duplicate: 'Already known — nothing new recorded.',
    };
    const redacted = result.redactions.length ? ` Redacted before saving: ${result.redactions.join(', ')}.` : '';
    const message = document.createElement('div');
    message.className = 'notice';
    message.textContent = messages[result.outcome] + redacted;
    output.replaceChildren(message, card(result.solution));
    if (result.outcome === 'created') event.target.reset();
  } catch (error) {
    notice(output, error.message, true);
  }
});

// --- Recent -----------------------------------------------------------------
async function loadRecent() {
  const output = $('#recent-results');
  try {
    const { solutions } = await api('GET', '/solutions?limit=25');
    if (solutions.length === 0) notice(output, 'No fires yet.');
    else output.replaceChildren(...solutions.map(card));
  } catch (error) {
    notice(output, error.message, true);
  }
}
$('#load-recent').addEventListener('click', loadRecent);

// --- Health -----------------------------------------------------------------
api('GET', '/health')
  .then((health) => {
    $('#status').textContent = `API v${health.version} · ${health.embedding_model}`;
    $('#status').className = 'status ok';
  })
  .catch(() => {
    $('#status').textContent = 'API unreachable';
    $('#status').className = 'status down';
  });
