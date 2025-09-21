// ===== Config =====
// Cambia por tu URL. Debe terminar con "/".
const BACKEND_DEFAULT = "https://1n21m23q-7121.use2.devtunnels.ms/";

// ===== Helpers / Estado =====
const $ = id => document.getElementById(id);
const log = (m, c="") => { const d=document.createElement("div"); d.className="item "+c; d.textContent=`[${new Date().toLocaleTimeString()}] ${m}`; $("log").appendChild(d); $("log").scrollTop = $("log").scrollHeight; };
const addChat = (html, cls="") => { const d=document.createElement("div"); d.className="item "+cls; d.innerHTML=html; $("chat").appendChild(d); $("chat").scrollTop=$("chat").scrollHeight; };
const escapeHtml = s => (s||"").toString().replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

let baseUrl = "";        // terminado con "/"
let connection = null;   // SignalR connection
let currentUser = { id:null, username:null };
let roomCode = null;
let isOwner = false;

// juego
let currentRoundId = null;
let canAnswer = false;
let stampStart = 0;

// Mapa id->hex para pintar opciones (igual que el back)
const COLOR_MAP = {
  1: "#FFFFFF", // Blanco
  2: "#000000", // Negro
  3: "#FF0000", // Rojo
  4: "#00FF00", // Verde
  5: "#0000FF"  // Azul
};

const userKey = (name) => `stroob_user_${name}`;
const storeUserId = (name, id) => localStorage.setItem(userKey(name), id);

const setConn = (t, ok=false) => { $("connStatus").textContent=t; $("connStatus").className="pill"+(ok?" ok":""); };
const setLogin = (t, ok=false) => { $("loginStatus").textContent=t; $("loginStatus").className="pill"+(ok?" ok":""); };
const setTurn = (t) => { $("turnInfo").textContent=t; };

function ensureBaseUrl(){
  const raw = $("baseUrl").value.trim() || BACKEND_DEFAULT;
  baseUrl = raw.endsWith("/") ? raw : raw + "/";
}

// ===== API =====
async function apiLogin(username){
  const r = await fetch(baseUrl + "api/users/login", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ username })
  });
  if (!r.ok) throw new Error(`Login falló (${r.status})`);
  const d = await r.json(); // {status, user:{id,username,createdAt}}
  return { id: d.user.id ?? d.user.Id, username: d.user.username ?? d.user.Username, created: d.status === "created" };
}

async function apiCreateRoom(creatorUserId){
  const r = await fetch(baseUrl + "api/rooms", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(creatorUserId) // GUID string
  });
  if (!r.ok){ const t=await r.text().catch(()=> ""); throw new Error(`Crear sala falló (${r.status}). ${t}`); }
  const d = await r.json();
  return { id: d.id ?? d.Id, code: d.code ?? d.Code, min: d.minPlayers ?? d.MinPlayers, max: d.maxPlayers ?? d.MaxPlayers };
}

async function apiGetPlayers(code){
  const r = await fetch(baseUrl + `api/rooms/${encodeURIComponent(code)}/players`);
  if (!r.ok) return [];
  return await r.json();
}
async function apiGetMessages(code, take=50){
  const r = await fetch(baseUrl + `api/rooms/${encodeURIComponent(code)}/messages?take=${take}`);
  if (!r.ok) return [];
  return await r.json();
}
async function apiGetRankingTop(take=10){
  try{
    const r = await fetch(baseUrl + `api/game/ranking/top?take=${take}`);
    if (!r.ok) return [];
    return await r.json();
  }catch{ return []; }
}

// ===== Renders =====
function renderPlayers(list){
  const ul = $("players"); ul.innerHTML="";
  isOwner = false;
  (list||[]).forEach(p=>{
    const name = p.username ?? p.Username ?? "user";
    const owner = (p.isOwner ?? p.IsOwner) ? " • owner" : "";
    const seat = p.seatOrder ?? p.SeatOrder ?? "?";
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(name)}</span><span class="small">${owner} #${seat}</span>`;
    ul.appendChild(li);
    if ((p.isOwner ?? p.IsOwner) && (p.userId ?? p.UserId)?.toLowerCase?.() === currentUser.id?.toLowerCase?.()){
      isOwner = true;
    }
  });
  // Owner puede iniciar juego
  $("btnStartGame").disabled = !isOwner || !connection;
}

