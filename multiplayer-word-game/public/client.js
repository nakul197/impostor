const socket = io();
let myToken = sessionStorage.getItem('impostorToken') || null;
let roomCode = sessionStorage.getItem('impostorCode') || null;
let myName = sessionStorage.getItem('impostorName') || '';
let isHost = false;
let timerInt = null;
let didAutoRejoin = false;

function getToken() {
  if (!myToken) {
    myToken = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('impostorToken', myToken);
  }
  return myToken;
}

function saveSession(code, name) {
  roomCode = code;
  sessionStorage.setItem('impostorCode', code);
  sessionStorage.setItem('impostorToken', getToken());
  if (name) {
    myName = name;
    sessionStorage.setItem('impostorName', name);
  }
}

socket.on('connect', () => {
  document.getElementById('connDot').classList.add('on');
  // refresh recovery: same tab still has code+token in sessionStorage
  if (!didAutoRejoin && roomCode && myToken) {
    didAutoRejoin = true;
    socket.emit('rejoin-game', { code: roomCode, token: myToken });
  }
});
socket.on('disconnect', () => {
  document.getElementById('connDot').classList.remove('on');
});

const $ = (id) => document.getElementById(id);
const screens = ['screen-home', 'screen-lobby', 'screen-word', 'screen-discuss', 'screen-vote', 'screen-results'];
function show(id) {
  screens.forEach((s) => $(s).classList.toggle('active', s === id));
  window.scrollTo(0, 0);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

// prefill name after refresh
if (myName) {
  $('createName').value = myName;
  $('joinName').value = myName;
}
if (roomCode) $('joinCode').value = roomCode;

$('btnCreate').onclick = () => {
  const name = $('createName').value.trim() || 'Host';
  socket.emit('create-game', { name, token: getToken() });
  myName = name;
};
$('btnJoin').onclick = () => {
  const name = $('joinName').value.trim() || 'Player';
  const code = $('joinCode').value.trim().toUpperCase();
  if (!code) return toast('Enter a room code.');
  socket.emit('join-game', { code, name, token: getToken() });
  myName = name;
};
$('btnLeave').onclick = () => {
  sessionStorage.removeItem('impostorCode');
  sessionStorage.removeItem('impostorToken');
  sessionStorage.removeItem('impostorName');
  location.reload();
};
$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(roomCode); toast('Code copied.'); }
  catch { toast(roomCode); }
};
$('btnStart').onclick = () => socket.emit('start-game', { code: roomCode, difficulty: $('difficulty').value });
$('btnToDiscuss').onclick = () => { show('screen-discuss'); startTimer(60); };
$('btnToVote').onclick = () => { clearInterval(timerInt); show('screen-vote'); };
$('btnNext').onclick = () => socket.emit('next-round', { code: roomCode });

function renderPlayers(players) {
  const list = $('playerList');
  list.innerHTML = '';
  $('playerCount').textContent = players.length;
  players.forEach((p) => {
    const li = document.createElement('li');
    if (p.connected === false) li.style.opacity = '0.45';
    const left = document.createElement('span');
    left.textContent = `${p.name}${p.id === myToken ? ' (you)' : ''}${p.connected === false ? ' · offline' : ''} · ${p.score || 0} pts`;
    li.appendChild(left);
    if (p.isHost) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'HOST';
      li.appendChild(b);
    }
    list.appendChild(li);
  });
  const me = players.find((p) => p.id === myToken);
  isHost = !!(me && me.isHost);
  $('btnStart').disabled = !isHost;
  $('diffWrap').style.display = isHost ? '' : 'none';
  $('lobbyHint').textContent = isHost
    ? 'You are host. Need at least 3 connected to start.'
    : 'Waiting for host to start…';
  renderVoteList(players);
}

