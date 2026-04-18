// Popup controller for extraction, classification, and DApp bridging.

// Standard 5 Categories
const CATEGORIES = ["crypto", "ai", "finance", "gaming", "dev"];

// State machine configuration
const STATES = [
  "state-idle",
  "state-extracting",
  "state-domains",
  "state-classifying",
  "state-interests",
  "state-encrypting",
  "state-matching",
  "state-results",
];

const STATE_TO_STEP = {
  "state-idle": 1,
  "state-extracting": 1,
  "state-domains": 1,
  "state-classifying": 2,
  "state-interests": 2,
  "state-encrypting": 3,
  "state-matching": 4,
  "state-results": 4,
};

let currentState = "state-idle";
let extractedDomains = [];
let userVector = [0, 0, 0, 0, 0];
// Note: classifierPipeline lives in the background service worker, not here.

// DOM Events
document.addEventListener("DOMContentLoaded", () => {
  // Buttons
  document.getElementById("btn-extract").addEventListener("click", startExtraction);
  document.getElementById("btn-classify").addEventListener("click", startClassification);
  document.getElementById("btn-encrypt").addEventListener("click", startEncryption);
  document.getElementById("btn-restart").addEventListener("click", restart);

  // Initialize Aesthetics
  initAesthetics();
  initBlurLoad();
  initBlurText("idle-heading", 150);

  // Reactivity texts
  const typingTexts = [
    "Private Attention Market",
    "Zero-Knowledge Matching",
    "FHE Enabled Bidding"
  ];
  initTypingEffect("header-subtitle", typingTexts, 60, 40, 2000);
  
  pollModelStatus();
});

async function pollModelStatus() {
  const banner = document.getElementById('model-loading-banner');
  const check = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'modelStatus' });
      if (res?.ready) {
        banner.classList.add('hidden');
        return;
      }
      banner.classList.remove('hidden');
      if (res?.progress) {
        document.getElementById('model-progress').textContent = `Downloading (${res.progress}%)`;
        document.getElementById('model-progress-fill').style.width = `${res.progress}%`;
      }
    } catch(e) {}
    setTimeout(check, 1000);
  };
  check();
}

// UI state transitions
function goToState(stateId) {
  document.querySelectorAll(".state-panel").forEach((el) => el.classList.remove("active"));
  const target = document.getElementById(stateId);
  if (target) target.classList.add("active");
  currentState = stateId;
  updateStepper(stateId);
}

function updateStepper(stateId) {
  const activeStep = STATE_TO_STEP[stateId] || 1;
  const steps = document.querySelectorAll(".step");
  const lines = document.querySelectorAll(".step-line");

  steps.forEach((s, i) => {
    const stepNum = i + 1;
    s.classList.remove("active", "done");
    if (stepNum < activeStep) s.classList.add("done");
    else if (stepNum === activeStep) s.classList.add("active");
  });

  lines.forEach((line, i) => {
    if (i + 1 < activeStep) line.classList.add("filled");
    else line.classList.remove("filled");
  });
}

// Utility functions
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateHex(length) {
  const chars = "0123456789abcdef";
  let hex = "0x";
  for (let i = 0; i < length; i++) {
    hex += chars[Math.floor(Math.random() * 16)];
  }
  return hex;
}

// History extraction
let extractedTitles = [];
let extractedRecencyWeights = [];

async function startExtraction() {
  goToState("state-extracting");

  chrome.runtime.sendMessage({ action: "extractHistory" }, (response) => {
    if (chrome.runtime.lastError) {
      document.getElementById("extract-status").textContent =
        "Error: " + chrome.runtime.lastError.message;
      return;
    }

    if (response && response.status === "success") {
      extractedDomains = response.domains;
      extractedTitles = response.titles || [];
      extractedRecencyWeights = response.recencyWeights || extractedDomains.map(() => 1);
      showDomains(extractedDomains);
    }
  });
}

function showDomains(domains) {
  const list = document.getElementById("domain-list");
  const count = document.getElementById("domain-count");
  list.innerHTML = "";
  count.textContent = domains.length;

  domains.forEach((d) => {
    const li = document.createElement("li");
    li.textContent = d;
    li.classList.add("blur-reveal");
    list.appendChild(li);
  });

  goToState("state-domains");
}

// Intent classification logic
async function startClassification() {
  goToState("state-classifying");

  // Check if the background worker's model is ready
  const statusRes = await chrome.runtime.sendMessage({ action: "modelStatus" });
  if (!statusRes?.ready) {
    document.querySelector("#state-classifying h2").textContent = "Loading AI Model...";
    document.querySelector("#state-classifying .panel-desc").textContent =
      "AdScience AI is initializing in the background (one-time ~25 MB download). Please wait...";
  } else {
    document.querySelector("#state-classifying h2").textContent = "Running Inference...";
    document.querySelector("#state-classifying .panel-desc").textContent =
      "Mapping history onto weighted interest scores...";
  }

  try {
    // Send domains and titles to the background service worker for classification
    const response = await chrome.runtime.sendMessage({
      action: "classify",
      domains: extractedDomains,
      titles: extractedTitles,
      recencyWeights: extractedRecencyWeights,
    });

    if (response?.status === "processing") {
      const poll = async () => {
        try {
          const res = await chrome.runtime.sendMessage({ action: "classify", domains: [], titles: [] });
          if (res?.status === "success" && res.vector) {
            userVector = res.vector;
            showInterests(userVector);
          } else {
            setTimeout(poll, 2000);
          }
        } catch(e) {
            setTimeout(poll, 2000);
        }
      };
      setTimeout(poll, 3000);
      return;
    }

    if (response?.status === "success") {
      userVector = response.vector;
    } else {
      console.error("[Popup] Classification error:", response?.message);
      // Graceful fallback so the user can still proceed
      userVector = [60, 40, 0, 0, 50];
    }
  } catch (err) {
    console.error("[Popup] Messaging error:", err.message);
    userVector = [60, 40, 0, 0, 50];
  }

  showInterests(userVector);
}