function renderRanking(rows){
  const box = $("ranking"); box.innerHTML="";
  if (!rows || !rows.length){ box.innerHTML=`<div class="item small">Sin datos de ranking aún.</div>`; return; }
  rows.forEach((r,i)=>{
    const u = r.username ?? r.Username;
    const wins = r.wins ?? r.Wins;
    const games = r.gamesPlayed ?? r.GamesPlayed;
    const best = r.bestScore ?? r.BestScore;
    const avg = Math.round((r.avgMs ?? r.AvgMs) || 0);
    const div = document.createElement("div");
    div.className="item";
    div.innerHTML = `<b>#${i+1}</b> ${escapeHtml(u)} — 🏆 ${wins} | Partidas: ${games} | Mejor: ${best} | Prom. ${avg} ms`;
    box.appendChild(div);
  });
}

function renderScoreboard(rows){
  const box = $("scoreboard"); box.innerHTML="";
  (rows||[]).forEach(r=>{
    const u = r.username ?? r.Username;
    const s = r.score ?? r.Score;
    const corr = r.totalCorrect ?? r.TotalCorrect ?? 0;
    const wr = r.totalWrong ?? r.TotalWrong ?? 0;
    const avg = Math.round((r.avgResponseMs ?? r.AvgResponseMs) || 0);
    const div = document.createElement("div");
    div.className="item";
    div.innerHTML = `<b>${escapeHtml(u)}</b> — Pts: ${s} | ✔ ${corr} / ✖ ${wr} | ${avg} ms`;
    box.appendChild(div);
  });
}

// ===== Juego (UI) =====
function showGameUI(show){
  $("gameArea").classList.toggle("hidden", !show);
}

function setWordAndInk(word, inkHex){
  $("wordText").textContent = word || "—";
  $("wordText").style.color = inkHex || "#cbd5e1";
}

function setupOptions(options){
  // vienen en orden; pintamos solo por ColorId
  const [o1, o2] = options;
  const b1 = $("opt1"), b2 = $("opt2");
  b1.style.background = COLOR_MAP[o1.colorId ?? o1.ColorId] || "#111827";
  b2.style.background = COLOR_MAP[o2.colorId ?? o2.ColorId] || "#111827";
  b1.dataset.optId = (o1.id ?? o1.Id);
  b2.dataset.optId = (o2.id ?? o2.Id);
  b1.disabled = b2.disabled = !canAnswer;
}

function enableOptions(enable){
  $("opt1").disabled = $("opt2").disabled = !enable;
}

function handleNewRound(payload){
  currentRoundId = payload.RoundId ?? payload.roundId;
  const word = payload.Word ?? payload.word;
  const ink = payload.InkHex ?? payload.inkHex;
  const options = payload.Options ?? payload.options ?? [];
  const remaining = payload.RemainingForThisPlayer ?? payload.remainingForThisPlayer ?? 0;

  setWordAndInk(word, ink);
  setupOptions(options);
  $("remaining").textContent = remaining;

  // arranca reloj de respuesta
  canAnswer = true;
  enableOptions(true);
  stampStart = performance.now();
}

async function submitOption(optId){
  if (!canAnswer || !connection || !currentRoundId) return;
  canAnswer = false;
  enableOptions(false);
  const rtSec = Math.max(0, (performance.now() - stampStart) / 1000);
  $("lastTime").textContent = Math.round(rtSec * 1000);

  try{
    await connection.invoke("SubmitAnswer", roomCode, currentUser.id, currentRoundId, optId, rtSec);
  }catch(e){
    log("No se pudo enviar respuesta: " + (e?.message || e), "err");
  }
}

