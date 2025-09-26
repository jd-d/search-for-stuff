const TOKEN_KEY = "nitterAuthToken";
const WORKER_URL_KEY = "nitterWorkerUrl";
const INSTANCE_KEY = "nitterSelectedInstance";

const loginSection = document.querySelector("#login-section");
const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");
const appSection = document.querySelector("#app");
const instanceSelect = document.querySelector("#instance-select");
const handleInput = document.querySelector("#handle-input");
const countInput = document.querySelector("#count-input");
const workerUrlInput = document.querySelector("#worker-url-input");
const checkInstancesBtn = document.querySelector("#check-instances-btn");
const fetchTweetsBtn = document.querySelector("#fetch-tweets-btn");
const exportCsvBtn = document.querySelector("#export-csv-btn");
const logoutBtn = document.querySelector("#logout-btn");
const instanceStatus = document.querySelector("#instance-status");
const fetchStatus = document.querySelector("#fetch-status");
const summarySection = document.querySelector("#summary");
const tweetsSection = document.querySelector("#tweets");
const tweetsBody = document.querySelector("#tweets-body");
const summaryCount = document.querySelector("#summary-count");
const summaryLikes = document.querySelector("#summary-likes");
const summaryRetweets = document.querySelector("#summary-retweets");
const summaryReplies = document.querySelector("#summary-replies");

let tweetsCache = [];

async function loadInstances() {
  try {
    const response = await fetch("nitter_instances.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load instances: ${response.status}`);
    }
    const instances = await response.json();
    instanceSelect.innerHTML = "";
    const storedInstance = sessionStorage.getItem(INSTANCE_KEY);
    for (const url of instances) {
      const option = document.createElement("option");
      option.value = url;
      option.textContent = url;
      instanceSelect.appendChild(option);
    }
    if (storedInstance && instances.includes(storedInstance)) {
      instanceSelect.value = storedInstance;
    }
  } catch (error) {
    instanceStatus.textContent = error.message;
  }
}

function getWorkerUrl() {
  const value = workerUrlInput.value.trim();
  if (value) {
    sessionStorage.setItem(WORKER_URL_KEY, value);
    return value;
  }
  const stored = sessionStorage.getItem(WORKER_URL_KEY);
  if (stored) {
    workerUrlInput.value = stored;
    return stored;
  }
  return "";
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

function toggleApp(authenticated) {
  if (authenticated) {
    loginSection.classList.add("hidden");
    appSection.classList.remove("hidden");
  } else {
    loginSection.classList.remove("hidden");
    appSection.classList.add("hidden");
    fetchStatus.textContent = "";
    instanceStatus.textContent = "";
    summarySection.classList.add("hidden");
    tweetsSection.classList.add("hidden");
    tweetsBody.innerHTML = "";
    exportCsvBtn.disabled = true;
  }
}

async function login(username, password) {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error("Enter your Cloudflare Worker URL first.");
  }

  const response = await fetch(`${workerUrl.replace(/\/?$/, "")}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    const payload = await safeJson(response);
    const message = payload?.error || `Login failed (${response.status})`;
    throw new Error(message);
  }

  const payload = await response.json();
  if (!payload?.token) {
    throw new Error("Unexpected login response");
  }

  setToken(payload.token);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function renderStatus(container, statuses) {
  container.innerHTML = "";
  for (const status of statuses) {
    const span = document.createElement("span");
    span.textContent = status.label;
    if (status.ok === true) {
      span.classList.add("ok");
    } else if (status.ok === false) {
      span.classList.add("fail");
    }
    container.appendChild(span);
  }
}

async function checkInstances() {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    fetchStatus.textContent = "Enter your Cloudflare Worker URL first.";
    return;
  }
  const token = getToken();
  if (!token) {
    fetchStatus.textContent = "Login before checking instances.";
    return;
  }

  const urls = Array.from(instanceSelect.options).map((option) => option.value);
  const statuses = [];
  for (const url of urls) {
    try {
      const response = await fetch(`${workerUrl.replace(/\/?$/, "")}/check-instance?url=${encodeURIComponent(url)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      let ok = response.ok;
      if (response.ok) {
        const payload = await safeJson(response);
        if (payload && typeof payload.ok === "boolean") {
          ok = payload.ok;
        }
      }
      statuses.push({ label: `${url} ${ok ? "✓" : "✗"}`, ok });
    } catch (error) {
      statuses.push({ label: `${url} ✗`, ok: false });
    }
  }
  renderStatus(instanceStatus, statuses);
}

