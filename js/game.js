// js/config.ts
var SUPABASE_URL = "https://iaskkeooqemjgqcoreyv.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhc2trZW9vcWVtamdxY29yZXl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMjEwNTgsImV4cCI6MjEwNzY5NzA1OH0.UoJDSAPpUUMwTn4NgU2eRKvMR3rjhig9WhnhZNIa3PY";
var HCAPTCHA_SITEKEY = "f5e65868-4a5a-4866-8d56-a2fe03a0e444";

// js/shared.ts
var MAX_MISSES = 5;
var CORRECT_RANGE = 20;
var ROUND_SECONDS = 20;
var YEN_TO_USD = 0.0061;
var SAFE_LINES = [
  "nendoroid",
  "chocopuni",
  "revoltech",
  "figma",
  "pop up parade"
];
function uniqueByName(items) {
  const seen = new Set;
  return items.filter((item) => {
    if (seen.has(item.name))
      return false;
    seen.add(item.name);
    return true;
  });
}
function isSafe(name) {
  const lower = name.toLowerCase();
  return SAFE_LINES.some((line) => lower.includes(line));
}
function cleanName(name) {
  return name.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
}
var NAME_MAX = 20;

// js/api.ts
class ApiError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
var leaderboardEnabled = SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "";
async function post(path, args) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  };
  if (SUPABASE_ANON_KEY.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }
  let res;
  try {
    res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(1e4)
    });
  } catch {
    throw new ApiError("Couldn't reach the server.", null);
  }
  if (!res.ok) {
    let code = null;
    try {
      const body = await res.json();
      if (typeof body?.message === "string")
        code = body.message;
      else if (typeof body?.error === "string")
        code = body.error;
    } catch {}
    throw new ApiError(code ?? `Server error (${res.status}).`, code);
  }
  return await res.json();
}
function rpc(fn, args) {
  return post(`/rest/v1/rpc/${fn}`, args);
}

class RemoteGame {
  sessionId;
  round;
  firstItem;
  online = true;
  constructor(sessionId, round, firstItem) {
    this.sessionId = sessionId;
    this.round = round;
    this.firstItem = firstItem;
  }
  static async create(mode) {
    const data = await rpc("start_game", { p_mode: mode });
    return new RemoteGame(data.session_id, data.round, data.item);
  }
  async guess(value) {
    const data = await rpc("submit_guess", {
      p_session_id: this.sessionId,
      p_round: this.round,
      p_guess: value
    });
    this.round = data.round;
    return {
      correct: data.correct,
      timedOut: data.timed_out,
      percentOff: data.percent_off === null ? null : Number(data.percent_off),
      realPrice: Number(data.real_price),
      score: data.score,
      misses: data.misses,
      gameOver: data.game_over
    };
  }
  async next() {
    const data = await rpc("next_item", {
      p_session_id: this.sessionId,
      p_round: this.round
    });
    return { item: data.item, secondsLeft: Number(data.seconds_left) };
  }
  submitScore(name, captcha) {
    return post("/functions/v1/leaderboard-submit", {
      session_id: this.sessionId,
      name,
      captcha
    });
  }
}
var localItemsCache = null;
function loadLocalItems() {
  localItemsCache ??= fetch("js/baAmiData.json").then((res) => {
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    return res.json();
  }).then((data) => uniqueByName(data.items).map((item) => ({
    id: item.name,
    name: item.name,
    image_url: item.image_url,
    price: item.price
  }))).catch((err) => {
    localItemsCache = null;
    throw err;
  });
  return localItemsCache;
}
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1;i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = a[i];
    a[i] = a[j];
    a[j] = temp;
  }
  return a;
}

