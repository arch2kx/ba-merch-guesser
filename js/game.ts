import {
  errorMessage,
  fetchLeaderboard,
  leaderboardEnabled,
  startGame,
  type Game,
  type Item,
  type Round,
} from "./api";
import { HCAPTCHA_SITEKEY } from "./config";
import { NAME_MAX, ROUND_SECONDS, cleanName, type Mode } from "./shared";

interface HCaptcha {
  render(container: HTMLElement, params: { sitekey: string; theme?: string }): string;
  getResponse(widgetId?: string): string;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    hcaptcha?: HCaptcha;
    onScoreCaptchaLoad?: () => void;
  }
}

let isGameOver = false;
let busy = false;
let game: Game | null = null;
let currentItem: Item | null = null;
let gameToken = 0;
let deadline = 0;
let timerHandle: number | null = null;

const priceCounterEl = document.getElementById("price-counter") as HTMLElement;
const priceLineEl = document.getElementById("price-line") as HTMLElement;
const outputEl = document.getElementById("output") as HTMLElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const inputEl = document.getElementById("price-input") as HTMLInputElement;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const allItemsToggle = document.getElementById(
  "all-items-toggle",
) as HTMLInputElement;
const scoreForm = document.getElementById("score-form") as HTMLFormElement;
const scoreFormGroup = document.getElementById(
  "score-form-group",
) as HTMLElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const saveScoreBtn = document.getElementById(
  "save-score-btn",
) as HTMLButtonElement;
const scoreStatusEl = document.getElementById(
  "score-form-status",
) as HTMLElement;
const captchaEl = document.getElementById("score-captcha") as HTMLElement;
const leaderboardEl = document.getElementById("leaderboard") as HTMLElement;
const leaderboardBody = document.getElementById(
  "leaderboard-body",
) as HTMLElement;
const leaderboardStatus = document.getElementById(
  "leaderboard-status",
) as HTMLElement;
const leaderboardTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".leaderboard-tab"),
);

let mode: Mode =
  new URLSearchParams(window.location.search).get("mode") === "all"
    ? "all"
    : "safe";
allItemsToggle.checked = mode === "all";

let leaderboardMode: Mode = mode;
let leaderboardToken = 0;
let highlightId: number | null = null;
let captchaWidgetId: string | null = null;
let captchaRequested = false;

function loadCaptcha() {
  if (captchaRequested) return;
  captchaRequested = true;
  window.onScoreCaptchaLoad = () => {
    if (window.hcaptcha === undefined) return;
    captchaWidgetId = window.hcaptcha.render(captchaEl, {
      sitekey: HCAPTCHA_SITEKEY,
    });
  };
  const script = document.createElement("script");
  script.src =
    "https://js.hcaptcha.com/1/api.js?render=explicit&onload=onScoreCaptchaLoad";
  script.async = true;
  document.head.appendChild(script);
}

function resetCaptcha() {
  if (window.hcaptcha !== undefined && captchaWidgetId !== null) {
    window.hcaptcha.reset(captchaWidgetId);
  }
}

function showItem(item: Item, nameId: string, imageId: string) {
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
    void submitRound(true);
  }
}