function renderVoteList(players) {
  const list = $('voteList');
  list.innerHTML = '';
  players.filter((p) => p.id !== myToken && p.connected !== false).forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.onclick = () => {
      list.querySelectorAll('li').forEach((el) => el.classList.remove('picked'));
      li.classList.add('picked');
      socket.emit('submit-vote', { code: roomCode, votedId: p.id });
      $('voteStatus').textContent = `Voted for ${p.name}. Waiting for others…`;
    };
    list.appendChild(li);
  });
}

function startTimer(secs) {
  clearInterval(timerInt);
  let s = secs;
  const el = $('timer');
  const tick = () => {
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (s <= 0) { clearInterval(timerInt); show('screen-vote'); }
    s--;
  };
  tick();
  timerInt = setInterval(tick, 1000);
}

function handleJoined({ code, token, players }) {
  if (token) {
    myToken = token;
    sessionStorage.setItem('impostorToken', token);
  }
  saveSession(code, $('createName').value.trim() || $('joinName').value.trim() || myName);
  $('roomCode').textContent = code;
  renderPlayers(players);
  // stay on current mid-round screen if server is resending state right after;
  // default to lobby (round-started / round-results events will move us forward)
  if ($('screen-lobby').classList.contains('active') || document.querySelector('.screen.active') === $('screen-home')) {
    show('screen-lobby');
  } else {
    renderPlayers(players);
  }
  show('screen-lobby');
}

socket.on('game-created', handleJoined);
socket.on('game-joined', handleJoined);
socket.on('players-updated', ({ players }) => renderPlayers(players));
socket.on('rejoin-failed', () => {
  sessionStorage.removeItem('impostorCode');
  sessionStorage.removeItem('impostorToken');
  roomCode = null;
  show('screen-home');
  toast('Could not rejoin. Room may have closed.');
});

socket.on('round-started', ({ code, isImpostor, word, hints, difficulty, players }) => {
  saveSession(code);
  renderPlayers(players);
  const card = $('wordCard');
  if (isImpostor) {
    card.innerHTML = `<p class="kicker" style="margin-top:0">You are the IMPOSTOR</p>
      <div class="secret">???</div>
      <p class="muted">You get hints only. Blend in.</p>
      <ul>${hints.map((h) => `<li>${h}</li>`).join('')}</ul>
      <p class="muted small">Difficulty: ${difficulty}</p>`;
    $('discussHint').textContent = 'You are the impostor. Stay vague, agree a lot, deflect.';
  } else {
    card.innerHTML = `<p class="kicker" style="margin-top:0">Your word — keep it secret</p>
      <div class="secret">${word}</div>
      <p class="muted">Describe it vaguely. Never say it. Difficulty: ${difficulty}</p>`;
    $('discussHint').textContent = `Describe "${word}" vaguely. Never say it out loud.`;
  }
  show('screen-word');
});

socket.on('votes-updated', ({ count, total }) => {
  $('voteStatus').textContent = `Votes in: ${count}/${total}`;
});

socket.on('round-results', ({ word, difficulty, impostorName, caught, votedOutId, tied, players }) => {
  if (players) renderPlayers(players);
  const names = Object.fromEntries((players || []).map((p) => [p.id, p.name]));
  const votedName = tied ? 'Tie — no one' : (names[votedOutId] || '—');
  const board = [...(players || [])].sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((p) => `<li><span>${p.name}</span><span>${p.score || 0} pts</span></li>`).join('');
  $('resultsCard').innerHTML = `
    <div class="secret">${caught ? 'Caught!' : 'Escaped!'}</div>
    <p>The word was <strong>${word}</strong> (${difficulty}). Impostor was <strong>${impostorName}</strong>.</p>
    <p class="muted">Voted out: ${votedName} · ${caught ? 'Crew +1 each.' : 'Impostor +2.'}</p>
    <ul class="players">${board}</ul>`;
  $('btnNext').style.display = isHost ? '' : 'none';
  show('screen-results');
});

socket.on('back-to-lobby', ({ players }) => {
  renderPlayers(players);
  show('screen-lobby');
});

socket.on('error-msg', (msg) => toast(msg));