async function fetchTweets() {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    fetchStatus.textContent = "Enter your Cloudflare Worker URL first.";
    return;
  }
  const token = getToken();
  if (!token) {
    fetchStatus.textContent = "Login before fetching tweets.";
    return;
  }

  const handle = handleInput.value.trim();
  const instance = instanceSelect.value;
  const count = Math.min(Math.max(parseInt(countInput.value, 10) || 1, 1), 50);

  if (!instance) {
    fetchStatus.textContent = "Pick a Nitter instance first.";
    return;
  }
  if (!handle) {
    fetchStatus.textContent = "Enter a handle to query.";
    return;
  }

  fetchStatus.textContent = "Fetching tweets…";

  try {
    const response = await fetch(
      `${workerUrl.replace(/\/?$/, "")}/tweets?instance=${encodeURIComponent(instance)}&handle=${encodeURIComponent(handle)}&count=${count}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (response.status === 401) {
      setToken(null);
      toggleApp(false);
      fetchStatus.textContent = "Session expired. Please log in again.";
      return;
    }

    if (!response.ok) {
      const payload = await safeJson(response);
      const message = payload?.error || `Request failed (${response.status})`;
      throw new Error(message);
    }

    const payload = await response.json();
    tweetsCache = payload?.tweets ?? [];
    if (instance) {
      sessionStorage.setItem(INSTANCE_KEY, instance);
    }
    renderTweets(tweetsCache);
    renderSummary(tweetsCache);
    fetchStatus.textContent = `Fetched ${tweetsCache.length} tweets.`;
    exportCsvBtn.disabled = tweetsCache.length === 0;
  } catch (error) {
    fetchStatus.textContent = error.message;
  }
}

function renderTweets(tweets) {
  tweetsBody.innerHTML = "";
  if (!tweets.length) {
    tweetsSection.classList.add("hidden");
    return;
  }

  for (const tweet of tweets) {
    const row = document.createElement("tr");
    const date = new Date(tweet.time);
    const safeText = escapeHtml(String(tweet.text || "")).replace(/\n/g, "<br />");
    const timeLabel = Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    const timeCell = tweet.url
      ? `<a href="${escapeAttribute(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(timeLabel)}</a>`
      : escapeHtml(timeLabel);

    row.innerHTML = `
      <td>${timeCell}</td>
      <td>${safeText}</td>
      <td>${tweet.replies ?? 0}</td>
      <td>${tweet.retweets ?? 0}</td>
      <td>${tweet.likes ?? 0}</td>
    `;

    tweetsBody.appendChild(row);
  }

  tweetsSection.classList.remove("hidden");
}

function renderSummary(tweets) {
  if (!tweets.length) {
    summarySection.classList.add("hidden");
    summaryCount.textContent = "0";
    summaryLikes.textContent = "0";
    summaryRetweets.textContent = "0";
    summaryReplies.textContent = "0";
    return;
  }

  const total = tweets.length;
  const likes = avg(tweets.map((tweet) => tweet.likes ?? 0));
  const retweets = avg(tweets.map((tweet) => tweet.retweets ?? 0));
  const replies = avg(tweets.map((tweet) => tweet.replies ?? 0));

  summaryCount.textContent = String(total);
  summaryLikes.textContent = likes.toFixed(1);
  summaryRetweets.textContent = retweets.toFixed(1);
  summaryReplies.textContent = replies.toFixed(1);
  summarySection.classList.remove("hidden");
}

function avg(values) {
  if (!values.length) return 0;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return sum / values.length;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function exportCsv() {
  if (!tweetsCache.length) {
    return;
  }

  const headers = ["id", "time", "text", "replies", "retweets", "likes"];
  const csvRows = [headers.join(",")];

  for (const tweet of tweetsCache) {
    const row = headers
      .map((key) => {
        const value = tweet[key] ?? "";
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
      })
      .join(",");
    csvRows.push(row);
  }

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${handleInput.value.replace(/[^a-z0-9_-]/gi, "_") || "tweets"}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function logout() {
  setToken(null);
  toggleApp(false);
  loginStatus.textContent = "Logged out.";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  const username = String(formData.get("username") || "").trim();
  const password = String(formData.get("password") || "").trim();

  loginStatus.textContent = "Signing in…";
  loginStatus.classList.remove("error");

  try {
    await login(username, password);
    loginStatus.textContent = "Login successful.";
    toggleApp(true);
  } catch (error) {
    loginStatus.textContent = error.message;
    loginStatus.classList.add("error");
    setToken(null);
  }
});

checkInstancesBtn.addEventListener("click", () => {
  checkInstances();
});

fetchTweetsBtn.addEventListener("click", () => {
  fetchTweets();
});

exportCsvBtn.addEventListener("click", exportCsv);
logoutBtn.addEventListener("click", logout);

(async function init() {
  await loadInstances();
  const token = getToken();
  if (token) {
    toggleApp(true);
  }
  const workerUrl = sessionStorage.getItem(WORKER_URL_KEY);
  if (workerUrl) {
    workerUrlInput.value = workerUrl;
  }
})();

instanceSelect.addEventListener("change", () => {
  const value = instanceSelect.value;
  if (value) {
    sessionStorage.setItem(INSTANCE_KEY, value);
  }
});