// ===== SignalR binding =====
function bindHub(conn){
  conn.on("UserJoined", p => {
    const name = p.username ?? p.Username ?? "user";
    addChat(`🟢 <span class="sys">${escapeHtml(name)}</span> entró a la sala`, "sys");
  });
  conn.on("UserLeft", p => {
    const name = p.username ?? p.Username ?? "user";
    addChat(`🟡 <span class="sys">${escapeHtml(name)}</span> salió de la sala`, "sys");
  });
  conn.on("RoomUpdated", s => {
    const list = s.Players || s.players || [];
    renderPlayers(list);
  });
  conn.on("ChatMessage", m => {
    const uid = m.userId ?? m.UserId, uname = m.username ?? m.Username ?? "user", text = m.text ?? m.Text ?? "";
    const self = currentUser.id && uid && uid.toLowerCase?.() === currentUser.id.toLowerCase?.();
    addChat(`<b>${escapeHtml(uname)}:</b> ${escapeHtml(text)}`, self?"me":"");
  });
  conn.on("ChatHistory", arr=>{
    (arr||[]).forEach(m=>{
      const uname = m.username ?? m.Username ?? "user";
      const text = m.text ?? m.Text ?? "";
      addChat(`<span class="small">hist</span> <b>${escapeHtml(uname)}:</b> ${escapeHtml(text)}`);
    });
  });

  // ==== Juego ====
  conn.on("GameStarted", g=>{
    showGameUI(true);
    setTurn("juego iniciado");
    log("Juego iniciado","ok");
  });

  conn.on("TurnChanged", t=>{
    const uid = t.UserId ?? t.userId;
    const uname = t.Username ?? t.username ?? "alguien";
    if (uid && currentUser.id && uid.toLowerCase?.() === currentUser.id.toLowerCase?.()){
      setTurn(`tu turno: ${uname}`);
      canAnswer = true;
    }else{
      setTurn(`turno de: ${uname}`);
      canAnswer = false;
    }
    enableOptions(canAnswer);
  });

  conn.on("NewRound", payload=>{
    handleNewRound(payload);
  });

  conn.on("ScoreUpdated", x=>{
    // podrías animar delta si quieres
  });

  conn.on("Scoreboard", rows=>{
    renderScoreboard(rows);
  });

  conn.on("Winner", w=>{
    const u = w.Username ?? w.username;
    const s = w.Score ?? w.score;
    addChat(`🏆 <span class="sys">${escapeHtml(u)}</span> ganó con ${s} puntos`, "sys");
  });

  conn.on("GameFinished", rows=>{
    renderScoreboard(rows);
    setTurn("juego finalizado");
  });

  conn.onreconnecting(()=> setConn("reconectando…"));
  conn.onreconnected(()=> setConn("conectado", true));
  conn.onclose(()=> {
    setConn("desconectado");
    $("btnSend").disabled = true;
    $("btnDisconnect").disabled = true;
    $("btnConnect").disabled = currentUser.id ? false : true;
    $("btnStartGame").disabled = true;
    showGameUI(false);
    setTurn("sin juego");
  });
}

// ===== Handlers =====
$("btnLogin").onclick = async () => {
  try{
    ensureBaseUrl();
    const name = $("loginUsername").value.trim();
    if (!name) return alert("Ingresa un username");

    const res = await apiLogin(name);
    currentUser = { id: res.id, username: res.username };
    storeUserId(res.username, res.id);

    $("btnConnect").disabled = false;
    setLogin(`logueado: ${res.username}`, true);
    $("loginMsg").textContent = res.created ? `✅ Usuario creado: ${res.username}` : `✅ Bienvenido ${res.username}`;
    $("loginMsg").className = "small ok";

    renderRanking(await apiGetRankingTop(10));
  }catch(e){
    $("loginMsg").textContent = "❌ " + (e?.message || e);
    $("loginMsg").className = "small err";
    setLogin("error");
  }
};

