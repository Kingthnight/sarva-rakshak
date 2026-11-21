const $ = (id) => document.getElementById(id);
const state = { sessionId: null, client: null, mic: null, live: false, toolEls: new Map() };

const ICON = { pending: "○", in_progress: "◔", done: "✓", skipped: "–" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function addMsg(role, text) {
  if (!text) return;
  const hint = $("transcript").querySelector(".hint");
  if (hint) hint.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  $("transcript").appendChild(el);
  el.scrollIntoView({ block: "end", behavior: "smooth" });
}

function renderPlan(steps) {
  $("plan").innerHTML = steps
    .map((s) => `<li class="${esc(s.status)}"><span class="st">${ICON[s.status] ?? "○"}</span>${esc(s.title)}</li>`)
    .join("");
}

function addApproval(e) {
  const box = $("approvals");
  box.querySelector(".muted")?.remove();
  let el = box.querySelector(`[data-id="${e.approvalId}"]`);
  if (!el && e.type === "approval_requested") {
    el = document.createElement("div");
    el.className = "approval";
    el.dataset.id = e.approvalId;
    el.textContent = `⏳ Waiting for your yes: ${e.summary}`;
    box.appendChild(el);
  } else if (el && e.type === "approval_granted") {
    el.className = "approval granted";
    el.textContent = el.textContent.replace("⏳ Waiting for your yes:", "✅ Approved:");
  } else if (e.type === "approval_rejected") {
    const r = document.createElement("div");
    r.className = "approval rejected";
    r.textContent = `⛔ Blocked ${e.action}: ${e.reason}`;
    box.appendChild(r);
  }
}

function renderCase(s) {
  const list = (title, items) => (items && items.length ? `<b>${title}</b><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
  const html = [
    list("Lost", s.items),
    list("Cards", s.cards),
    list("Suspicious", s.flagged),
    list("Disputes", s.disputes),
    s.report ? list("Police report", [s.report]) : "",
    list("Reissue guides", s.reissue),
    list("Reminders", s.reminders),
    list("Emails", s.emails),
  ].join("");
  $("caseSummary").className = "case";
  $("caseSummary").innerHTML = html || '<span class="muted">Nothing yet.</span>';
}

function short(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function toolStart(e) {
  const li = document.createElement("li");
  li.className = `act ${e.server}`;
  li.innerHTML = `<div class="row"><span class="name">${esc(e.name)}</span><span><span class="badge">${esc(e.server === "agent" ? "agent" : e.server + " mcp")}</span> <span class="status run">running…</span></span></div>
    <details><summary>input</summary><pre>${esc(short(e.input))}</pre></details>`;
  $("activity").prepend(li);
  state.toolEls.set(e.id, li);
}

function toolEnd(e) {
  const li = state.toolEls.get(e.id);
  if (!li) return;
  const st = li.querySelector(".status");
  const err = e.result && e.result.error;
  st.className = `status ${e.ok ? "ok" : "err"}`;
  st.textContent = e.ok ? `✓ ${e.ms}ms` : `✗ ${err || "error"}`;
  li.insertAdjacentHTML("beforeend", `<details><summary>result</summary><pre>${esc(short(e.result))}</pre></details>`);
}

function logEvent(text) {
  const li = document.createElement("li");
  li.className = "act event";
  li.textContent = text;
  $("activity").prepend(li);
}

function onEvent(e) {
  switch (e.type) {
    case "user_said": return addMsg("user", e.text);
    case "agent_said": return addMsg("agent", e.text);
    case "plan": return renderPlan(e.steps);
    case "tool_start": return toolStart(e);
    case "tool_end": return toolEnd(e);
    case "approval_requested":
    case "approval_granted":
    case "approval_rejected": return addApproval(e);
    case "case": return renderCase(e.summary);
    case "status": return logEvent(`ℹ️ ${e.message}`);
    case "error": return logEvent(`⚠️ ${e.message}`);
  }
}

async function startVoice() {
  if (!window.AgoraRTC) throw new Error("Agora SDK failed to load");
  $("voiceState").textContent = "Connecting…";
  const info = await api(`/api/sessions/${state.sessionId}/voice/start`, {});
  const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  client.on("user-published", async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === "audio") user.audioTrack.play();
  });
  client.enableAudioVolumeIndicator();
  client.on("volume-indicator", (vols) => {
    const agentLoud = vols.some((v) => String(v.uid) === String(info.agentUid ?? "1001") && v.level > 5);
    $("callBtn").classList.toggle("speaking", agentLoud);
  });
  await client.join(info.appId, info.channel, info.token, info.uid);
  const mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
  await client.publish([mic]);
  Object.assign(state, { client, mic, live: true });
  $("callBtn").classList.add("live");
  $("callLabel").textContent = "End call";
  $("voiceState").textContent = `Live on ${info.channel}`;
}

async function stopVoice() {
  try {
    state.mic?.close();
    await state.client?.leave();
  } finally {
    await api(`/api/sessions/${state.sessionId}/voice/stop`, {}).catch(() => {});
    Object.assign(state, { client: null, mic: null, live: false });
    $("callBtn").classList.remove("live", "speaking");
    $("callLabel").textContent = "Start emergency call";
    $("voiceState").textContent = "Not connected";
  }
}

async function init() {
  const health = await api("/api/health");
  const h = $("health");
  if (health.voiceReady) {
    h.textContent = `voice ready · ${health.model} · email ${health.emailMode}`;
    h.className = "pill ok";
  } else {
    h.textContent = `text mode · voice needs ${health.missing.voice.join(", ")}`;
    h.className = "pill warn";
  }
  const s = await api("/api/sessions", {});
  state.sessionId = s.sessionId;
  $("caseId").textContent = `case: ${s.caseId}`;
  const es = new EventSource(`/api/sessions/${s.sessionId}/events`);
  es.onmessage = (m) => onEvent(JSON.parse(m.data));

  $("callBtn").onclick = async () => {
    try {
      state.live ? await stopVoice() : await startVoice();
    } catch (err) {
      $("voiceState").textContent = `⚠️ ${err.message}`;
    }
  };

  $("textForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const text = $("textInput").value.trim();
    if (!text) return;
    $("textInput").value = "";
    const btn = $("textForm").querySelector("button");
    btn.disabled = true;
    try {
      await api(`/api/sessions/${state.sessionId}/text`, { text });
    } catch (err) {
      logEvent(`⚠️ ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  };
}

init().catch((e) => {
  $("health").textContent = `error: ${e.message}`;
});
