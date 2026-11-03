const $ = id => document.getElementById(id);
const config = window.BIRD_LOG_CONFIG;
const isDemo = !config.firebase || config.firebase.apiKey.startsWith('PASTE');
const OFFLINE = 'No connection, so this was not saved. Try again when you have signal.';

let birds = [];
let sort = 'number';
let editing = null;
let deleteArmed = false;
let store;

/* Storage: Firebase for real use, this device only for the demo. */

function demoStore() {
  const KEY = 'bird-log-demo';
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem(KEY)) || []; } catch { rows = []; }
  let listener = () => {};
  const commit = () => {
    try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch { /* still works for this visit */ }
    listener(rows.slice());
  };
  return {
    start(onBirds, onReady) {
      listener = onBirds;
      onReady(true);
      listener(rows.slice());
    },
    async add(bird) {
      if (rows.some(b => b.number === bird.number)) throw new Error('taken');
      rows.push({ ...bird, createdAt: Date.now() });
      commit();
    },
    async update(number, changes) {
      rows = rows.map(b => (b.number === number ? { ...b, ...changes } : b));
      commit();
    },
    async remove(number) {
      rows = rows.filter(b => b.number !== number);
      commit();
    },
  };
}

async function firebaseStore() {
  const fb = await import('./firebase-bundle.js');
  const app = fb.initializeApp(config.firebase);
  const auth = fb.getAuth(app);
  const db = fb.initializeFirestore(app, {
    localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }),
  });
  if (config.emulator) {
    fb.connectAuthEmulator(auth, `http://${config.emulator}:9099`, { disableWarnings: true });
    fb.connectFirestoreEmulator(db, config.emulator, 8080);
  }
  const ref = number => fb.doc(db, 'birds', String(number));
  const online = work => {
    if (!navigator.onLine) return Promise.reject(new Error('offline'));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('offline')), 12000);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };
  let unsubscribe = () => {};

  return {
    signIn: (email, password) => fb.signInWithEmailAndPassword(auth, email, password),
    start(onBirds, onReady, onError) {
      fb.onAuthStateChanged(auth, user => {
        unsubscribe();
        onReady(Boolean(user));
        if (!user) return;
        unsubscribe = fb.onSnapshot(fb.collection(db, 'birds'), snapshot => {
          onBirds(snapshot.docs.map(d => {
            const data = d.data({ serverTimestamps: 'estimate' });
            return { ...data, createdAt: data.createdAt?.toMillis?.() ?? Date.now() };
          }));
        }, onError);
      });
    },
    // The transaction makes the number check and the save one step,
    // so two phones can never claim the same number.
    add: bird => online(fb.runTransaction(db, async tx => {
      const existing = await tx.get(ref(bird.number));
      if (existing.exists()) throw new Error('taken');
      tx.set(ref(bird.number), { ...bird, createdAt: fb.serverTimestamp() });
    })),
    update: (number, changes) => online(fb.runTransaction(db, async tx => {
      tx.update(ref(number), changes);
    })),
    remove: number => online(fb.runTransaction(db, async tx => {
      tx.delete(ref(number));
    })),
  };
}

