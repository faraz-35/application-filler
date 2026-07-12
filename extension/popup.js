// Popup: server health, profile selection, and JD persistence. The content script
// reads profile + jd from storage on each generate, so saving here is all it takes.

const SERVER = "http://127.0.0.1:8775";
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + kind;
}

async function checkStatus() {
  try {
    const res = await fetch(`${SERVER}/health`);
    const data = await res.json();
    if (data.ok) return setStatus("online", "online");
    setStatus("offline", "offline");
  } catch {
    setStatus("offline", "offline");
  }
}

async function loadProfiles() {
  const sel = $("profile");
  try {
    const res = await fetch(`${SERVER}/profiles`);
    const data = await res.json();
    sel.innerHTML = "";
    for (const p of data.profiles || []) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    }
    return true;
  } catch {
    // Server down — offer the default so the user isn't blocked.
    sel.innerHTML = '<option value="interview">interview</option>';
    return false;
  }
}

function flash(msg) {
  const el = $("saved");
  el.textContent = msg;
  setTimeout(() => (el.textContent = ""), 1500);
}

async function init() {
  $("url").textContent = SERVER;
  checkStatus();
  await loadProfiles();

  const saved = await browser.storage.local.get(["profile", "jd"]);
  const profile = saved.profile || "interview";
  const jd = saved.jd || "";

  const sel = $("profile");
  const hasProfile = [...sel.options].some((o) => o.value === profile);
  sel.value = hasProfile ? profile : "interview";
  $("jd").value = jd;

  // Profile changes persist immediately (small, frequent).
  sel.addEventListener("change", async () => {
    await browser.storage.local.set({ profile: sel.value });
    flash("Profile saved");
  });

  // JD persists on Save (large text, deliberate).
  $("save").addEventListener("click", async () => {
    await browser.storage.local.set({ jd: $("jd").value.trim() });
    flash("Saved");
  });

  $("clear").addEventListener("click", async () => {
    $("jd").value = "";
    await browser.storage.local.set({ jd: "" });
    flash("Cleared");
  });

  // Firefox can't deep-link to the shortcuts editor; send the user to add-ons.
  $("shortcuts").addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: "about:addons" });
  });
}

init();