class LocalGame {
  pool;
  online = false;
  firstItem;
  deck = [];
  deckIndex = 0;
  current;
  score = 0;
  misses = 0;
  constructor(pool) {
    this.pool = pool;
    this.current = this.draw();
    this.firstItem = this.current;
  }
  static async create(mode) {
    const items = await loadLocalItems();
    const pool = mode === "all" ? items : items.filter((item) => isSafe(item.name));
    if (pool.length === 0)
      throw new ApiError("No items available.", "no_items");
    return new LocalGame(pool);
  }
  draw() {
    if (this.deckIndex >= this.deck.length) {
      this.deck = shuffleArray(this.pool);
      this.deckIndex = 0;
    }
    const item = this.deck[this.deckIndex];
    this.deckIndex += 1;
    return item;
  }
  async guess(value) {
    if (this.misses >= MAX_MISSES)
      throw new ApiError("Game over.", "game_over");
    const realPrice = this.current.price * YEN_TO_USD;
    const percentOff = value === null ? null : Math.abs(value - realPrice) / realPrice * 100;
    const correct = percentOff !== null && percentOff <= CORRECT_RANGE;
    if (correct)
      this.score += 1;
    else
      this.misses += 1;
    const gameOver = this.misses >= MAX_MISSES;
    if (!gameOver)
      this.current = this.draw();
    return {
      correct,
      timedOut: value === null,
      percentOff,
      realPrice,
      score: this.score,
      misses: this.misses,
      gameOver
    };
  }
  async next() {
    return { item: this.current, secondsLeft: ROUND_SECONDS };
  }
  async submitScore() {
    throw new ApiError("Leaderboard is unavailable offline.", "offline");
  }
}
async function startGame(mode) {
  if (leaderboardEnabled) {
    try {
      return await RemoteGame.create(mode);
    } catch (err) {
      console.warn("Leaderboard server unavailable, playing offline.", err);
    }
  }
  return LocalGame.create(mode);
}
function fetchLeaderboard(mode, limit = 10) {
  return rpc("get_leaderboard", { p_mode: mode, p_limit: limit });
}
var ERROR_MESSAGES = {
  unknown_session: "This game expired. Press Play Again to start a new one.",
  stale_round: "This round is out of sync. Press Play Again to start a new game.",
  game_over: "This game is already over.",
  invalid_guess: "Invalid input! Try again.",
  game_not_over: "Finish the game before saving your score.",
  score_too_low: "You need at least 1 point to join the leaderboard.",
  invalid_name: "Name must be 1–20 characters.",
  no_items: "No items available.",
  round_not_started: "This round is out of sync. Press Play Again to start a new game.",
  rate_limited: "The leaderboard is busy. Try again in a minute.",
  captcha_failed: "Captcha check failed. Please try again.",
  captcha_unavailable: "Couldn't verify the captcha. Try again."
};
function errorMessage(err) {
  if (err instanceof ApiError) {
    return err.code && ERROR_MESSAGES[err.code] || err.message;
  }
  return "Something went wrong. Try again.";
}

// js/game.ts
var isGameOver = false;
var busy = false;
var game = null;
var currentItem = null;
var gameToken = 0;
var deadline = 0;
var timerHandle = null;
var priceCounterEl = document.getElementById("price-counter");
var priceLineEl = document.getElementById("price-line");
var outputEl = document.getElementById("output");
var timerEl = document.getElementById("timer");
var inputEl = document.getElementById("price-input");
var submitBtn = document.getElementById("submit-btn");
var nextBtn = document.getElementById("next-btn");
var allItemsToggle = document.getElementById("all-items-toggle");
var scoreForm = document.getElementById("score-form");
var scoreFormGroup = document.getElementById("score-form-group");
var nameInput = document.getElementById("name-input");
var saveScoreBtn = document.getElementById("save-score-btn");
var scoreStatusEl = document.getElementById("score-form-status");
var captchaEl = document.getElementById("score-captcha");
var leaderboardEl = document.getElementById("leaderboard");
var leaderboardBody = document.getElementById("leaderboard-body");
var leaderboardStatus = document.getElementById("leaderboard-status");
var leaderboardTabs = Array.from(document.querySelectorAll(".leaderboard-tab"));
var mode = new URLSearchParams(window.location.search).get("mode") === "all" ? "all" : "safe";
allItemsToggle.checked = mode === "all";
var leaderboardMode = mode;
var leaderboardToken = 0;
var highlightId = null;
var captchaWidgetId = null;
var captchaRequested = false;
function loadCaptcha() {
  if (captchaRequested)
    return;
  captchaRequested = true;
  window.onScoreCaptchaLoad = () => {
    if (window.hcaptcha === undefined)
      return;
    captchaWidgetId = window.hcaptcha.render(captchaEl, {
      sitekey: HCAPTCHA_SITEKEY
    });
  };
  const script = document.createElement("script");
  script.src = "https://js.hcaptcha.com/1/api.js?render=explicit&onload=onScoreCaptchaLoad";
  script.async = true;
  document.head.appendChild(script);
}
function resetCaptcha() {
  if (window.hcaptcha !== undefined && captchaWidgetId !== null) {
    window.hcaptcha.reset(captchaWidgetId);
  }
}
function showItem(item, nameId, imageId) {
  const nameEl = document.getElementById(nameId);
  if (nameEl) {
    nameEl.textContent = item.name;
  }
  const imgEl = document.getElementById(imageId);
  if (imgEl instanceof HTMLImageElement) {
    imgEl.classList.add("loading");
    setTimeout(() => {
      imgEl.onload = () => imgEl.classList.remove("loading");
      imgEl.src = item.image_url;
      imgEl.alt = item.name;
    }, 250);
  }
}
function stopTimer() {
  if (timerHandle !== null) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}