/* List */

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function matches(bird, query) {
  if (!query) return true;
  if (/^#?\d+$/.test(query)) return String(bird.number).includes(query.replace('#', ''));
  return `${bird.name} ${bird.note || ''}`.toLowerCase().includes(query);
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const shown = birds.filter(b => matches(b, query)).sort((a, b) => (
    sort === 'number' ? a.number - b.number : b.createdAt - a.createdAt
  ));

  $('count').textContent = `${birds.length} ${birds.length === 1 ? 'bird' : 'birds'}`;
  $('list').replaceChildren(...shown.map(bird => {
    const item = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bird';
    const ring = document.createElement('span');
    ring.className = 'ring';
    ring.textContent = bird.number;
    const body = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'bird-name';
    name.textContent = bird.name;
    const meta = document.createElement('span');
    meta.className = 'bird-meta';
    meta.textContent = [dateFormat.format(bird.createdAt), bird.note].filter(Boolean).join(', ');
    body.append(name, meta);
    row.append(ring, body);
    row.addEventListener('click', () => openSheet({ bird }));
    item.append(row);
    return item;
  }));
  renderEmpty(query, shown.length);
}

function renderEmpty(query, shownCount) {
  const empty = $('empty');
  empty.hidden = shownCount > 0;
  if (shownCount > 0) return;

  const message = document.createElement('p');
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'primary';
  const raw = $('search').value.trim();
  const number = /^#?\d+$/.test(query) ? Number(query.replace('#', '')) : null;

  if (!birds.length) {
    message.textContent = 'No birds yet. Log the first one and give it any number you like.';
    action.textContent = 'Log a bird';
    action.addEventListener('click', () => openSheet());
  } else if (number) {
    message.textContent = `Number ${number} is free.`;
    action.textContent = `Log bird ${number}`;
    action.addEventListener('click', () => openSheet({ number }));
  } else {
    message.textContent = `No bird matches “${raw}”, so this may be a new one.`;
    action.textContent = 'Log it as a new bird';
    action.addEventListener('click', () => openSheet({ name: raw }));
  }
  empty.replaceChildren(message, action);
}

function setSort(next) {
  sort = next;
  $('sort-number').setAttribute('aria-pressed', String(next === 'number'));
  $('sort-newest').setAttribute('aria-pressed', String(next === 'newest'));
  render();
}

/* Add and edit */

function readNumber() {
  const value = $('bird-number').value.trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

function updateNumberStatus() {
  if (editing) return;
  const status = $('number-status');
  const number = readNumber();
  const taken = birds.find(b => b.number === number);
  status.className = 'status';
  if ($('bird-number').value.trim() === '') {
    status.textContent = 'Pick any free number.';
  } else if (!number) {
    status.textContent = 'Use a whole number from 1 upwards.';
    status.classList.add('taken');
  } else if (taken) {
    status.textContent = `${number} is taken: ${taken.name}`;
    status.classList.add('taken');
  } else {
    status.textContent = `${number} is free.`;
    status.classList.add('free');
  }
  updateSave();
}

function updateSave() {
  const hasName = $('bird-name').value.trim() !== '';
  const number = readNumber();
  const numberOk = editing || (number && !birds.some(b => b.number === number));
  $('save').disabled = !(hasName && numberOk);
}

function openSheet({ bird = null, number = '', name = '' } = {}) {
  editing = bird;
  deleteArmed = false;
  $('form-error').textContent = '';
  $('sheet-title').textContent = bird ? `Bird ${bird.number}` : 'Log a bird';
  $('number-field').hidden = Boolean(bird);
  $('number-status').hidden = Boolean(bird);
  $('delete').hidden = !bird;
  $('delete').textContent = 'Delete bird';
  $('save').textContent = bird ? 'Save changes' : 'Save bird';
  $('bird-number').value = bird ? '' : number;
  $('bird-name').value = bird ? bird.name : name;
  $('bird-note').value = bird?.note || '';
  updateNumberStatus();
  updateSave();
  $('sheet').showModal();
  if (!bird) $(number ? 'bird-name' : 'bird-number').focus();
}

function failureText(error) {
  if (error.message === 'taken') return 'That number was just taken. Pick another one.';
  if (error.message === 'offline' || error.code === 'unavailable') return OFFLINE;
  if (error.code === 'permission-denied') return 'This account cannot change the log. Sign in again.';
  return 'The bird could not be saved. Try again.';
}

async function save(event) {
  event.preventDefault();
  if ($('save').disabled) return;
  const name = $('bird-name').value.trim();
  const note = $('bird-note').value.trim();
  $('save').disabled = true;
  $('form-error').textContent = '';
  try {
    if (editing) await store.update(editing.number, { name, note });
    else await store.add({ number: readNumber(), name, note });
    $('sheet').close();
    $('search').value = '';
    render();
  } catch (error) {
    $('form-error').textContent = failureText(error);
    updateSave();
  }
}

async function removeBird() {
  if (!deleteArmed) {
    deleteArmed = true;
    $('delete').textContent = `Tap again to delete bird ${editing.number}`;
    return;
  }
  try {
    await store.remove(editing.number);
    $('sheet').close();
  } catch (error) {
    $('form-error').textContent = failureText(error);
  }
}

/* Start */

async function start() {
  store = isDemo ? demoStore() : await firebaseStore();
  $('demo-note').hidden = !isDemo;

  $('search').addEventListener('input', render);
  $('sort-number').addEventListener('click', () => setSort('number'));
  $('sort-newest').addEventListener('click', () => setSort('newest'));
  $('log-bird').addEventListener('click', () => openSheet());
  $('cancel').addEventListener('click', () => $('sheet').close());
  $('bird-number').addEventListener('input', updateNumberStatus);
  $('bird-name').addEventListener('input', updateSave);
  $('bird-form').addEventListener('submit', save);
  $('delete').addEventListener('click', removeBird);

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('login-error').textContent = '';
    try {
      await store.signIn($('login-email').value.trim(), $('login-password').value);
    } catch {
      $('login-error').textContent = 'Email or password is wrong, or there is no connection.';
    }
  });

  store.start(next => {
    birds = next;
    render();
    if ($('sheet').open) updateNumberStatus();
  }, signedIn => {
    $('login').hidden = signedIn;
    $('main').hidden = !signedIn;
  }, () => {
    $('login').hidden = false;
    $('main').hidden = true;
    $('login-error').textContent = 'This account cannot open the log.';
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
