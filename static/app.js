(() => {
  const app = document.getElementById('app');
  const PIECES = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟︎'
  };
  const files = 'abcdefgh';
  let audioCtx = null;

  function makeToken() {
    return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-${Math.random()}`).replaceAll(':', '-');
  }

  function tokenFor(room) {
    const key = `chess-token:${room}`;
    let t = localStorage.getItem(key);
    if (!t) {
      t = makeToken();
      localStorage.setItem(key, t);
    }
    return t;
  }

  function beep(kind = 'move') {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      const freq = kind === 'capture' ? 245 : kind === 'game_over' ? 165 : kind === 'draw_offer' ? 510 : kind === 'thinking' ? 315 : 390;
      o.type = kind === 'game_over' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.10, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'game_over' ? 0.45 : 0.14));
      o.start(now); o.stop(now + (kind === 'game_over' ? 0.47 : 0.16));
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function parseFen(fen) {
    const board = {};
    const ranks = fen.split(' ')[0].split('/');
    ranks.forEach((row, ri) => {
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) file += Number(ch);
        else { board[files[file] + (8 - ri)] = ch; file++; }
      }
    });
    return board;
  }

  function formatClock(ms) {
    ms = Math.max(0, ms || 0);
    if (ms < 10000) {
      const seconds = Math.max(0, ms / 1000);
      return seconds.toFixed(1);
    }
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function showToast(text) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function home() {
    const savedName = localStorage.getItem('chess-name') || '';
    app.innerHTML = `
      <main class="shell home">
        <section class="home-card glass">
          <div class="brand">
            <div class="brand-mark">♞</div>
            <div><h1>Glass Chess</h1><p>Modern chess, your way.</p></div>
          </div>

          <div class="hero-copy">
            <h2>Play solo or challenge a friend.</h2>
            <p>Choose computer mode for an instant game, or create an online room and share the invite link.</p>
          </div>

          <div class="mode-grid" role="group" aria-label="Game mode">
            <button class="mode-card active" data-mode="ai" type="button">
              <span class="mode-icon">✦</span><span class="mode-title">Play vs Computer</span>
              <span class="mode-desc">Start immediately. No second player required.</span>
            </button>
            <button class="mode-card" data-mode="pvp" type="button">
              <span class="mode-icon">⌁</span><span class="mode-title">Play Online</span>
              <span class="mode-desc">Create a private room and invite a friend.</span>
            </button>
          </div>

          <form id="createForm" class="form-grid">
            <div class="field full"><label>Your name<input id="name" maxlength="24" required value="${escapeHtml(savedName)}" placeholder="e.g. Ahmad" autocomplete="nickname"></label></div>
            <div class="field"><label>Clock<select id="minutes"><option value="3">3 minutes</option><option value="5">5 minutes</option><option value="10" selected>10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option></select></label></div>
            <div class="field ai-only"><label>Difficulty<select id="difficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></label></div>
            <div class="field ai-only"><label>Your color<select id="color"><option value="white" selected>White</option><option value="black">Black</option><option value="random">Random</option></select></label></div>
            <div class="form-actions">
              <button id="createButton" class="btn primary" type="submit">Play vs Computer</button>
              <span class="hint" id="modeHint">The computer runs on your Python server.</span>
            </div>
          </form>

          <div style="height:1px;background:var(--line);margin:22px 0 17px"></div>
          <form id="joinForm" class="form-grid">
            <div class="field full"><label>Have a room code?<input id="joinCode" maxlength="12" placeholder="Example: A7X92K" autocomplete="off"></label></div>
            <div class="form-actions"><button class="btn outline" type="submit">Join online game</button><span class="hint">Or simply open the invite link your friend sent you.</span></div>
          </form>
          <div id="homeError"></div>
        </section>
      </main>`;

    let mode = 'ai';
    const nameEl = document.getElementById('name');
    const createButton = document.getElementById('createButton');
    const hint = document.getElementById('modeHint');

    function setMode(next) {
      mode = next;
      document.querySelectorAll('.mode-card').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
      document.querySelectorAll('.ai-only').forEach(el => el.style.display = mode === 'ai' ? '' : 'none');
      createButton.textContent = mode === 'ai' ? 'Play vs Computer' : 'Create online room';
      hint.textContent = mode === 'ai' ? 'The computer runs on your Python server.' : 'You will get a private invite link for your friend.';
    }

    document.querySelectorAll('.mode-card').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
    setMode('ai');

    document.getElementById('createForm').addEventListener('submit', async e => {
      e.preventDefault();
      const errorBox = document.getElementById('homeError');
      errorBox.innerHTML = '';
      const name = nameEl.value.trim() || 'Player';
      localStorage.setItem('chess-name', name);
      const token = makeToken();
      createButton.disabled = true;
      createButton.textContent = 'Creating…';
      try {
        const res = await fetch('/api/rooms', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            name, token,
            minutes: Number(document.getElementById('minutes').value),
            mode,
            difficulty: document.getElementById('difficulty').value,
            color: document.getElementById('color').value
          })
        });
        if (!res.ok) throw new Error('Could not create the game.');
        const data = await res.json();
        localStorage.setItem(`chess-token:${data.room}`, token);
        location.href = data.url;
      } catch (err) {
        errorBox.innerHTML = `<div class="error">${escapeHtml(err.message || 'Could not create the game.')}</div>`;
        createButton.disabled = false;
        setMode(mode);
      }
    });

    document.getElementById('joinForm').addEventListener('submit', e => {
      e.preventDefault();
      const code = document.getElementById('joinCode').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!code) return showToast('Enter the room code first.');
      const name = nameEl.value.trim() || 'Player';
      localStorage.setItem('chess-name', name);
      location.href = `/game/${encodeURIComponent(code)}`;
    });
  }

  function game(room) {
    let ws = null;
    let state = null;
    let selected = null;
    let flipped = false;
    let soundOn = true;
    let baseWhite = 0;
    let baseBlack = 0;
    let baselineAt = performance.now();
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let intentionalClose = false;
    let lastResultKey = '';
    let dismissedResultKey = '';

    app.innerHTML = `
      <main class="shell">
        <section class="game-grid">
          <div class="game-main">
            <div class="topbar">
              <div class="pill-row">
                <span class="room-pill">Room <strong>${escapeHtml(room)}</strong></span>
                <span id="role" class="role-pill">Connecting…</span>
                <span id="modePill" class="mode-pill">Game</span>
              </div>
              <div class="invite-row">
                <button id="copyLink" class="btn outline" type="button">Copy invite</button>
                <button id="homeBtn" class="btn ghost" type="button">New game</button>
              </div>
            </div>

            <div id="topPlayer" class="player-strip glass"></div>
            <div class="board-wrap"><div id="board" class="board" aria-label="Chess board"></div></div>
            <div id="bottomPlayer" class="player-strip glass"></div>
          </div>

          <aside class="side glass">
            <div class="side-head">
              <div><div id="status" class="status">Connecting…</div><div id="substatus" class="substatus">Room ${escapeHtml(room)}</div></div>
            </div>
            <div class="actions">
              <button id="flip" class="btn outline" type="button">Flip board</button>
              <button id="sound" class="btn outline" type="button">Sound: On</button>
              <button id="draw" class="btn" type="button">Offer draw</button>
              <button id="resign" class="btn danger" type="button">Resign</button>
              <button id="rematch" class="btn primary wide" type="button" hidden>Play again</button>
            </div>
            <div id="drawBox"></div>
            <div id="spectators" class="spectators"></div>
            <div class="history">
              <div class="history-head"><h3>Move history</h3><span id="moveCount" class="hint">0 moves</span></div>
              <div id="moves" class="moves"></div>
            </div>
          </aside>
        </section>
      </main>
      <div id="promo"></div>
      <div id="resultModal"></div>`;

    const boardEl = document.getElementById('board');

    function send(action, extra = {}) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({action, ...extra}));
    }

    function orientation() {
      if (!state) return 'white';
      if (state.role === 'black') return flipped ? 'white' : 'black';
      return flipped ? 'black' : 'white';
    }

    function squareOrder() {
      const orient = orientation();
      const ranks = orient === 'white' ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
      const fs = orient === 'white' ? [...files] : [...files].reverse();
      const out = [];
      for (const r of ranks) for (const f of fs) out.push(f + r);
      return out;
    }

    function legalFrom(sq) {
      return (state?.legal_moves || []).filter(m => m.slice(0,2) === sq);
    }

    function renderBoard() {
      if (!state) return;
      const pieces = parseFen(state.fen);
      const targets = selected ? legalFrom(selected) : [];
      const orient = orientation();
      const last = state.uci_moves?.length ? state.uci_moves[state.uci_moves.length - 1] : '';
      const lastFrom = last.slice(0,2), lastTo = last.slice(2,4);
      boardEl.innerHTML = '';

      for (const sq of squareOrder()) {
        const f = files.indexOf(sq[0]);
        const r = Number(sq[1]);
        const light = (f + r) % 2 === 1;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `sq ${light ? 'light' : 'dark'}`;
        b.dataset.sq = sq;
        b.setAttribute('aria-label', sq);
        if (sq === selected) b.classList.add('selected');
        if (sq === lastFrom || sq === lastTo) b.classList.add('last-move');
        const movesTo = targets.filter(m => m.slice(2,4) === sq);
        if (movesTo.length) {
          b.classList.add('target');
          if (pieces[sq]) b.classList.add('capture');
        }
        const p = pieces[sq];
        if (p) b.innerHTML = `<span class="piece" aria-hidden="true">${PIECES[p]}</span>`;

        const isBottom = orient === 'white' ? sq[1] === '1' : sq[1] === '8';
        const isLeft = orient === 'white' ? sq[0] === 'a' : sq[0] === 'h';
        if (isBottom) b.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
        if (isLeft) b.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
        b.addEventListener('click', () => onSquare(sq, pieces));
        boardEl.appendChild(b);
      }
    }

    function colorOf(piece) { return piece ? (piece === piece.toUpperCase() ? 'white' : 'black') : null; }

    function onSquare(sq, pieces) {
      if (!state || state.result || state.role === 'spectator' || state.ai_thinking) return;
      const piece = pieces[sq];
      if (!selected) {
        if (piece && colorOf(piece) === state.role && state.turn === state.role && legalFrom(sq).length) {
          selected = sq; renderBoard();
        }
        return;
      }
      if (sq === selected) { selected = null; renderBoard(); return; }
      const choices = legalFrom(selected).filter(m => m.slice(2,4) === sq);
      if (choices.length) {
        const promos = choices.filter(m => m.length === 5);
        if (promos.length) return promotionModal(selected, sq, promos);
        send('move', {from:selected, to:sq});
        selected = null; renderBoard();
        return;
      }
      if (piece && colorOf(piece) === state.role && legalFrom(sq).length) { selected = sq; renderBoard(); }
      else { selected = null; renderBoard(); }
    }

    function promotionModal(from, to, moves) {
      const chars = state.role === 'white' ? {q:'♕',r:'♖',b:'♗',n:'♘'} : {q:'♛',r:'♜',b:'♝',n:'♞'};
      const el = document.getElementById('promo');
      el.innerHTML = `<div class="modal-backdrop"><div class="modal glass"><h2>Choose promotion</h2><p>Select the piece for your pawn.</p><div class="promo-grid">${['q','r','b','n'].map(x => `<button class="promo" data-p="${x}" type="button">${chars[x]}</button>`).join('')}</div></div></div>`;
      el.querySelectorAll('[data-p]').forEach(btn => btn.addEventListener('click', () => {
        const p = btn.dataset.p;
        if (moves.some(m => m === from + to + p)) send('move', {from, to, promotion:p});
        selected = null; el.innerHTML = ''; renderBoard();
      }));
    }

    function clockValues() {
      if (!state) return [0,0];
      let w = baseWhite, b = baseBlack;
      if (state.clock_running && !state.result) {
        const elapsed = performance.now() - baselineAt;
        if (state.turn === 'white') w = Math.max(0, w - elapsed);
        else b = Math.max(0, b - elapsed);
      }
      return [w,b];
    }

    function playerHtml(color, values) {
      const p = state[color];
      const active = state.clock_running && state.turn === color && !state.result;
      const ms = color === 'white' ? values[0] : values[1];
      const danger = ms <= 10000 && active;
      const meta = p.ai ? `Computer · ${state.difficulty?.[0]?.toUpperCase() + state.difficulty?.slice(1)}` : (color === state.role ? 'You' : (color === 'white' ? 'White' : 'Black'));
      return `<div class="player-name"><span class="dot ${p.connected ? 'on':''}"></span><div style="min-width:0"><div class="player-name-main">${escapeHtml(p.name)}</div><div class="player-meta">${escapeHtml(meta)}</div></div></div><div class="clock ${active ? 'active':''} ${danger ? 'danger-clock':''}" data-clock="${color}">${formatClock(ms)}</div>`;
    }

    function renderPlayers() {
      if (!state) return;
      const vals = clockValues();
      const bottomColor = orientation() === 'white' ? 'white' : 'black';
      const topColor = bottomColor === 'white' ? 'black' : 'white';
      document.getElementById('topPlayer').innerHTML = playerHtml(topColor, vals);
      document.getElementById('bottomPlayer').innerHTML = playerHtml(bottomColor, vals);
    }

    function renderMoves() {
      const el = document.getElementById('moves');
      const m = state?.moves || [];
      let html = '';
      for (let i = 0; i < m.length; i += 2) {
        html += `<div class="move-num">${Math.floor(i/2)+1}.</div><div class="move-san">${escapeHtml(m[i] || '')}</div><div class="move-san">${escapeHtml(m[i+1] || '')}</div>`;
      }
      el.innerHTML = html || `<div class="hint" style="grid-column:1/-1">No moves yet.</div>`;
      el.scrollTop = el.scrollHeight;
      document.getElementById('moveCount').textContent = `${m.length} move${m.length === 1 ? '' : 's'}`;
    }

    function renderResultModal() {
      const el = document.getElementById('resultModal');
      if (!state?.result) { el.innerHTML = ''; lastResultKey = ''; dismissedResultKey = ''; return; }
      const key = `${state.result.reason}:${state.result.winner}:${state.moves.length}`;
      if (key === dismissedResultKey) { el.innerHTML = ''; return; }
      if (key === lastResultKey && el.innerHTML) return;
      lastResultKey = key;
      const isPlayer = state.role === 'white' || state.role === 'black';
      let title = 'Game over';
      if (!state.result.winner) title = 'Draw';
      else if (isPlayer && state.result.winner === state.role) title = 'You won ✦';
      else if (isPlayer) title = 'You lost';
      else title = `${state.result.winner[0].toUpperCase() + state.result.winner.slice(1)} wins`;
      el.innerHTML = `<div class="modal-backdrop"><div class="modal glass"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(state.result.message)}</p><div class="invite-row">${isPlayer ? '<button id="modalRematch" class="btn primary" type="button">Play again</button>' : ''}<button id="modalHome" class="btn outline" type="button">New game</button><button id="modalClose" class="btn ghost" type="button">Close</button></div></div></div>`;
      document.getElementById('modalRematch')?.addEventListener('click', () => { dismissedResultKey = key; send('rematch'); el.innerHTML = ''; });
      document.getElementById('modalHome').addEventListener('click', () => location.href = '/');
      document.getElementById('modalClose').addEventListener('click', () => { dismissedResultKey = key; el.innerHTML = ''; });
    }

    function renderSide() {
      if (!state) return;
      document.getElementById('role').textContent = state.role === 'spectator' ? 'Spectator' : `You are ${state.role}`;
      document.getElementById('modePill').textContent = state.mode === 'ai' ? `vs Computer · ${state.difficulty}` : 'Online multiplayer';
      document.getElementById('status').textContent = state.status;
      const connection = ws?.readyState === WebSocket.OPEN ? 'Connected' : 'Reconnecting…';
      document.getElementById('substatus').textContent = `${connection} · Room ${state.room}`;
      document.getElementById('spectators').textContent = state.mode === 'ai' ? `${state.spectators} spectator${state.spectators === 1 ? '' : 's'} · Solo game` : `${state.spectators} spectator${state.spectators === 1 ? '' : 's'}`;
      const isPlayer = state.role === 'white' || state.role === 'black';
      const draw = document.getElementById('draw');
      draw.hidden = state.mode === 'ai';
      draw.disabled = !isPlayer || !!state.result || !state.black || state.draw_offer === state.role;
      document.getElementById('resign').disabled = !isPlayer || !!state.result;
      const rematch = document.getElementById('rematch');
      rematch.hidden = !state.result || !isPlayer;
      rematch.textContent = state.mode === 'ai' ? 'Play again' : (state.rematch_votes ? `Rematch requested (${state.rematch_votes}/2)` : 'Request rematch');
      document.getElementById('copyLink').hidden = state.mode === 'ai';

      const box = document.getElementById('drawBox');
      if (state.draw_offer && isPlayer && state.draw_offer !== state.role && !state.result) {
        box.innerHTML = `<div class="draw-box"><p>Your opponent offered a draw.</p><div class="invite-row"><button id="acceptDraw" class="btn primary" type="button">Accept</button><button id="declineDraw" class="btn outline" type="button">Decline</button></div></div>`;
        document.getElementById('acceptDraw').onclick = () => send('accept_draw');
        document.getElementById('declineDraw').onclick = () => send('decline_draw');
      } else if (state.draw_offer === state.role && !state.result) {
        box.innerHTML = `<div class="draw-box"><p>Draw offer sent. Waiting for your opponent.</p></div>`;
      } else box.innerHTML = '';
      renderMoves();
      renderResultModal();
    }

    function renderAll() { renderBoard(); renderPlayers(); renderSide(); }

    function handleState(next) {
      const prevMoves = state?.moves?.length || 0;
      state = next;
      baseWhite = state.white_ms; baseBlack = state.black_ms; baselineAt = performance.now();
      selected = null;
      renderAll();
      if (next.event && soundOn && next.event.kind !== 'join' && next.event.kind !== 'leave') beep(next.event.kind);
      if ((state.moves?.length || 0) > prevMoves && !next.event && soundOn) beep('move');
    }

    function connect() {
      clearTimeout(reconnectTimer);
      const playerName = localStorage.getItem('chess-name') || 'Player';
      const token = tokenFor(room);
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${scheme}://${location.host}/ws/${encodeURIComponent(room)}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(playerName)}`);
      ws.onopen = () => { reconnectAttempt = 0; if (state) renderSide(); };
      ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state') handleState(msg);
        else if (msg.type === 'error') showToast(msg.message || 'Server error');
      };
      ws.onclose = e => {
        if (intentionalClose) return;
        if (e.code === 4404) { showToast('Room not found. Start a new game.'); return; }
        const delay = Math.min(1000 * (2 ** reconnectAttempt++), 10000);
        if (state) renderSide();
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {};
    }

    document.getElementById('copyLink').addEventListener('click', async () => {
      const url = `${location.origin}/game/${room}`;
      try { await navigator.clipboard.writeText(url); showToast('Invite link copied.'); }
      catch (_) {
        const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); showToast('Invite link copied.');
      }
    });
    document.getElementById('homeBtn').addEventListener('click', () => location.href = '/');
    document.getElementById('flip').addEventListener('click', () => { flipped = !flipped; renderAll(); });
    document.getElementById('sound').addEventListener('click', e => { soundOn = !soundOn; e.currentTarget.textContent = `Sound: ${soundOn ? 'On':'Off'}`; if (soundOn) beep('move'); });
    document.getElementById('draw').addEventListener('click', () => send('offer_draw'));
    document.getElementById('resign').addEventListener('click', () => { if (confirm('Resign this game?')) send('resign'); });
    document.getElementById('rematch').addEventListener('click', () => send('rematch'));

    setInterval(() => { if (state) renderPlayers(); }, 100);
    window.addEventListener('beforeunload', () => { intentionalClose = true; try { ws?.close(); } catch (_) {} });
    connect();
  }

  const match = location.pathname.match(/^\/game\/([A-Za-z0-9_-]+)\/?$/);
  if (match) game(match[1].toUpperCase());
  else home();
})();