function showInterests(vector) {
  const container = document.getElementById("interest-tags");
  container.innerHTML = "";

  CATEGORIES.forEach((cat, i) => {
    const tag = document.createElement("span");
    tag.className = `tag ${vector[i] > 0 ? "active" : "inactive"}`;
    tag.innerHTML = `${cat} <strong>${vector[i]}%</strong>`;
    if (vector[i] > 0) {
      tag.style.opacity = `${0.4 + (vector[i] / 100) * 0.6}`;
    }
    container.appendChild(tag);
  });

  const vecStr = `[${vector.join(", ")}]`;
  document.getElementById("vector-code").textContent = vecStr;
  decryptText(document.getElementById("vector-code"), vecStr, 50);
  goToState("state-interests");
}

// DApp payload delivery
async function startEncryption() {
  goToState("state-encrypting");

  const hexBlob = document.getElementById("hex-blob");
  hexBlob.textContent = "Locating Active EAX Next.js Instance...\n";

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0) return;

    chrome.tabs.sendMessage(tabs[0].id, { type: "EAX_USER_VECTOR_TO_APP", vector: userVector }, function (response) {
      if (chrome.runtime.lastError) {
        hexBlob.textContent += "Error: Connect securely via localhost:3000 to trigger CoFHE primitives.";
      } else {
        hexBlob.textContent += "Vector securely injected into Metamask context.\n";

        setTimeout(() => {
          goToState("state-results");
          const el = document.getElementById("res-winner");
          el.textContent = "Awaiting Fhenix Tx";
          document.getElementById("res-advertisers").textContent = "On-Chain";
          document.getElementById("res-payout").innerHTML = `Confirm in wallet`;
        }, 1200);
      }
    });
  });
}

// ==== Restart ====
function restart() {
  extractedDomains = [];
  userVector = [0, 0, 0, 0, 0];
  extractedTitles = [];
  extractedRecencyWeights = [];
  goToState("state-idle");
}

// Aesthetic effects (spotlight, magnetic, decrypt)
function initAesthetics() {
  // Spotlight on panels (monochrome white glow via CSS)
  document.addEventListener("mousemove", (e) => {
    document.querySelectorAll(".panel-card").forEach((card) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      card.style.setProperty("--mouse-x", `${x}px`);
      card.style.setProperty("--mouse-y", `${y}px`);
    });
  });

  // Magnetic Buttons
  document.querySelectorAll(".btn").forEach((btn) => {
    btn.classList.add("magnetic");
    btn.addEventListener("mousemove", (e) => {
      const rect = btn.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      btn.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px)`;
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = `translate(0px, 0px)`;
    });
  });
}

function decryptText(element, finalString, speed = 30) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()";
  let iterations = 0;
  element.classList.add("decrypt-text");

  const interval = setInterval(() => {
    element.innerText = finalString
      .split("")
      .map((letter, index) => {
        if (index < iterations) {
          return finalString[index];
        }
        return chars[Math.floor(Math.random() * chars.length)];
      })
      .join("");

    if (iterations >= finalString.length) {
      clearInterval(interval);
      element.classList.remove("decrypt-text");
    }

    iterations += 1 / 3;
  }, speed);
}

function animateCountUp(element, endValue, duration) {
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 4);
    element.innerText = Math.floor(easeOut * endValue);

    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      element.innerText = endValue;
    }
  };
  window.requestAnimationFrame(step);
}

// Initial load animations
function initTypingEffect(elementId, texts, typeSpeed = 50, deleteSpeed = 30, pause = 1500) {
  const el = document.getElementById(elementId);
  if (!el) return;

  el.classList.add("typing-cursor");
  let textIndex = 0;
  let charIndex = 0;
  let isDeleting = false;

  function type() {
    const currentText = texts[textIndex];
    if (isDeleting) {
      el.textContent = currentText.substring(0, charIndex - 1);
      charIndex--;
    } else {
      el.textContent = currentText.substring(0, charIndex + 1);
      charIndex++;
    }

    let speed = isDeleting ? deleteSpeed : typeSpeed;

    if (!isDeleting && charIndex === currentText.length) {
      speed = pause;
      isDeleting = true;
    } else if (isDeleting && charIndex === 0) {
      isDeleting = false;
      textIndex = (textIndex + 1) % texts.length;
      speed = 300;
    }

    setTimeout(type, speed);
  }

  el.textContent = "";
  setTimeout(type, 300);
}

function initBlurLoad() {
  const elementsToBlur = document.querySelectorAll('.stepper, .panel-card');
  elementsToBlur.forEach((el, index) => {
    el.style.opacity = '0';
    el.style.filter = 'blur(12px)';
    el.style.animation = `blurRevealEffect 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards`;
    el.style.animationDelay = `${index * 150}ms`;
  });
}

function initBlurText(elementId, delay = 100) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const words = el.textContent.split(' ');
  el.innerHTML = '';

  words.forEach((word, index) => {
    const span = document.createElement('span');
    span.textContent = word + (index < words.length - 1 ? '\u00A0' : '');
    span.style.opacity = '0';
    span.style.filter = 'blur(10px)';
    span.style.transform = 'translateY(5px)';
    span.style.display = 'inline-block';

    span.style.animation = `blurRevealEffect 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards`;
    span.style.animationDelay = `${400 + index * delay}ms`;

    el.appendChild(span);
  });
}
