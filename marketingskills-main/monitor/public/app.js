'use strict';

const list = document.querySelector('#service-list');
const connectionState = document.querySelector('#connection-state');
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function setConnectionState(connected) {
  connectionState.classList.toggle('is-connected', connected);
  connectionState.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'live-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = connected ? 'Live updates' : 'Reconnecting';
  connectionState.append(dot, label);
}

function formatTime(value) {
  if (!value) {
    return 'Not checked yet';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : dateFormatter.format(date);
}

function renderTarget(target) {
  const row = document.createElement('article');
  row.className = 'service-row';

  const status = document.createElement('span');
  status.className = `status-pill status-${target.status}`;
  status.textContent = target.status === 'up' ? 'Operational' :
    target.status === 'down' ? 'Issue detected' : 'Checking';

  const details = document.createElement('div');
  details.className = 'service-details';
  const name = document.createElement('h3');
  name.textContent = target.name;
  const url = document.createElement('p');
  url.className = 'service-url';
  url.textContent = target.url;
  details.append(name, url);

  const metrics = document.createElement('div');
  metrics.className = 'service-metrics';
  const latency = document.createElement('span');
  latency.textContent = target.responseTimeMs === null ? '—' : `${target.responseTimeMs} ms`;
  const checkedAt = document.createElement('time');
  checkedAt.dateTime = target.checkedAt ?? '';
  checkedAt.textContent = formatTime(target.checkedAt);
  metrics.append(latency, checkedAt);

  row.append(status, details, metrics);
  if (target.error) {
    const error = document.createElement('p');
    error.className = 'service-error';
    error.textContent = target.error;
    row.append(error);
  }
  return row;
}

function render(snapshot) {
  const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
  const up = targets.filter((target) => target.status === 'up').length;
  const down = targets.filter((target) => target.status === 'down').length;

  document.querySelector('#total-count').textContent = String(targets.length);
  document.querySelector('#up-count').textContent = String(up);
  document.querySelector('#down-count').textContent = String(down);
  document.querySelector('#last-updated').textContent = formatTime(snapshot.generatedAt);
  document.querySelector('#refresh-label').textContent =
    `Refresh interval: ${Math.round(snapshot.refreshIntervalMs / 1000)} seconds`;

  list.replaceChildren();
  if (targets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No endpoints configured. Copy config.example.json to targets.json and add your health-check URLs.';
    list.append(empty);
    return;
  }
  for (const target of targets) {
    list.append(renderTarget(target));
  }
}

async function refreshStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Status request failed with HTTP ${response.status}.`);
  }
  render(await response.json());
}

const events = new EventSource('/api/events');
events.onopen = () => setConnectionState(true);
events.onmessage = (event) => {
  try {
    render(JSON.parse(event.data));
  } catch (error) {
    console.error('Received invalid monitor status data.', error);
    void refreshStatus().catch((refreshError) => {
      console.error('Unable to refresh monitor status.', refreshError);
    });
  }
};
events.onerror = () => setConnectionState(false);

void refreshStatus().catch((error) => {
  list.replaceChildren();
  const message = document.createElement('p');
  message.className = 'empty-state error-state';
  message.textContent = `Unable to load monitor status: ${error.message}`;
  list.append(message);
  setConnectionState(false);
});
