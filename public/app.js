const $ = (id) => document.getElementById(id);

const state = {
  recordedAudio: null,
  issues: [],
  cards: [],
  selectedCard: null
};

function headers() {
  const out = { "Content-Type": "application/json" };
  const secret = $("secret").value.trim();
  if (secret) out["x-vapi-secret"] = secret;
  return out;
}

function baseUrl() {
  return ($("baseUrl").value || window.location.origin).replace(/\/$/, "");
}

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  if (loading) {
    btn.classList.add("loading");
    // Preserve SVG icon in button
    const svg = btn.querySelector("svg");
    if (svg) {
      btn.textContent = "";
      btn.appendChild(svg);
      btn.append(" Running...");
    } else {
      btn.textContent = "Running...";
    }
  } else {
    btn.classList.remove("loading");
    const svg = btn.querySelector("svg");
    if (svg) {
      btn.textContent = "";
      btn.appendChild(svg);
      btn.append(` ${label}`);
    } else {
      btn.textContent = label;
    }
  }
}

async function apiPost(path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(json.error || json?.data?.error || `Request failed (${res.status})`);
  }
  return json.data;
}

async function apiGet(path) {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: headers()
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(json.error || json?.data?.error || `Request failed (${res.status})`);
  }
  return json.data;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      if (idx === -1) return reject(new Error("Could not parse audio"));
      resolve(result.slice(idx + 1));
    };
    reader.onerror = () => reject(new Error("Audio read failed"));
    reader.readAsDataURL(blob);
  });
}

// --- Step unlocking ---
function unlockStep(stepNum) {
  const el = $(`step${stepNum}`);
  if (el) {
    el.classList.remove("step-locked");
  }
}

// --- Visual Card Tiles ---
function renderCardTiles() {
  const tilesEl = $("cardTiles");
  if (!state.cards.length) {
    tilesEl.innerHTML = "";
    return;
  }

  tilesEl.innerHTML = state.cards.map((c) => {
    const isSelected = state.selectedCard === c.cardLast4;
    const statusClass = c.fraudLocked ? "locked" : "active";
    const statusText = c.fraudLocked ? "Locked" : "Active";
    return `
      <div class="card-tile ${isSelected ? "selected" : ""}" data-last4="${c.cardLast4}">
        <div>
          <div class="card-tile-issuer">${c.issuer}</div>
          <div class="card-tile-nickname">${c.nickname}</div>
        </div>
        <div class="card-tile-bottom">
          <span class="card-tile-last4">**** ${c.cardLast4}</span>
          <span class="card-tile-status ${statusClass}">${statusText}</span>
        </div>
      </div>
    `;
  }).join("");

  // Click to select
  tilesEl.querySelectorAll(".card-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      const last4 = tile.dataset.last4;
      state.selectedCard = last4;
      // Update dropdown
      $("cardSelect").value = last4;
      // Re-render tiles to update selection
      renderCardTiles();
      // Unlock step 2
      unlockStep(2);
      unlockStep(3);
    });
  });
}

function selectedCardLast4() {
  return state.selectedCard || $("cardSelect").value || state.cards[0]?.cardLast4 || "3005";
}

const DEMO_CARDS = [
  { issuer: "American Express", nickname: "Travel Platinum", cardLast4: "3005", fraudLocked: true },
  { issuer: "Chase", nickname: "Sapphire Reserve", cardLast4: "8891", fraudLocked: false }
];

async function connectCards() {
  const btn = $("connectCardsBtn");
  setLoading(btn, true, "Connect All Cards");
  try {
    const data = await apiPost("/api/tools/list-cards", {
      customerId: $("customerId").value.trim() || "cust_001"
    });
    state.cards = data.cards || [];
  } catch {
    // Fallback to demo card
    state.cards = DEMO_CARDS;
  }

  // Populate dropdown
  const sel = $("cardSelect");
  sel.innerHTML = "";
  state.cards.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.cardLast4;
    opt.textContent = `${c.issuer} - ${c.nickname} (****${c.cardLast4})${c.fraudLocked ? " [LOCKED]" : ""}`;
    sel.appendChild(opt);
  });
  sel.disabled = false;

  // Auto-select first card
  if (state.cards.length > 0) {
    state.selectedCard = state.cards[0].cardLast4;
    sel.value = state.selectedCard;
  }

  // Show select label and render tiles
  $("cardSelectLabel").style.display = "block";
  renderCardTiles();

  // Unlock steps 2 and 3
  unlockStep(2);
  unlockStep(3);

  setLoading(btn, false, "Connect All Cards");
}