function tick() {
  const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  timerEl.textContent = `${left}s`;
  timerEl.classList.toggle("wrong", left <= 5);
  if (left === 0) {
    stopTimer();
    submitRound(true);
  }
}
function runTimer() {
  stopTimer();
  timerEl.hidden = false;
  tick();
  if (performance.now() < deadline)
    timerHandle = window.setInterval(tick, 200);
}
function resetRoundUi() {
  stopTimer();
  timerEl.hidden = true;
  nextBtn.hidden = true;
  outputEl.hidden = true;
  priceLineEl.hidden = true;
  priceLineEl.classList.remove("landed");
  outputEl.classList.remove("correct", "wrong");
  inputEl.value = "";
}
function showRound(round) {
  resetRoundUi();
  inputEl.disabled = false;
  submitBtn.disabled = false;
  currentItem = round.item;
  showItem(currentItem, "item-name-a", "item-image-a");
  deadline = performance.now() + Math.min(round.secondsLeft, ROUND_SECONDS) * 1000;
  runTimer();
  inputEl.focus({ preventScroll: true });
  inputEl.scrollIntoView({ behavior: "smooth", block: "end" });
}
async function nextRound() {
  if (!game || busy || isGameOver)
    return;
  const token = gameToken;
  busy = true;
  nextBtn.disabled = true;
  let round;
  try {
    round = await game.next();
  } catch (err) {
    if (token !== gameToken)
      return;
    busy = false;
    nextBtn.disabled = false;
    outputEl.textContent = errorMessage(err);
    outputEl.hidden = false;
    return;
  }
  if (token !== gameToken)
    return;
  busy = false;
  nextBtn.disabled = false;
  showRound(round);
}
async function submitRound(timedOut = false) {
  if (!game || !currentItem || busy || isGameOver)
    return;
  const guess = Number(inputEl.value);
  if (!timedOut && (inputEl.value === "" || !Number.isFinite(guess) || guess <= 0)) {
    outputEl.textContent = "Invalid input! Try again.";
    outputEl.hidden = false;
    return;
  }
  const token = gameToken;
  busy = true;
  stopTimer();
  submitBtn.disabled = true;
  inputEl.disabled = true;
  let result;
  try {
    result = await game.guess(timedOut ? null : guess);
  } catch (err) {
    if (token !== gameToken)
      return;
    busy = false;
    outputEl.textContent = errorMessage(err);
    outputEl.hidden = false;
    if (timedOut) {
      nextBtn.textContent = "Retry";
      nextBtn.hidden = false;
      isGameOver = true;
      return;
    }
    submitBtn.disabled = false;
    inputEl.disabled = false;
    runTimer();
    return;
  }
  if (token !== gameToken)
    return;
  busy = false;
  timerEl.hidden = true;
  outputEl.classList.add(result.correct ? "correct" : "wrong");
  nextBtn.hidden = false;
  nextBtn.focus({ preventScroll: true });
  if (result.gameOver) {
    gameOver(result.score);
    return;
  }
  outputEl.textContent = result.percentOff === null ? "Time's up!" : `You were ${result.percentOff.toFixed(0)}% off!`;
  outputEl.hidden = false;
  priceLineEl.hidden = false;
  animateNumber(priceCounterEl, result.realPrice, 800, () => {
    priceLineEl.classList.add("landed");
  });
  nextBtn.scrollIntoView({ behavior: "smooth", block: "end" });
}
function animateNumber(el, target, duration = 800, onDone) {
  const start = performance.now();
  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = (target * eased).toFixed(2);
    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      onDone?.();
    }
  }
  requestAnimationFrame(frame);
}
function gameOver(score) {
  isGameOver = true;
  outputEl.textContent = `You Lost! You got a score of ${score}!`;
  outputEl.hidden = false;
  nextBtn.textContent = "Play Again";
  if (game?.online && score > 0) {
    scoreForm.hidden = false;
    scoreFormGroup.hidden = false;
    nameInput.disabled = false;
    saveScoreBtn.disabled = false;
    scoreStatusEl.hidden = true;
    scoreStatusEl.classList.remove("wrong");
    loadCaptcha();
    resetCaptcha();
    nameInput.focus({ preventScroll: true });
  }
}
function hideScoreForm() {
  scoreForm.hidden = true;
  scoreStatusEl.hidden = true;
  scoreStatusEl.textContent = "";
}
async function startNewGame() {
  const token = ++gameToken;
  busy = false;
  isGameOver = false;
  game = null;
  currentItem = null;
  nextBtn.textContent = "Next";
  nextBtn.disabled = false;
  hideScoreForm();
  resetRoundUi();
  inputEl.disabled = true;
  submitBtn.disabled = true;
  let started;
  try {
    started = await startGame(mode);
  } catch (err) {
    if (token !== gameToken)
      return;
    outputEl.textContent = `Couldn't load items. ${errorMessage(err)}`;
    outputEl.hidden = false;
    nextBtn.textContent = "Retry";
    nextBtn.hidden = false;
    isGameOver = true;
    return;
  }
  if (token !== gameToken)
    return;
  game = started;
  showRound({ item: started.firstItem, secondsLeft: ROUND_SECONDS });
  if (leaderboardEnabled && !started.online) {
    outputEl.textContent = "Leaderboard server unavailable. Playing offline; scores won't be saved.";
    outputEl.hidden = false;
  }
}
async function saveScore(event) {
  event.preventDefault();
  if (!game || !isGameOver || saveScoreBtn.disabled)
    return;
  const name = cleanName(nameInput.value);
  const length = Array.from(name).length;
  if (length < 1 || length > NAME_MAX) {
    scoreStatusEl.textContent = `Name must be 1–${NAME_MAX} characters.`;
    scoreStatusEl.classList.add("wrong");
    scoreStatusEl.hidden = false;
    return;
  }
  const captcha = window.hcaptcha !== undefined && captchaWidgetId !== null ? window.hcaptcha.getResponse(captchaWidgetId) : "";
  if (captcha === "") {
    scoreStatusEl.textContent = "Please complete the captcha.";
    scoreStatusEl.classList.add("wrong");
    scoreStatusEl.hidden = false;
    return;
  }
  const token = gameToken;
  const savedMode = mode;
  nameInput.disabled = true;
  saveScoreBtn.disabled = true;
  scoreStatusEl.hidden = true;
  try {
    const result = await game.submitScore(name, captcha);
    if (token !== gameToken)
      return;
    highlightId = result.id;
    scoreFormGroup.hidden = true;
    scoreStatusEl.classList.remove("wrong");
    scoreStatusEl.textContent = `Saved! You're #${result.rank} on the leaderboard.`;
    scoreStatusEl.hidden = false;
    setLeaderboardMode(savedMode);
  } catch (err) {
    if (token !== gameToken)
      return;
    resetCaptcha();
    nameInput.disabled = false;
    saveScoreBtn.disabled = false;
    scoreStatusEl.textContent = errorMessage(err);
    scoreStatusEl.classList.add("wrong");
    scoreStatusEl.hidden = false;
  }
}
function setLeaderboardMode(next) {
  leaderboardMode = next;
  for (const tab of leaderboardTabs) {
    const selected = tab.dataset.mode === next;
    tab.setAttribute("aria-selected", String(selected));
    tab.classList.toggle("active", selected);
  }
  loadLeaderboard();
}
async function loadLeaderboard() {
  if (!leaderboardEnabled)
    return;
  const token = ++leaderboardToken;
  const requested = leaderboardMode;
  leaderboardStatus.textContent = "Loading…";
  leaderboardStatus.hidden = false;
  try {
    const entries = await fetchLeaderboard(requested);
    if (token !== leaderboardToken)
      return;
    leaderboardBody.replaceChildren(...entries.map((entry, index) => {
      const row = document.createElement("tr");
      if (entry.id === highlightId)
        row.classList.add("you");
      const date = new Date(entry.created_at).toLocaleDateString();
      for (const [text, cls] of [
        [`${index + 1}`, "lb-rank"],
        [entry.name, "lb-name"],
        [`${entry.score}`, "lb-score"],
        [date, "lb-date"]
      ]) {
        const cell = document.createElement("td");
        cell.className = cls;
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }));
    if (entries.length === 0) {
      leaderboardStatus.textContent = "No scores yet. Be the first!";
    } else {
      leaderboardStatus.hidden = true;
    }
  } catch {
    if (token !== leaderboardToken)
      return;
    leaderboardBody.replaceChildren();
    leaderboardStatus.textContent = "Couldn't load the leaderboard.";
  }
}
submitBtn.addEventListener("click", () => void submitRound());
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitRound();
  }
});
nextBtn.addEventListener("click", () => {
  if (isGameOver) {
    startNewGame();
  } else {
    nextRound();
  }
});
scoreForm.addEventListener("submit", (event) => void saveScore(event));
allItemsToggle.addEventListener("change", () => {
  mode = allItemsToggle.checked ? "all" : "safe";
  startNewGame();
  setLeaderboardMode(mode);
});
for (const tab of leaderboardTabs) {
  tab.addEventListener("click", () => {
    if (tab.dataset.mode === "safe" || tab.dataset.mode === "all") {
      setLeaderboardMode(tab.dataset.mode);
    }
  });
}
if (leaderboardEnabled) {
  leaderboardEl.hidden = false;
  setLeaderboardMode(leaderboardMode);
}
startNewGame();