function runTimer() {
  stopTimer();
  timerEl.hidden = false;
  tick();
  if (performance.now() < deadline) timerHandle = window.setInterval(tick, 200);
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

function showRound(round: Round) {
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
  if (!game || busy || isGameOver) return;
  const token = gameToken;
  busy = true;
  nextBtn.disabled = true;

  let round: Round;
  try {
    round = await game.next();
  } catch (err) {
    if (token !== gameToken) return;
    busy = false;
    nextBtn.disabled = false;
    outputEl.textContent = errorMessage(err);
    outputEl.hidden = false;
    return;
  }
  if (token !== gameToken) return;
  busy = false;
  nextBtn.disabled = false;
  showRound(round);
}

async function submitRound(timedOut = false) {
  if (!game || !currentItem || busy || isGameOver) return;

  const guess = Number(inputEl.value);

  if (
    !timedOut &&
    (inputEl.value === "" || !Number.isFinite(guess) || guess <= 0)
  ) {
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
    if (token !== gameToken) return;
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
  if (token !== gameToken) return;
  busy = false;
  timerEl.hidden = true;

  outputEl.classList.add(result.correct ? "correct" : "wrong");
  nextBtn.hidden = false;
  nextBtn.focus({ preventScroll: true });

  if (result.gameOver) {
    gameOver(result.score);
    return;
  }

  outputEl.textContent =
    result.percentOff === null
      ? "Time's up!"
      : `You were ${result.percentOff.toFixed(0)}% off!`;
  outputEl.hidden = false;
  priceLineEl.hidden = false;
  animateNumber(priceCounterEl, result.realPrice, 800, () => {
    priceLineEl.classList.add("landed");
  });

  nextBtn.scrollIntoView({ behavior: "smooth", block: "end" });
}

function animateNumber(
  el: HTMLElement,
  target: number,
  duration = 800,
  onDone?: () => void,
) {
  const start = performance.now();

  function frame(now: number) {
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

function gameOver(score: number) {
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

  let started: Game;
  try {
    started = await startGame(mode);
  } catch (err) {
    if (token !== gameToken) return;
    outputEl.textContent = `Couldn't load items. ${errorMessage(err)}`;
    outputEl.hidden = false;
    nextBtn.textContent = "Retry";
    nextBtn.hidden = false;
    isGameOver = true;
    return;
  }
  if (token !== gameToken) return;

  game = started;
  showRound({ item: started.firstItem, secondsLeft: ROUND_SECONDS });

  if (leaderboardEnabled && !started.online) {
    outputEl.textContent =
      "Leaderboard server unavailable. Playing offline; scores won't be saved.";
    outputEl.hidden = false;
  }
}

async function saveScore(event: SubmitEvent) {
  event.preventDefault();
  if (!game || !isGameOver || saveScoreBtn.disabled) return;

  const name = cleanName(nameInput.value);
  const length = Array.from(name).length;
  if (length < 1 || length > NAME_MAX) {
    scoreStatusEl.textContent = `Name must be 1–${NAME_MAX} characters.`;
    scoreStatusEl.classList.add("wrong");
    scoreStatusEl.hidden = false;
    return;
  }

  const captcha =
    window.hcaptcha !== undefined && captchaWidgetId !== null
      ? window.hcaptcha.getResponse(captchaWidgetId)
      : "";
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
    if (token !== gameToken) return;
    highlightId = result.id;
    scoreFormGroup.hidden = true;
    scoreStatusEl.classList.remove("wrong");
    scoreStatusEl.textContent = `Saved! You're #${result.rank} on the leaderboard.`;
    scoreStatusEl.hidden = false;
    setLeaderboardMode(savedMode);
  } catch (err) {
    if (token !== gameToken) return;
    resetCaptcha();
    nameInput.disabled = false;
    saveScoreBtn.disabled = false;
    scoreStatusEl.textContent = errorMessage(err);
    scoreStatusEl.classList.add("wrong");
    scoreStatusEl.hidden = false;
  }
}

function setLeaderboardMode(next: Mode) {
  leaderboardMode = next;
  for (const tab of leaderboardTabs) {
    const selected = tab.dataset.mode === next;
    tab.setAttribute("aria-selected", String(selected));
    tab.classList.toggle("active", selected);
  }
  void loadLeaderboard();
}

async function loadLeaderboard() {
  if (!leaderboardEnabled) return;
  const token = ++leaderboardToken;
  const requested = leaderboardMode;
  leaderboardStatus.textContent = "Loading…";
  leaderboardStatus.hidden = false;

  try {
    const entries = await fetchLeaderboard(requested);
    if (token !== leaderboardToken) return;

    leaderboardBody.replaceChildren(
      ...entries.map((entry, index) => {
        const row = document.createElement("tr");
        if (entry.id === highlightId) row.classList.add("you");
        const date = new Date(entry.created_at).toLocaleDateString();
        for (const [text, cls] of [
          [`${index + 1}`, "lb-rank"],
          [entry.name, "lb-name"],
          [`${entry.score}`, "lb-score"],
          [date, "lb-date"],
        ] as const) {
          const cell = document.createElement("td");
          cell.className = cls;
          cell.textContent = text;
          row.append(cell);
        }
        return row;
      }),
    );

    if (entries.length === 0) {
      leaderboardStatus.textContent = "No scores yet. Be the first!";
    } else {
      leaderboardStatus.hidden = true;
    }
  } catch {
    if (token !== leaderboardToken) return;
    leaderboardBody.replaceChildren();
    leaderboardStatus.textContent = "Couldn't load the leaderboard.";
  }
}

submitBtn.addEventListener("click", () => void submitRound());
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void submitRound();
  }
});
nextBtn.addEventListener("click", () => {
  if (isGameOver) {
    void startNewGame();
  } else {
    void nextRound();
  }
});
scoreForm.addEventListener("submit", (event) => void saveScore(event));

allItemsToggle.addEventListener("change", () => {
  mode = allItemsToggle.checked ? "all" : "safe";
  void startNewGame();
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

void startNewGame();
