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

const DOC_OPTIONS = ["Driving licence", "Aadhaar", "PAN", "Voter ID", "Passport", "Phone / SIM"];
let banks = [];

async function refreshCards() {
  if (!state.sessionId) return;
  const { cards } = await api(`/api/sessions/${state.sessionId}/cards`);
  $("cards").innerHTML = cards
    .map((c) => `<div class="cardrow"><span>${esc(c.nickname || c.bankName)} ••${esc(c.last4)} <span class="muted">${esc(c.channels.join("/"))}</span></span><span class="st ${esc(c.status)}">${esc(c.status.replace("_", " "))}</span></div>`)
    .join("");
  const sel = $("simCard");
  const cur = sel.value;
  sel.innerHTML = cards.map((c) => `<option value="${esc(c.id)}">${esc(c.bankName)} ••${esc(c.last4)}</option>`).join("");
  if (cur) sel.value = cur;
}

function renderActions(actions) {
  $("actionsBox").hidden = !actions || !actions.length;
  $("actions").innerHTML = (actions || [])
    .map((a) => `<div class="action ${a.done ? "done" : ""}"><span>${a.done ? "✅ " : "📞 "}<b>${esc(a.title)}</b><br><span class="muted">${esc(a.detail)}</span></span>${!a.done && a.tel ? `<a class="call" href="${esc(a.tel)}">Call now</a>` : ""}</div>`)
    .join("");
}

function addAlert(e) {
  const el = document.createElement("div");
  el.className = `alert ${e.outcome}`;
  el.textContent = e.outcome === "declined"
    ? `🛡️ Blocked: ₹${e.amountInr} at ${e.merchant} on ${e.bank} ••${e.last4}${e.spoken ? " (announced)" : ""}`
    : `🚨 Went through: ₹${e.amountInr} at ${e.merchant} on ${e.bank} ••${e.last4}. Say "freeze it".${e.spoken ? " (announced)" : ""}`;
  $("alerts").prepend(el);
}