// --- Card select dropdown sync ---
function onCardSelectChange() {
  const val = $("cardSelect").value;
  if (val) {
    state.selectedCard = val;
    renderCardTiles();
    unlockStep(2);
    unlockStep(3);
  }
}

// --- Recording ---
let mediaRecorder;
let audioChunks = [];

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      state.recordedAudio = {
        audioBase64: await toBase64(blob),
        mimeType: blob.type || "audio/webm"
      };
      const statusEl = $("recordStatus");
      statusEl.textContent = `Recorded — transcribing...`;
      statusEl.classList.remove("recording");
      $("deleteRecording").style.display = "inline-flex";

      // Auto-transcribe
      try {
        const result = await apiPost("/api/voice/transcribe", {
          audioBase64: state.recordedAudio.audioBase64,
          mimeType: state.recordedAudio.mimeType
        });
        $("transcript").value = result.text || result.transcript || "";
        statusEl.textContent = "Transcription complete";
      } catch (err) {
        statusEl.textContent = `Transcription failed: ${err.message}`;
      }
    };

    mediaRecorder.start();
    const statusEl = $("recordStatus");
    statusEl.textContent = "Recording...";
    statusEl.classList.add("recording");
    $("deleteRecording").style.display = "none";
  } catch (err) {
    $("recordStatus").textContent = `Recording failed: ${err.message}`;
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    $("recordStatus").textContent = "No active recording";
    return;
  }
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach((track) => track.stop());
}

function deleteRecording() {
  state.recordedAudio = null;
  audioChunks = [];
  const statusEl = $("recordStatus");
  statusEl.textContent = "Not recording";
  statusEl.classList.remove("recording");
  $("deleteRecording").style.display = "none";
}

// --- Structured Result Panel ---
function renderResult(data, error) {
  const panel = $("resultPanel");
  panel.style.display = "block";

  if (error) {
    panel.className = "result-panel error";
    panel.innerHTML = `
      <div class="result-header error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        Error
      </div>
      <div class="result-rows">
        <div class="result-row">
          <span class="result-label">Details</span>
          <span class="result-value">${error}</span>
        </div>
      </div>
    `;
    return;
  }

  const resolution = data?.handled?.resolution || {};
  const summaryText = data?.summary?.summary || "Resolution generated";
  const issueType = data?.intake?.issueType || "unknown";
  const ticketId = resolution.ticketId || resolution.caseId || resolution.disputeId || null;
  const callId = data?.call?.id || null;
  const sessionId = data?.intake?.sessionId || "N/A";
  const outcome = resolution.approved !== undefined
    ? (resolution.approved ? "Approved" : "Denied")
    : (resolution.disputeId ? "Dispute filed" : resolution.caseId ? "Alert filed" : "Processed");

  panel.className = "result-panel success";
  panel.innerHTML = `
    <div class="result-header success">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      Resolved
    </div>
    <div class="result-rows">
      <div class="result-row">
        <span class="result-label">Session ID</span>
        <span class="result-value">${sessionId}</span>
      </div>
      <div class="result-row">
        <span class="result-label">Issue Type</span>
        <span class="result-value">${issueType.replace(/_/g, " ")}</span>
      </div>
      <div class="result-row">
        <span class="result-label">Outcome</span>
        <span class="result-value">${outcome}</span>
      </div>
      <div class="result-row">
        <span class="result-label">Summary</span>
        <span class="result-value">${summaryText}</span>
      </div>
      ${ticketId ? `<div class="result-row"><span class="result-label">Ticket ID</span><span class="result-value">${ticketId}</span></div>` : ""}
      ${callId ? `<div class="result-row"><span class="result-label">Call ID</span><span class="result-value">${callId}</span></div>` : ""}
    </div>
  `;
}

