(() => {
  'use strict';

  const GAME_ID = 'quoridor';
  const GAME_NAME = 'コリドール';
  const MAX_PLAYERS = 4;
  const WORKER_ORIGIN = 'https://quoridor-online.naitoryo7110.workers.dev';
  const COMMON_PLAYER_NAME_KEY = 'boardgamePlayerName';
  const ROOM_IDS = ['room1','room2','room3','room4'];
  const APP_VERSION = 'v0.1.0';
  const NAME_DRAFT_KEY = `${GAME_ID}-name-draft`;
  const ACTIVE_ROOM_KEY = `${GAME_ID}-online-room`;
  const ACTIVE_NAME_KEY = `${GAME_ID}-online-active-name`;

  const $ = (id) => document.getElementById(id);
  const screens = ['titleScreen','lobbyScreen','gameScreen','resultScreen'];

  let ws = null;
  let reconnectTimer = null;
  let currentRoomId = null;
  let currentPlayerName = '';
  let currentToken = '';
  let latestState = null;
  let actionMode = 'move';
  let actionSeq = 0;
  let commonNameSavedForSession = null;
  let intentionalClose = false;

  function commonSavedName() {
    return String(localStorage.getItem(COMMON_PLAYER_NAME_KEY) || '').trim().slice(0,32);
  }
  function saveCommonNameOnActualStart(playerName) {
    const name = String(playerName || '').trim().slice(0,32);
    if (!name) return;
    localStorage.setItem(COMMON_PLAYER_NAME_KEY, name);
  }
  function tokenKey(roomId) { return `${GAME_ID}-online-token-${roomId}`; }
  function getToken(roomId) {
    let token = localStorage.getItem(tokenKey(roomId));
    if (!token) {
      token = crypto.randomUUID().replace(/-/g,'');
      localStorage.setItem(tokenKey(roomId), token);
    }
    return token;
  }
  function showScreen(id) {
    screens.forEach(s => $(s).classList.toggle('active', s === id));
  }
  function roomNo(roomId) { return ROOM_IDS.indexOf(roomId) + 1; }
  function roomStatusLabel(room) {
    if (room.status === 'playing') return 'ゲーム中';
    if (room.status === 'finished') return '終了';
    return '待機中';
  }
  function setBadge(ok) {
    for (const id of ['connectionBadge','gameConnectionBadge']) {
      const el = $(id); if (!el) continue;
      el.textContent = ok ? '接続中' : '再接続中';
      el.classList.toggle('ok', ok);
      el.classList.toggle('bad', !ok);
    }
  }
  function safeName() {
    return String($('nameInput').value || '').trim().slice(0,32);
  }
  function setMsg(id, text='') { $(id).textContent = text; }

  async function fetchJson(url, options={}) {
    const res = await fetch(url, {cache:'no-store', ...options});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadRooms() {
    setMsg('titleMessage','');
    try {
      const data = await fetchJson(`${WORKER_ORIGIN}/rooms`);
      renderRooms(data.rooms || []);
    } catch (err) {
      setMsg('titleMessage', `ROOM情報を取得できません：${err.message}`);
      renderRooms(ROOM_IDS.map((id)=>({roomId:id,status:'lobby',players:[],count:0,maxPlayers:2,unavailable:true})));
    }
  }

  function renderRooms(rooms) {
    const map = new Map(rooms.map(r => [r.roomId, r]));
    $('roomGrid').innerHTML = ROOM_IDS.map((roomId,i) => {
      const r = map.get(roomId) || {roomId,status:'lobby',players:[],count:0,maxPlayers:2};
      const players = (r.players || []).length ? r.players.join('<br>') : 'なし';
      const activeRoom = localStorage.getItem(ACTIVE_ROOM_KEY) === roomId && localStorage.getItem(tokenKey(roomId));
      const label = activeRoom ? '再接続' : '参加する';
      return `<article class="room-card">
        <div class="room-card-head"><h2>ROOM ${i+1}</h2><span class="room-status">${roomStatusLabel(r)}</span></div>
        <div class="room-count">${r.count ?? 0} / ${r.maxPlayers ?? 2}人</div>
        <div class="room-players">参加者：<br>${players}</div>
        <button class="join-btn" data-join-room="${roomId}" ${r.unavailable?'disabled':''}>${label}</button>
        <button class="reset-btn" data-reset-room="${roomId}" ${r.unavailable?'disabled':''}>初期化</button>
      </article>`;
    }).join('');

    document.querySelectorAll('[data-join-room]').forEach(btn => btn.addEventListener('click', () => joinRoom(btn.dataset.joinRoom)));
    document.querySelectorAll('[data-reset-room]').forEach(btn => btn.addEventListener('click', () => resetRoom(btn.dataset.resetRoom)));
  }

  async function resetRoom(roomId) {
    const ok = confirm(`ROOM ${roomNo(roomId)} を初期化しますか？`);
    if (!ok) return;
    try {
      await fetchJson(`${WORKER_ORIGIN}/reset-empty?roomId=${encodeURIComponent(roomId)}`, {method:'POST'});
      await loadRooms();
    } catch (err) { setMsg('titleMessage', err.message); }
  }

  async function checkRoomJoin(roomId, playerName, token) {
    const url = new URL(`${WORKER_ORIGIN}/join-check`);
    url.searchParams.set('roomId',roomId);
    url.searchParams.set('name',playerName);
    url.searchParams.set('token',token);
    return fetchJson(url.toString());
  }

  async function joinRoom(roomId, reconnectOnly=false) {
    const savedActive = localStorage.getItem(ACTIVE_ROOM_KEY) === roomId;
    const playerName = reconnectOnly || savedActive
      ? String(localStorage.getItem(ACTIVE_NAME_KEY) || safeName()).trim().slice(0,32)
      : safeName();
    if (!playerName) { setMsg('titleMessage','プレイヤー名を入力してください。'); return; }
    const token = getToken(roomId);
    setMsg('titleMessage','');
    try {
      await checkRoomJoin(roomId, playerName, token);
      currentRoomId = roomId;
      currentPlayerName = playerName;
      currentToken = token;
      connectWebSocket();
    } catch (err) { setMsg('titleMessage', err.message); }
  }

  function wsUrl() {
    const base = new URL(WORKER_ORIGIN);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = '/ws';
    base.searchParams.set('roomId', currentRoomId);
    base.searchParams.set('name', currentPlayerName);
    base.searchParams.set('token', currentToken);
    return base.toString();
  }

  function connectWebSocket() {
    clearTimeout(reconnectTimer);
    intentionalClose = false;
    setBadge(false);
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      setBadge(true);
      localStorage.setItem(ACTIVE_ROOM_KEY,currentRoomId);
      localStorage.setItem(ACTIVE_NAME_KEY,currentPlayerName);
    });
    ws.addEventListener('message', (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'state') applyState(msg.state);
      if (msg.type === 'error') {
        const target = latestState?.status === 'playing' ? 'gameMessage' : latestState?.status === 'finished' ? 'resultMessage' : 'lobbyMessage';
        setMsg(target, msg.error || '操作できませんでした。');
      }
    });
    ws.addEventListener('close', () => {
      setBadge(false);
      if (!intentionalClose && currentRoomId) scheduleReconnect();
    });
    ws.addEventListener('error', () => setBadge(false));
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (currentRoomId && (!ws || ws.readyState !== WebSocket.OPEN)) connectWebSocket();
    }, 1200);
  }

  function send(type, payload={}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({type, actionId:`${currentToken}-${Date.now()}-${++actionSeq}`, ...payload}));
  }

  function myPlayer(state=latestState) {
    return state?.players?.find(p => p.token === currentToken) || null;
  }
  function isHost() { return latestState?.hostToken === currentToken; }

  function applyState(state) {
    latestState = state;
    if (!state) return;
    if (state.status === 'playing' && state.gameSessionId && commonNameSavedForSession !== state.gameSessionId) {
      saveCommonNameOnActualStart(currentPlayerName);
      commonNameSavedForSession = state.gameSessionId;
    }
    if (state.status === 'lobby') renderLobby(state);
    else if (state.status === 'playing') renderGame(state);
    else if (state.status === 'finished') renderResult(state);
  }

  function renderLobby(state) {
    showScreen('lobbyScreen');
    $('lobbyRoomTitle').textContent = `ROOM ${roomNo(state.roomId)}`;
    $('lobbyPlayers').innerHTML = state.players.map((p,i)=>`<div class="player-row ${p.token===state.hostToken?'host':''}"><span>${escapeHtml(p.name)}${p.isCpu?'（CPU）':''}</span><span>${i+1}/${state.maxPlayers}</span></div>`).join('');
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('selected', Number(b.dataset.mode) === state.maxPlayers));
    $('hostControls').style.display = isHost() ? 'grid' : 'none';
    $('startBtn').style.display = isHost() ? 'block' : 'none';
    $('startBtn').disabled = state.players.length !== state.maxPlayers;
    setMsg('lobbyMessage', state.players.length === state.maxPlayers ? '' : `${state.maxPlayers}人そろうと開始できます。`);
  }

  function renderGame(state) {
    showScreen('gameScreen');
    $('gameRoomLabel').textContent = `ROOM ${roomNo(state.roomId)}`;
    const current = state.players[state.turnIndex];
    $('turnLabel').textContent = current ? `${current.name} の手番` : '手番';
    const me = myPlayer(state);
    $('gamePlayers').innerHTML = state.players.map((p,i)=>`<div class="game-player ${i===state.turnIndex?'current':''} ${p.token===currentToken?'me':''}">
      <div class="player-dot" style="background:${p.color}"></div>
      <div class="player-main"><span class="player-name">${escapeHtml(p.name)}${p.isCpu?'（CPU）':''}</span><span class="player-meta">壁 ${p.wallsLeft}枚 ${p.connected===false&&!p.isCpu?'・切断中':''}</span></div>
    </div>`).join('');
    const myTurn = me && state.players[state.turnIndex]?.token === currentToken && !me.isCpu;
    document.querySelectorAll('.action-btn').forEach(b => b.disabled = !myTurn);
    if (me && me.wallsLeft <= 0 && actionMode !== 'move') setActionMode('move');
    renderBoard(state, myTurn);
    setMsg('gameMessage', myTurn ? 'あなたの手番です。' : '');
  }

  function renderBoard(state, myTurn) {
    const board = $('board');
    board.innerHTML = '';
    const legal = new Set((state.legalMoves || []).map(m => `${m.r},${m.c}`));
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) {
      const cell = document.createElement('button');
      cell.className = 'board-cell';
      cell.style.left = `${c*100/9}%`;
      cell.style.top = `${r*100/9}%`;
      cell.dataset.r = r; cell.dataset.c = c;
      if (myTurn && actionMode === 'move' && legal.has(`${r},${c}`)) {
        cell.classList.add('legal');
        cell.addEventListener('click',()=>send('move',{r,c}));
      } else cell.disabled = true;
      const pawn = state.players.find(p => p.r === r && p.c === c);
      if (pawn) {
        const dot = document.createElement('div'); dot.className='pawn'; dot.style.background=pawn.color; dot.title=pawn.name; cell.appendChild(dot);
      }
      board.appendChild(cell);
    }
    for (const w of state.walls || []) drawWall(board,w);
    if (myTurn && (actionMode === 'h' || actionMode === 'v')) {
      const me = myPlayer(state);
      if (me && me.wallsLeft > 0) drawWallHits(board, actionMode);
    }
  }

  function drawWall(board,w) {
    const el = document.createElement('div');
    el.className='wall';
    const pitch = 100/9;
    if (w.o === 'H') {
      el.style.left = `${w.c*pitch}%`; el.style.top = `calc(${(w.r+1)*pitch}% - 5px)`; el.style.width=`${2*pitch}%`; el.style.height='10px';
    } else {
      el.style.left = `calc(${(w.c+1)*pitch}% - 5px)`; el.style.top=`${w.r*pitch}%`; el.style.width='10px'; el.style.height=`${2*pitch}%`;
    }
    board.appendChild(el);
  }

  function drawWallHits(board, mode) {
    const pitch = 100/9;
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
      const hit = document.createElement('button'); hit.className='wall-hit';
      if (mode==='h') {
        hit.style.left=`${c*pitch}%`; hit.style.top=`calc(${(r+1)*pitch}% - 9px)`; hit.style.width=`${2*pitch}%`; hit.style.height='18px';
        hit.addEventListener('click',()=>send('wall',{r,c,o:'H'}));
      } else {
        hit.style.left=`calc(${(c+1)*pitch}% - 9px)`; hit.style.top=`${r*pitch}%`; hit.style.width='18px'; hit.style.height=`${2*pitch}%`;
        hit.addEventListener('click',()=>send('wall',{r,c,o:'V'}));
      }
      board.appendChild(hit);
    }
  }

  function renderResult(state) {
    showScreen('resultScreen');
    const winner = state.players.find(p => p.token === state.winnerToken);
    $('winnerText').textContent = winner ? `${winner.name} の勝利` : 'ゲーム終了';
    $('resultPlayers').innerHTML = state.players.map(p=>`<div class="player-row"><span>${escapeHtml(p.name)}${p.isCpu?'（CPU）':''}</span><span>残り壁 ${p.wallsLeft}</span></div>`).join('');
    $('rematchBtn').style.display = isHost() ? 'block' : 'none';
    $('backLobbyBtn').style.display = isHost() ? 'block' : 'none';
  }

  function setActionMode(mode) {
    actionMode = mode;
    $('moveModeBtn').classList.toggle('active', mode==='move');
    $('wallHBtn').classList.toggle('active', mode==='h');
    $('wallVBtn').classList.toggle('active', mode==='v');
    if (latestState?.status === 'playing') renderGame(latestState);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function leaveRoom() {
    if (ws && ws.readyState===WebSocket.OPEN) send('leave');
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
    ws = null; latestState = null;
    localStorage.removeItem(ACTIVE_ROOM_KEY);
    localStorage.removeItem(ACTIVE_NAME_KEY);
    currentRoomId = null; currentToken=''; currentPlayerName='';
    showScreen('titleScreen');
    loadRooms();
  }

  $('nameInput').value = sessionStorage.getItem(NAME_DRAFT_KEY) ?? commonSavedName() ?? '';
  $('nameInput').addEventListener('input', e => sessionStorage.setItem(NAME_DRAFT_KEY,e.target.value));
  $('leaveLobbyBtn').addEventListener('click', leaveRoom);
  $('leaveGameBtn').addEventListener('click', leaveRoom);
  $('resultLeaveBtn').addEventListener('click', leaveRoom);
  document.querySelectorAll('.mode-btn').forEach(b=>b.addEventListener('click',()=>send('setMode',{maxPlayers:Number(b.dataset.mode)})));
  $('addCpuBtn').addEventListener('click',()=>send('addCpu'));
  $('removeCpuBtn').addEventListener('click',()=>send('removeCpu'));
  $('startBtn').addEventListener('click',()=>send('start'));
  $('moveModeBtn').addEventListener('click',()=>setActionMode('move'));
  $('wallHBtn').addEventListener('click',()=>setActionMode('h'));
  $('wallVBtn').addEventListener('click',()=>setActionMode('v'));
  $('rematchBtn').addEventListener('click',()=>send('rematch'));
  $('backLobbyBtn').addEventListener('click',()=>send('backLobby'));

  document.addEventListener('visibilitychange',()=>{
    if (document.visibilityState==='visible' && currentRoomId && (!ws || ws.readyState!==WebSocket.OPEN)) scheduleReconnect();
  });
  window.addEventListener('online',()=>{
    if (currentRoomId && (!ws || ws.readyState!==WebSocket.OPEN)) scheduleReconnect();
  });

  const storedRoom = localStorage.getItem(ACTIVE_ROOM_KEY);
  const storedName = localStorage.getItem(ACTIVE_NAME_KEY);
  if (storedRoom && ROOM_IDS.includes(storedRoom) && storedName && localStorage.getItem(tokenKey(storedRoom))) {
    $('nameInput').value = storedName;
    joinRoom(storedRoom,true);
  } else {
    loadRooms();
  }
})();
