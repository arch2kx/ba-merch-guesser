import baAmiInfo from "./baAmiData.json";

// Init rounds
const MAX_MISSES = 5;
const CORRECT_RANGE = 20;
const YEN_TO_USD = 0.0061;

let score = 0;
let misses = 0;
let isGameOver = false;

const priceCounterEl = document.getElementById("price-counter") as HTMLElement;
const priceLineEl = document.getElementById("price-line") as HTMLElement;

const SAFE_LINES = [
  "nendoroid",
  "chocopuni",
  "revoltech",
  "figma",
  "pop up parade",
];
const showAll =
  new URLSearchParams(window.location.search).get("mode") === "all";

const seen = new Set<string>();
const uniqueItems = baAmiInfo.items.filter((item) => {
  if (seen.has(item.name)) return false;
  seen.add(item.name);
  return true;
});

function buildPool(showEverything: boolean) {
  return showEverything
    ? uniqueItems
    : uniqueItems.filter((item) =>
        SAFE_LINES.some((line) => item.name.toLowerCase().includes(line)),
      );
}

let itemPool = buildPool(showAll);

const outputEl = document.getElementById("output") as HTMLElement;
const inputEl = document.getElementById("price-input") as HTMLInputElement;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const allItemsToggle = document.getElementById(
  "all-items-toggle",
) as HTMLInputElement;
allItemsToggle.checked = showAll;

interface Student {
  name: string;
  image_url: string;
  price: number;
}

let currentItem: Student | null = null;

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = temp;
  }
  return a;
}

let deck: Student[] = [];
let deckIndex = 0;

function getNextItem(): Student | null {
  if (itemPool.length === 0) return null;

  if (deckIndex >= deck.length) {
    deck = shuffleArray(itemPool);
    deckIndex = 0;
  }

  const item = deck[deckIndex] ?? null;
  deckIndex += 1;
  return item;
}

function showItem(item: Student, nameId: string, imageId: string) {
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

function newRound() {
  document
    .querySelector(".container")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });

  nextBtn.hidden = true;
  inputEl.disabled = false;
  submitBtn.disabled = false;
  outputEl.hidden = true;
  priceLineEl.hidden = true;
  outputEl.classList.remove("correct", "wrong");
  inputEl.value = "";

  currentItem = getNextItem();
  if (!currentItem) return;
  showItem(currentItem, "item-name-a", "item-image-a");

  const upcoming = deck[deckIndex];
  if (upcoming) new Image().src = upcoming.image_url;

  priceLineEl.classList.remove("landed");
}

function submitRound() {
  if (!currentItem) return;

  const guess = Number(inputEl.value);

  if (inputEl.value === "" || Number.isNaN(guess) || guess <= 0) {
    outputEl.textContent = "Invalid input! Try again.";
    outputEl.hidden = false;
    return;
  }

  const realPrice = currentItem.price * YEN_TO_USD;
  const percentOff = (Math.abs(guess - realPrice) / realPrice) * 100;

  if (percentOff <= CORRECT_RANGE) {
    score += 1;
    outputEl.classList.add("correct");
  } else {
    misses += 1;
    outputEl.classList.add("wrong");
  }

  submitBtn.disabled = true;
  nextBtn.hidden = false;
  inputEl.disabled = true;

  if (misses >= MAX_MISSES) {
    gameOver();
    return;
  }

  outputEl.textContent = `You were ${percentOff.toFixed(0)}% off!`;
  outputEl.hidden = false;
  priceLineEl.hidden = false;
  animateNumber(priceCounterEl, realPrice, 800, () => {
    priceLineEl.classList.add("landed");
  });

  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: "smooth",
  });
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
function gameOver() {
  isGameOver = true;
  outputEl.textContent = `You Lost! You got a score of ${score}!`;
  outputEl.hidden = false;
  nextBtn.textContent = "Play Again";
}

function resetGame() {
  score = 0;
  misses = 0;
  isGameOver = false;
  deckIndex = deck.length;
  nextBtn.textContent = "Next";
  newRound();
}

submitBtn.addEventListener("click", submitRound);
nextBtn.addEventListener("click", () => {
  if (isGameOver) {
    resetGame();
  } else {
    newRound();
  }
});

allItemsToggle.addEventListener("change", () => {
  itemPool = buildPool(allItemsToggle.checked);
  resetGame();
});

newRound();