// --- Issues ---
function renderIssues() {
  const root = $("issuesList");
  if (!state.issues.length) {
    root.innerHTML = '<p class="empty">No issues yet.</p>';
    return;
  }

  root.innerHTML = state.issues.map((issue) => {
    const isFailed = issue.status?.startsWith("Failed");
    const isDone = issue.progress >= 100 && !isFailed;
    const cardClass = isDone ? "issue-done" : isFailed ? "issue-failed" : "";

    let statusBadgeClass = "in-progress";
    let statusBadgeText = "In Progress";
    if (isDone) { statusBadgeClass = "resolved"; statusBadgeText = "Resolved"; }
    if (isFailed) { statusBadgeClass = "failed"; statusBadgeText = "Failed"; }

    return `
      <article class="issue ${cardClass}">
        <div class="issue-top">
          <span class="issue-label">${issue.label}</span>
          <span class="issue-status-badge ${statusBadgeClass}">${statusBadgeText}</span>
        </div>
        <span class="issue-id">${issue.id}</span>
        ${issue.issueType ? `<span class="issue-type-badge">${issue.issueType.replace(/_/g, " ")}</span>` : ""}
        <div class="progress"><span style="width:${issue.progress}%"></span></div>
        <div class="progress-text">${issue.status}</div>
        ${issue.summary ? `<div class="issue-summary">${issue.summary}</div>` : ""}
        <div class="issue-meta">
          ${issue.callId ? `<span class="issue-call-id">Call: ${issue.callId}</span>` : ""}
          ${issue.ticketId ? `<span class="issue-ticket">Ticket: ${issue.ticketId}</span>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function setIssueProgress(id, progress, status, extra) {
  const issue = state.issues.find((x) => x.id === id);
  if (!issue) return;
  issue.progress = progress;
  issue.status = status;
  if (extra) Object.assign(issue, extra);
  renderIssues();
}

// --- Call Status Polling ---
function pollCallStatus(callId, issueId) {
  const STATUS_MAP = {
    queued:        { progress: 50, text: "Call queued" },
    ringing:       { progress: 60, text: "Ringing..." },
    "in-progress": { progress: 75, text: "Call in progress" },
    forwarding:    { progress: 75, text: "Forwarding call" },
    ended:         { progress: 100, text: "Resolved" }
  };

  const interval = setInterval(async () => {
    try {
      const data = await apiGet(`/api/agent/call-status/${callId}`);
      const status = data?.status || "queued";
      const mapped = STATUS_MAP[status] || { progress: 50, text: `Call: ${status}` };

      setIssueProgress(issueId, mapped.progress, mapped.text, { callId });

      if (status === "ended") {
        clearInterval(interval);
      }
    } catch {
      // If polling fails, stop silently — the issue stays at its last known state
      clearInterval(interval);
    }
  }, 3000);
}

// --- Solve (Agent Flow) ---
async function solve() {
  const btn = $("solveBtn");
  const panel = $("resultPanel");
  panel.style.display = "none";

  const transcript = $("transcript").value.trim();
  if (!transcript) {
    renderResult(null, "Please record audio or type a transcript before solving.");
    return;
  }

  setLoading(btn, true, "Solve");

  const issueId = `iss_${Date.now().toString().slice(-6)}`;
  state.issues.unshift({
    id: issueId,
    label: "Card Service Case",
    progress: 10,
    status: "Voice intake started"
  });
  renderIssues();

  try {
    const payload = {
      customerId: $("customerId").value.trim() || "cust_001",
      cardLast4: selectedCardLast4(),
      callToNumber: $("callToNumber").value.trim(),
      transcript
    };

    setIssueProgress(issueId, 30, "Processing issue...");
    const data = await apiPost("/api/agent/test-call", payload);

    const resolution = data?.handled?.resolution || {};
    const summaryText = data?.summary?.summary || "Resolution generated";
    const issueType = data?.intake?.issueType || "unknown";
    const ticketId = resolution.ticketId || resolution.caseId || resolution.disputeId || null;
    const callId = data?.call?.id || null;

    if (callId) {
      // Call was placed — show "In Progress" and start polling
      setIssueProgress(issueId, 40, "Call placed — waiting for status", {
        summary: summaryText,
        issueType,
        ticketId,
        callId
      });
      renderResult(data, null);
      setLoading(btn, false, "Solve");
      pollCallStatus(callId, issueId);
    } else {
      // No phone call — resolve immediately
      setIssueProgress(issueId, 100, "Resolved", {
        summary: summaryText,
        issueType,
        ticketId
      });
      renderResult(data, null);
      setLoading(btn, false, "Solve");
    }
  } catch (err) {
    setIssueProgress(issueId, 100, `Failed: ${err.message}`);
    renderResult(null, err.message);
    setLoading(btn, false, "Solve");
  }
}

// --- Health Check ---
async function checkHealth() {
  const btn = $("healthBtn");
  const out = $("healthOutput");
  setLoading(btn, true, "Health Check");
  try {
    const res = await fetch(`${baseUrl()}/health`);
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = `Health failed: ${err.message}`;
  } finally {
    setLoading(btn, false, "Health Check");
  }
}

// --- Event Listeners ---
$("connectCardsBtn").addEventListener("click", connectCards);
$("cardSelect").addEventListener("change", onCardSelectChange);
$("startRecording").addEventListener("click", startRecording);
$("stopRecording").addEventListener("click", stopRecording);
$("deleteRecording").addEventListener("click", deleteRecording);
$("solveBtn").addEventListener("click", solve);
$("healthBtn").addEventListener("click", checkHealth);

renderIssues();