function renderCase(s) {
  renderActions(s.actionsNeeded);
  refreshCards().catch(() => {});
  const list = (title, items) => (items && items.length ? `<b>${title}</b><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
  const html = [
    list("Lost", s.items),
    list("Cards", s.cards),
    list("Suspicious", s.flagged),
    list("Disputes", s.disputes),
    s.report ? list("Police report", [s.report]) : "",
    list("Reissue guides", s.reissue),
    list("Reminders", s.reminders),
    list("Replacements", s.replacements),
    list("Card watch", s.cardAlerts),
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

// Expected detours the agent handles (shown amber, not as failures).
const FALLBACK_CODES = new Set(["CALL_REQUIRED", "BANK_UNAVAILABLE", "APPROVAL_REQUIRED", "CHANNEL_UNSUPPORTED"]);
const FALLBACK_LABEL = {
  CALL_REQUIRED: "needs a call: guiding user",
  BANK_UNAVAILABLE: "bank down: using fallback",
  APPROVAL_REQUIRED: "waiting for your yes",
  CHANNEL_UNSUPPORTED: "trying another channel",
};

function toolEnd(e) {
  const li = state.toolEls.get(e.id);
  if (!li) return;
  const st = li.querySelector(".status");
  const err = e.result && e.result.error;
  const fallback = !e.ok && FALLBACK_CODES.has(err);
  st.className = `status ${e.ok ? "ok" : fallback ? "run" : "err"}`;
  st.textContent = e.ok ? `✓ ${e.ms}ms` : fallback ? `↪ ${FALLBACK_LABEL[err]}` : `✗ ${err || "error"}`;
  if (fallback) li.classList.add("fallback");
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
    case "card_alert": return addAlert(e);
    case "guardrail": {
      const li = document.createElement("li");
      li.className = "act guard";
      li.textContent = `🔒 Guardrail: ${e.message}`;
      return $("activity").prepend(li);
    }
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

// ---------- Settings ----------
function cardRow(c = {}) {
  const row = document.createElement("div");
  row.className = "card-row";
  const bankOpts = banks.map((b) => `<option value="${esc(b.code)}" ${b.code === (c.bank || "").toUpperCase() ? "selected" : ""}>${esc(b.code)}</option>`).join("");
  const kinds = ["credit", "debit", "prepaid", "forex"].map((k) => `<option ${k === c.kind ? "selected" : ""}>${k}</option>`).join("");
  const ch = c.channels ? c.channels.join(",") : "";
  row.innerHTML = `
    <select data-k="bank" title="Bank">${bankOpts}</select>
    <select data-k="kind" title="Type">${kinds}</select>
    <input data-k="network" placeholder="Network" value="${esc(c.network || "Visa")}" />
    <input data-k="last4" placeholder="Last 4" maxlength="4" inputmode="numeric" value="${esc(c.last4 || "")}" />
    <input data-k="nickname" placeholder="Nickname" value="${esc(c.nickname || "")}" />
    <select data-k="channels" title="How this card can be blocked">
      <option value="" ${ch === "" ? "selected" : ""}>Bank default</option>
      <option value="call" ${ch === "call" ? "selected" : ""}>Phone call only</option>
      <option value="sms,call" ${ch === "sms,call" ? "selected" : ""}>SMS or call</option>
      <option value="api,sms,call" ${ch === "api,sms,call" ? "selected" : ""}>App, SMS or call</option>
    </select>
    <button type="button" class="ghost" title="Remove">🗑</button>`;
  row.querySelector("button").onclick = () => row.remove();
  row.dataset.id = c.id || "";
  row.dataset.helpline = c.helpline || "";
  return row;
}

async function openSettings() {
  const { profile, banks: b } = await api("/api/profile");
  banks = b;
  const f = $("settingsForm");
  f.name.value = profile.name;
  f.email.value = profile.email;
  f.phone.value = profile.phone;
  f.city.value = profile.city;
  f.ecName.value = profile.emergencyContact?.name || "";
  f.ecRelation.value = profile.emergencyContact?.relation || "";
  f.ecPhone.value = profile.emergencyContact?.phone || "";
  f.highValueInr.value = profile.guardrails?.highValueInr ?? 10000;
  f.cardWatch.checked = profile.guardrails?.cardWatch ?? true;
  const docs = new Set(profile.documents);
  $("docs").innerHTML = [...new Set([...DOC_OPTIONS, ...profile.documents])]
    .map((d) => `<label><input type="checkbox" value="${esc(d)}" ${docs.has(d) ? "checked" : ""}/> ${esc(d)}</label>`)
    .join("");
  $("cardRows").innerHTML = "";
  profile.cards.forEach((c) => $("cardRows").appendChild(cardRow(c)));
  $("settingsError").textContent = "";
  $("settings").showModal();
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = $("settingsForm");
  const cards = [...$("cardRows").children].map((row) => {
    const v = (k) => row.querySelector(`[data-k="${k}"]`).value.trim();
    const card = { bank: v("bank"), kind: v("kind"), network: v("network") || "Visa", last4: v("last4"), nickname: v("nickname") || undefined };
    if (v("channels")) card.channels = v("channels").split(",");
    if (row.dataset.helpline) card.helpline = row.dataset.helpline;
    return card;
  });
  const body = {
    name: f.name.value.trim(),
    email: f.email.value.trim(),
    phone: f.phone.value.trim(),
    city: f.city.value.trim(),
    language: "en-IN",
    emergencyContact: { name: f.ecName.value.trim(), relation: f.ecRelation.value.trim(), phone: f.ecPhone.value.trim() },
    documents: [...$("docs").querySelectorAll("input:checked")].map((i) => i.value),
    cards,
    guardrails: { highValueInr: Number(f.highValueInr.value) || 10000, cardWatch: f.cardWatch.checked },
  };
  try {
    await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error);
    });
    if (state.live) await stopVoice();
    location.reload(); // new session picks up the new profile
  } catch (err) {
    $("settingsError").textContent = err.message;
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
  $("userPill").textContent = `👤 ${s.user}`;
  refreshCards().catch(() => {});
  $("settingsBtn").onclick = () => openSettings().catch((e) => alert(e.message));
  $("closeSettings").onclick = () => $("settings").close();
  $("addCard").onclick = () => $("cardRows").appendChild(cardRow({ bank: "HDFC", kind: "debit" }));
  $("settingsForm").onsubmit = saveSettings;
  $("simBtn").onclick = async () => {
    try {
      await api(`/api/sessions/${state.sessionId}/simulate/charge`, { cardId: $("simCard").value });
    } catch (err) {
      logEvent(`⚠️ ${err.message}`);
    }
  };
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
