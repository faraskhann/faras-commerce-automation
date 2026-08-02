/**
 * Storefront support chat widget.
 *
 * Drop into any theme with:
 *   <script src="https://your-backend.example.com/widget.js"
 *           data-api-url="https://your-backend.example.com"></script>
 *
 * Optional data attributes: data-title, data-greeting, data-accent.
 * No dependencies, no build step.
 */
(function () {
  "use strict";

  if (window.__supportChatWidgetLoaded) return;
  window.__supportChatWidgetLoaded = true;

  // currentScript is only valid while this script is executing, so read it now.
  var script =
    document.currentScript || document.querySelector("script[data-api-url]");
  var data = (script && script.dataset) || {};

  var API_URL = (data.apiUrl || "").replace(/\/+$/, "");
  if (!API_URL && script && script.src) {
    // Fall back to wherever this file was served from.
    API_URL = new URL(script.src, window.location.href).origin;
  }

  var TITLE = data.title || "Store support";
  var GREETING =
    data.greeting || "Hi! Ask me about an order or anything in the store.";
  var ACCENT = data.accent || "#2563eb";
  // data-auto-open="true" expands the chat window immediately on load — useful on
  // demo/test pages. Storefronts should leave it off and let shoppers open it.
  var AUTO_OPEN = data.autoOpen === "true";
  // Identifies which client store this widget belongs to on a multi-tenant
  // backend; sent with every /chat request. Omit only against a single-store
  // dev backend.
  var CLIENT_ID = data.clientId || null;

  // A fresh session on every page load, by design: nothing is persisted in
  // localStorage — no sessionId, no transcript — so a shared or public computer
  // never replays a previous visitor's conversation, and refresh always starts
  // an empty chat.
  function newSessionId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  var sessionId = newSessionId();

  /* ------------------------------------------------------------------ styles */

  var css =
    ".scw-bubble,.scw-panel,.scw-panel *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}" +
    ".scw-bubble{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:" +
    ACCENT +
    ";color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease}" +
    ".scw-bubble:hover{transform:scale(1.06)}" +
    ".scw-bubble svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2}" +
    ".scw-panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:2147483000;display:none;flex-direction:column;overflow:hidden}" +
    ".scw-panel.scw-open{display:flex}" +
    ".scw-header{background:#111827;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex:0 0 auto}" +
    ".scw-header h3{margin:0;font-size:15px;font-weight:600;line-height:1.2}" +
    ".scw-close{background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;opacity:.8}" +
    ".scw-close:hover{opacity:1}" +
    ".scw-log{flex:1 1 auto;overflow-y:auto;padding:14px;background:#f9fafb;display:flex;flex-direction:column;gap:10px}" +
    ".scw-msg{max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}" +
    ".scw-msg-bot{align-self:flex-start;background:#fff;color:#111827;border:1px solid #e5e7eb;border-bottom-left-radius:4px}" +
    ".scw-msg-user{align-self:flex-end;background:" +
    ACCENT +
    ";color:#fff;border-bottom-right-radius:4px}" +
    ".scw-msg-error{align-self:flex-start;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-bottom-left-radius:4px}" +
    ".scw-msg a{color:inherit;text-decoration:underline}" +
    ".scw-msg-bot a{color:" +
    ACCENT +
    "}" +
    ".scw-dots{display:inline-flex;gap:4px;align-items:center;height:18px}" +
    ".scw-dots i{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:scw-blink 1.2s infinite ease-in-out}" +
    ".scw-dots i:nth-child(2){animation-delay:.2s}" +
    ".scw-dots i:nth-child(3){animation-delay:.4s}" +
    "@keyframes scw-blink{0%,80%,100%{opacity:.3}40%{opacity:1}}" +
    ".scw-form{flex:0 0 auto;display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}" +
    ".scw-input{flex:1 1 auto;min-width:0;border:1px solid #d1d5db;border-radius:8px;padding:9px 11px;font-size:14px;color:#111827;background:#fff;outline:none}" +
    ".scw-input:focus{border-color:" +
    ACCENT +
    ";box-shadow:0 0 0 3px rgba(37,99,235,.15)}" +
    ".scw-send{flex:0 0 auto;border:0;border-radius:8px;background:" +
    ACCENT +
    ";color:#fff;padding:0 14px;font-size:14px;font-weight:600;cursor:pointer}" +
    ".scw-send:disabled,.scw-input:disabled{opacity:.55;cursor:not-allowed}" +
    "@media (max-width:420px){.scw-panel{right:12px;left:12px;width:auto;bottom:80px;height:calc(100vh - 100px)}.scw-bubble{right:12px;bottom:12px}}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  /* ------------------------------------------------------------------ markup */

  var bubble = document.createElement("button");
  bubble.className = "scw-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.6-.7L3 21l1.9-4.9A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/></svg>';

  var panel = document.createElement("div");
  panel.className = "scw-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);

  var header = document.createElement("div");
  header.className = "scw-header";
  var heading = document.createElement("h3");
  heading.textContent = TITLE;
  var closeBtn = document.createElement("button");
  closeBtn.className = "scw-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.innerHTML = "&times;";
  header.appendChild(heading);
  header.appendChild(closeBtn);

  var log = document.createElement("div");
  log.className = "scw-log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  var form = document.createElement("form");
  form.className = "scw-form";
  var input = document.createElement("input");
  input.className = "scw-input";
  input.type = "text";
  input.placeholder = "Type your message…";
  input.setAttribute("aria-label", "Message");
  input.autocomplete = "off";
  var send = document.createElement("button");
  send.className = "scw-send";
  send.type = "submit";
  send.textContent = "Send";
  form.appendChild(input);
  form.appendChild(send);

  panel.appendChild(header);
  panel.appendChild(log);
  panel.appendChild(form);

  function mount() {
    document.body.appendChild(bubble);
    document.body.appendChild(panel);
    if (AUTO_OPEN) openPanel();
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount);
  }

  /* ----------------------------------------------------------------- render */

  // Bare URLs, and markdown links in case a reply still carries formatting.
  var LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/g;

  /**
   * Append text to an element, turning URLs into anchors.
   * Built from DOM nodes rather than innerHTML so reply text can never inject markup.
   */
  function renderText(el, text) {
    var clean = String(text == null ? "" : text).replace(/\*\*(.+?)\*\*/g, "$1");
    var last = 0;
    var match;

    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(clean)) !== null) {
      if (match.index > last) {
        el.appendChild(document.createTextNode(clean.slice(last, match.index)));
      }

      var label = match[1];
      var href = match[2] || match[3];
      var trailing = "";

      // A bare URL at the end of a sentence swallows the punctuation; give it back.
      if (!label) {
        var trail = href.match(/[.,;:!?)]+$/);
        if (trail) {
          trailing = trail[0];
          href = href.slice(0, href.length - trailing.length);
        }
      }

      var anchor = document.createElement("a");
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = label || href;
      el.appendChild(anchor);

      if (trailing) el.appendChild(document.createTextNode(trailing));
      last = match.index + match[0].length;
    }

    if (last < clean.length) {
      el.appendChild(document.createTextNode(clean.slice(last)));
    }
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "scw-msg scw-msg-" + role;
    renderText(el, text);
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function addTyping() {
    var el = document.createElement("div");
    el.className = "scw-msg scw-msg-bot";
    el.setAttribute("aria-label", "Assistant is typing");
    el.innerHTML = '<span class="scw-dots"><i></i><i></i><i></i></span>';
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  // Every page load starts an empty conversation — no cached history is restored.
  addMessage("bot", GREETING);

  /* ------------------------------------------------------------------- send */

  var busy = false;

  function setBusy(value) {
    busy = value;
    input.disabled = value;
    send.disabled = value;
  }

  async function sendMessage(text) {
    addMessage("user", text);
    var typing = addTyping();
    setBusy(true);

    try {
      var body = { message: text, sessionId: sessionId };
      if (CLIENT_ID) body.client_id = CLIENT_ID;

      var response = await fetch(API_URL + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      var payload = null;
      try {
        payload = await response.json();
      } catch (e) {
        payload = null;
      }

      typing.remove();

      if (!response.ok) {
        addMessage(
          "error",
          (payload && payload.error) ||
            "Sorry, something went wrong on our end. Please try again in a moment."
        );
      } else if (payload && payload.reply) {
        addMessage("bot", payload.reply);
      } else {
        addMessage("error", "Sorry, I didn't get a reply. Please try again.");
      }
    } catch (e) {
      typing.remove();
      addMessage(
        "error",
        "Sorry, I couldn't reach support just now. Please check your connection and try again."
      );
    } finally {
      setBusy(false);
      if (panel.classList.contains("scw-open")) input.focus();
    }
  }

  /* ----------------------------------------------------------------- events */

  function openPanel() {
    panel.classList.add("scw-open");
    bubble.setAttribute("aria-label", "Close chat");
    scrollToEnd();
    if (!busy) input.focus();
  }

  function closePanel() {
    panel.classList.remove("scw-open");
    bubble.setAttribute("aria-label", "Open chat");
  }

  bubble.addEventListener("click", function () {
    if (panel.classList.contains("scw-open")) closePanel();
    else openPanel();
  });

  closeBtn.addEventListener("click", closePanel);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && panel.classList.contains("scw-open")) closePanel();
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    sendMessage(text);
  });

  // Small public API so host pages can control the widget (demo page, a custom
  // "Chat with us" link in the theme, etc.).
  window.SupportChatWidget = {
    open: openPanel,
    close: closePanel,
    toggle: function () {
      if (panel.classList.contains("scw-open")) closePanel();
      else openPanel();
    },
    isOpen: function () {
      return panel.classList.contains("scw-open");
    },
    send: function (text) {
      var trimmed = String(text == null ? "" : text).trim();
      if (!trimmed || busy) return false;
      openPanel();
      sendMessage(trimmed);
      return true;
    },
  };
})();