$("btnCreateRoom").onclick = async () => {
  try{
    ensureBaseUrl();
    if (!currentUser.id) return alert("Primero inicia sesión");
    const room = await apiCreateRoom(currentUser.id);
    $("createdCode").textContent = room.code;
    $("roomCode").value = room.code;
    log(`Sala creada ${room.code} (${room.min}-${room.max})`,"ok");
  }catch(e){
    log("Crear sala: " + (e?.message || e), "err");
  }
};

$("btnConnect").onclick = async () => {
  try{
    ensureBaseUrl();
    if (!currentUser.id) return alert("Primero inicia sesión");
    roomCode = $("roomCode").value.trim();
    if (!roomCode) return alert("Ingresa RoomCode");

    connection = new signalR.HubConnectionBuilder()
      .withUrl(baseUrl + "hubs/game", { withCredentials:true })
      .withAutomaticReconnect()
      .build();
    bindHub(connection);

    await connection.start();
    $("connId").textContent = connection.connectionId || "(n/a)";
    setConn("conectado", true);

    // Join
    await connection.invoke("JoinRoom", roomCode, currentUser.id, currentUser.username);

    // Snapshot
    renderPlayers(await apiGetPlayers(roomCode));
    (await apiGetMessages(roomCode, 50)).forEach(m=>{
      const name = m.username ?? m.Username ?? "user";
      const text = m.text ?? m.Text ?? "";
      addChat(`<span class="small">hist</span> <b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`);
    });

    $("btnSend").disabled = false;
    $("btnDisconnect").disabled = true; // se habilita cuando haya hub conectado
    $("btnDisconnect").disabled = false;
    $("btnConnect").disabled = true;

    // owner?
    $("btnStartGame").disabled = !isOwner;
  }catch(e){
    setConn("error");
    alert("Error al conectar: " + (e?.message || e));
  }
};

$("btnDisconnect").onclick = async () => {
  try{ if (connection && roomCode) await connection.invoke("LeaveRoom", roomCode); }catch{}
  try{ if (connection) await connection.stop(); }catch{}
  connection = null;
  setConn("desconectado");
  $("btnSend").disabled = true;
  $("btnDisconnect").disabled = true;
  $("btnConnect").disabled = !currentUser.id;
  $("btnStartGame").disabled = true;
  showGameUI(false);
  setTurn("sin juego");
};

$("btnSend").onclick = async () => {
  const t = $("msg").value.trim();
  if (!t || !connection) return;
  try{
    await connection.invoke("SendChat", roomCode, currentUser.id, t);
    $("msg").value = "";
  }catch(e){ log("No se pudo enviar: " + (e?.message || e), "err"); }
};

$("msg").addEventListener("keydown", ev=>{
  if (ev.key==="Enter" && !ev.shiftKey){ ev.preventDefault(); $("btnSend").click(); }
});

// Iniciar juego (validado en back: solo owner)
$("btnStartGame").onclick = async () => {
  try{
    if (!connection) return alert("Conéctate a la sala primero");
    const n = parseInt($("roundsPerPlayer").value || "4", 10);
    await connection.invoke("StartGame", roomCode, Math.max(1, Math.min(10, n)));
    // el hub emitirá GameStarted + TurnChanged + NewRound, etc.
  }catch(e){
    alert("No se pudo iniciar: " + (e?.message || e));
  }
};

// Opciones de respuesta
$("opt1").onclick = () => submitOption(parseInt($("opt1").dataset.optId,10));
$("opt2").onclick = () => submitOption(parseInt($("opt2").dataset.optId,10));

$("baseUrl").addEventListener("change", async ()=>{
  ensureBaseUrl();
  renderRanking(await apiGetRankingTop(10));
});

// ===== Init =====
window.addEventListener("DOMContentLoaded", async () => {
  $("baseUrl").value = BACKEND_DEFAULT;
  ensureBaseUrl();
  setConn("desconectado"); setLogin("sin login"); setTurn("sin juego");
  renderRanking(await apiGetRankingTop(10));
});
