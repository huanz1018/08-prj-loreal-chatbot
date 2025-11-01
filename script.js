/* DOM elements */
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");
const chatWindow = document.getElementById("chatWindow");
const latestQuestionEl = document.getElementById("latestQuestion");

// Set initial message
chatWindow.textContent = "👋 Hello! How can I help you today?";

/* --------------------- New: Chat with OpenAI --------------------- */
// System prompt: restrict assistant to L'Oréal products, routines and recommendations
const systemPrompt = `You are the L'Oréal Smart Product Advisor. Only answer questions about L'Oréal brands, products, skincare and haircare routines, and product recommendations from L'Oréal. If a user asks about topics outside this scope (including other brands, general medical/legal advice, politics, or unrelated topics), politely refuse with a short, friendly message such as: "I'm sorry — I can only help with L'Oréal products and beauty routines. If you'd like, I can suggest L'Oréal alternatives or product recommendations." After refusing, always offer a helpful L'Oréal-focused alternative or redirect. Provide concise, factual product suggestions, recommended usage, ingredient considerations relevant to skin/hair type, and note regional availability when relevant. Do not invent endorsements, medical diagnoses, or claim regulatory approvals. Keep tone professional, helpful, and brand-consistent.`;

// Conversation history (starts with system role)
let conversation = [{ role: "system", content: systemPrompt }];

// Persistence keys
const STORAGE_KEYS = {
  conversation: "loreal_chat_conversation",
  userName: "loreal_chat_userName",
};

// Trimming config
const MAX_CONVERSATION_MESSAGES = 40; // keep recent messages to limit token size

// User name (detected or provided)
let userName = "";

// Utility: escape HTML before inserting into the page
function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  // allow simple newlines but escape HTML
  el.innerHTML = escapeHtml(text).replaceAll("\n", "<br>");
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function renderConversation() {
  chatWindow.innerHTML = "";
  // skip system messages when rendering
  conversation.forEach((m) => {
    if (m.role === "system") return;
    appendMessage(m.role === "assistant" ? "ai" : m.role, m.content);
  });
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.conversation,
      JSON.stringify(conversation)
    );
    localStorage.setItem(STORAGE_KEYS.userName, userName || "");
  } catch (e) {
    console.warn("Could not save chat state", e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.conversation);
    const name = localStorage.getItem(STORAGE_KEYS.userName);
    if (name) userName = name;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        if (!parsed.some((m) => m.role === "system")) {
          parsed.unshift({ role: "system", content: systemPrompt });
        }
        conversation = parsed;
      }
    }
  } catch (e) {
    console.warn("Could not load chat state", e);
  }
}

function trimConversation() {
  const sys = conversation.find((m) => m.role === "system");
  const others = conversation.filter((m) => m.role !== "system");
  const trimmed = others.slice(-MAX_CONVERSATION_MESSAGES);
  conversation = [sys, ...trimmed];
}

function detectAndSaveUserName(text) {
  const m = text.match(/(?:my name is|i am|i'm)\s+([A-Z][a-zA-Z\-']{1,30})/i);
  if (m && m[1]) {
    userName = m[1];
    saveState();
  }
}

function setLoading(isLoading) {
  const btn = document.getElementById("sendBtn");
  if (!btn) return;
  btn.disabled = isLoading;
  if (isLoading) btn.style.opacity = "0.6";
  else btn.style.opacity = "";
}

async function sendMessageToOpenAI(messageText) {
  // conversation should already contain the user message (pushed by caller)
  // Trim before sending to limit size
  trimConversation();
  const workerPayload = { messages: conversation };

  // Determine worker URL: prefer a `cfWorkerUrl` variable defined in `secrets.js`.
  // If not set, warn and fallback to OpenAI direct endpoint (not recommended).
  const workerUrl =
    typeof cfWorkerUrl !== "undefined" && cfWorkerUrl ? cfWorkerUrl : null;

  try {
    setLoading(true);

    let res;
    if (workerUrl) {
      // Send to Cloudflare Worker which holds the OpenAI key server-side
      res = await fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(workerPayload),
      });
    } else {
      // Fallback: call OpenAI directly using apiKey in secrets.js (not secure in production)
      console.warn(
        "cfWorkerUrl not configured; falling back to direct OpenAI API call. This is not secure for production."
      );
      const payload = {
        model: "gpt-4o",
        messages: conversation,
        temperature: 0.2,
      };
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`API error: ${res.status} ${txt}`);
    }

    const data = await res.json();
    // Helpful debug output for unexpected response shapes
    console.debug("API response", data);

    // Try multiple common locations for assistant text
    let assistantMessage = null;
    if (data?.choices && data.choices.length > 0) {
      const choice = data.choices[0];
      assistantMessage =
        choice?.message?.content ??
        choice?.delta?.content ??
        choice?.text ??
        null;
    }

    // Some proxies or workers may wrap the OpenAI response inside a `body` field
    if (!assistantMessage && data && data.body) {
      try {
        const parsed =
          typeof data.body === "string" ? JSON.parse(data.body) : data.body;
        const choice = parsed?.choices?.[0];
        assistantMessage =
          choice?.message?.content ??
          choice?.delta?.content ??
          choice?.text ??
          null;
      } catch (e) {
        // ignore parse errors
      }
    }

    if (!assistantMessage) {
      // If OpenAI returned an error object, surface that message
      if (data?.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        throw new Error(`OpenAI error: ${msg}`);
      }
      console.error(
        "Unexpected API response shape — full response logged above"
      );
      throw new Error(
        "No assistant message in response — see console for full API response"
      );
    }

    // Save assistant reply to conversation, persist, and render
    conversation.push({ role: "assistant", content: assistantMessage });
    saveState();
    appendMessage("ai", assistantMessage);
  } catch (err) {
    console.error("sendMessageToOpenAI error:", err);
    // Provide a clearer message for network/fetch errors (common developer pain point)
    let friendlyMessage = `Sorry — there was an error getting a response.`;
    const isNetworkErr =
      err instanceof TypeError || /failed to fetch/i.test(err.message || "");
    if (isNetworkErr) {
      if (workerUrl) {
        friendlyMessage = `Network error: could not reach the Cloudflare Worker at ${workerUrl}. Make sure the worker is deployed and that CORS/OPENAI_API_KEY are configured. See console for details.`;
      } else {
        friendlyMessage = `Network error: could not reach the OpenAI API. Check your internet connection and API key configuration. See console for details.`;
      }
    } else if (err.message) {
      friendlyMessage = `Error: ${err.message}`;
    }

    appendMessage("ai", friendlyMessage);
  } finally {
    setLoading(false);
  }
}

/* Wire up the form to send messages */
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;

  // record in conversation and detect name
  conversation.push({ role: "user", content: text });
  detectAndSaveUserName(text);
  saveState();

  // show user's message in UI and show latest question
  appendMessage("user", text);
  if (latestQuestionEl) latestQuestionEl.textContent = text;
  userInput.value = "";

  // send request to worker/openai
  await sendMessageToOpenAI(text);
});

// Initialization: load saved conversation (if any) and render
loadState();
renderConversation();

// If no previous conversation, show a branded greeting
if (!conversation || conversation.length <= 1) {
  chatWindow.innerHTML = "";
  appendMessage(
    "ai",
    "👋 Welcome to the L'Oréal Smart Product Advisor. Ask me about L'Oréal products, routines or recommendations."
  );
} else {
  // set latest question to the last user message (if any)
  const lastUser = [...conversation].reverse().find((m) => m.role === "user");
  if (lastUser && latestQuestionEl)
    latestQuestionEl.textContent = lastUser.content;
}
