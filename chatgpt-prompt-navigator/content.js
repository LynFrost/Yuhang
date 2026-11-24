(() => {
  "use strict";

  const ROOT_ID = "cgpt-prompt-navigator-root";
  const SHELL_SELECTOR = '[data-testid^="conversation-turn-"]';
  const NEW_USER_UNIT_SELECTOR =
    '[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]';
  const NEW_TURN_SELECTOR = "[data-turn-key]";
  const CHAT_SCROLL_SELECTOR = ".thread-scroll-container";

  const state = {
    prompts: [],
    labelCache: new Map(),
    apiCache: new Map(),
    apiKnowledge: null,
    apiRequestSeq: 0,
    apiAttemptAt: 0,
    apiStatus: "等待索引",
    apiStatusTitle: "",
    token: null,
    tokenAt: -Infinity,
    routeKey: location.pathname,
    fingerprint: "",
    collapsed: false,
    refreshTimer: null,
    scrollTicking: false,
    selectedIndex: -1,
    navigationSeq: 0,
    navigationTimer: null,
    navigationActive: false,
    navigationTargetIndex: -1,
    navigationOriginIndex: -1,
    navigationFeedback: "",
    navigationReason: "",
    navigationRecoveryAttempts: 0,
    navigationLocatedTop: null,
    pendingRefresh: false
  };

  function normalizeText(text) {
    return (text || "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
  }

  function conversationIdFromPath() {
    const match = /\/c\/([0-9a-f-]{8,})/i.exec(location.pathname);
    return match ? match[1] : null;
  }

  function shellKey(shell, fallbackIndex) {
    const testId = shell.getAttribute("data-testid") || "";
    const match = /conversation-turn-(\d+)/.exec(testId);
    return match ? "turn-" + match[1] : "idx-" + fallbackIndex;
  }

  function shellRole(shell) {
    const explicit = shell.getAttribute("data-turn");
    if (explicit === "user" || explicit === "assistant") return explicit;
    if (shell.querySelector('[data-message-author-role="user"]')) return "user";
    if (shell.querySelector('[data-message-author-role="assistant"]')) return "assistant";
    return "";
  }

  function scanUserShells() {
    const root = document.querySelector("main") || document;
    const shells = [...root.querySelectorAll(SHELL_SELECTOR)];
    const users = [];

    for (const shell of shells) {
      if (shellRole(shell) !== "user") continue;
      users.push({
        key: shellKey(shell, users.length),
        shell
      });
    }

    if (users.length) return users;

    const legacyUsers = [
      ...root.querySelectorAll('[data-message-author-role="user"]')
    ].map((node, index) => ({
      key: "message-" + (node.getAttribute("data-message-id") || index),
      shell: node.closest("[data-message-id], article, section, div") || node
    }));

    return legacyUsers;
  }

  function mountedPromptText(shell) {
    if (!shell || !shell.isConnected) return "";

    const roleNode = shell.matches('[data-message-author-role="user"]')
      ? shell
      : shell.querySelector('[data-message-author-role="user"]') || shell;

    const candidates = [];

    roleNode
      .querySelectorAll(".user-message-bubble-color")
      .forEach((node) => {
        const text = normalizeText(node.innerText || node.textContent);
        if (text) candidates.push(text);
      });

    roleNode
      .querySelectorAll("button .line-clamp-3")
      .forEach((node) => {
        const text = normalizeText(node.innerText || node.textContent);
        if (text) candidates.push(text);
      });

    const legacy = roleNode.querySelector(".whitespace-pre-wrap");
    if (legacy) {
      const text = normalizeText(legacy.innerText || legacy.textContent);
      if (text) candidates.push(text);
    }

    if (!candidates.length) {
      const text = normalizeText(roleNode.innerText || roleNode.textContent);
      if (text) candidates.push(text);
    }

    return candidates.sort((a, b) => b.length - a.length)[0] || "";
  }

  function mountedMessageId(shell) {
    if (!shell || !shell.isConnected) return "";
    const node = shell.matches("[data-message-id]")
      ? shell
      : shell.querySelector("[data-message-id]");
    return node ? node.getAttribute("data-message-id") || "" : "";
  }

  function apiMessageText(message) {
    const content = message && message.content;
    if (!content) return "";

    if (
      content.content_type === "text" ||
      content.content_type === "multimodal_text"
    ) {
      return (content.parts || [])
        .filter((part) => typeof part === "string")
        .join("\n\n")
        .trim();
    }

    return "";
  }

  function linearizeVisibleUserMessages(data) {
    const mapping = data && data.mapping;
    if (!mapping) return [];

    const chain = [];
    let node = data.current_node ? mapping[data.current_node] : null;

    for (let hops = 0; node && hops < 10000; hops += 1) {
      chain.push(node);
      node = node.parent ? mapping[node.parent] : null;
    }

    chain.reverse();

    const result = [];

    for (const entry of chain) {
      const message = entry && entry.message;
      if (!message || !message.author || message.author.role !== "user") continue;
      if (message.recipient && message.recipient !== "all") continue;
      if (
        message.metadata &&
        message.metadata.is_visually_hidden_from_conversation
      ) {
        continue;
      }

      const text = normalizeText(apiMessageText(message));
      result.push({
        id: message.id || "",
        text: text || "[图片/附件提问]"
      });
    }

    return result;
  }

  async function fetchAccessToken() {
    if (state.token && performance.now() - state.tokenAt < 10 * 60 * 1000) {
      return state.token;
    }

    const response = await fetch("/api/auth/session", {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("session HTTP " + response.status);
    }

    const data = await response.json();
    if (!data || !data.accessToken) {
      throw new Error("没有拿到当前登录会话的 access token");
    }

    state.token = data.accessToken;
    state.tokenAt = performance.now();
    return state.token;
  }

  async function fetchConversationPrompts(conversationId) {
    const token = await fetchAccessToken();
    const response = await fetch("/backend-api/conversation/" + conversationId, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Authorization: "Bearer " + token
      }
    });

    if (response.status === 401 || response.status === 403) {
      state.token = null;
      state.tokenAt = -Infinity;
    }

    if (!response.ok) {
      throw new Error("conversation HTTP " + response.status);
    }

    return linearizeVisibleUserMessages(await response.json());
  }

  function apiPromptsAsPrimary() {
    const knowledge = state.apiKnowledge;
    if (!knowledge || !Array.isArray(knowledge.prompts)) return [];

    return knowledge.prompts.map((apiPrompt, index) => ({
      key: "api-" + (apiPrompt.id || index),
      text: apiPrompt.text || "[图片/附件提问]",
      messageId: apiPrompt.id || ""
    }));
  }

  function legacyDomPrompts() {
    return scanUserShells().map((item, index) => {
      const mountedText = mountedPromptText(item.shell);
      const mountedId = mountedMessageId(item.shell);
      const cached = state.labelCache.get(item.key) || {
        text: "",
        messageId: ""
      };

      if (mountedText) cached.text = mountedText;
      if (mountedId) cached.messageId = mountedId;
      state.labelCache.set(item.key, cached);

      return {
        key: item.key,
        text: cached.text || "提问 " + (index + 1),
        messageId: cached.messageId || ""
      };
    });
  }

  function textMatchNeedle(text) {
    const normalized = normalizeText(text);
    if (!normalized) return "";
    return normalized.slice(0, Math.min(48, normalized.length));
  }

  function messageIdsFromElement(element) {
    const raw =
      (element && element.getAttribute("data-chatgpt-search-message-ids")) || "";
    return raw
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function currentPromptIndexByMessageId() {
    const map = new Map();
    state.prompts.forEach((prompt, index) => {
      if (prompt.messageId) map.set(prompt.messageId, index);
    });
    return map;
  }

  // Hidden conversation nodes are not usable scroll anchors, even with matching IDs.
  function elementHasLayout(element) {
    if (!element || !element.isConnected) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse") {
        return false;
      }
      // display: contents has no box, but its descendants can be visible.
      // A target with no box is not itself safe for scrollIntoView().
      if (style.display === "contents") {
        if (node === element) return false;
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
    }
    return true;
  }

  function positionableAnchor(element) {
    if (!element || !element.isConnected) return null;
    if (elementHasLayout(element)) return element;
    if (getComputedStyle(element).display !== "contents") return null;

    // Only a visible descendant of this same user-message unit may substitute
    // for a display: contents wrapper with no scrollable box.
    const selector =
      '[data-user-message-bubble="true"], [data-message-author-role="user"], ' +
      '.user-message-bubble-color, .text-size-chat, .whitespace-pre-wrap';
    for (const child of element.querySelectorAll(selector)) {
      if (elementHasLayout(child)) return child;
    }
    return null;
  }

  function findNewUserUnitByMessageId(messageId, scroller) {
    if (!messageId || !scroller) return null;
    for (const unit of scroller.querySelectorAll(NEW_USER_UNIT_SELECTOR)) {
      if (!messageIdsFromElement(unit).includes(messageId)) continue;
      const anchor = positionableAnchor(unit);
      if (anchor) return anchor;
    }
    return null;
  }

  function findTurnByMessageId(messageId, scroller) {
    if (!messageId || !scroller) return null;
    for (const turn of scroller.querySelectorAll(NEW_TURN_SELECTOR)) {
      if (turn.getAttribute("data-turn-key") !== messageId) continue;
      const anchor = positionableAnchor(turn);
      if (anchor) return anchor;
    }
    return null;
  }

  function findLegacyMessageElement(messageId, scroller) {
    if (!messageId || !scroller) return null;
    for (const element of scroller.querySelectorAll("[data-message-id]")) {
      if (element.getAttribute("data-message-id") !== messageId) continue;
      const anchor = positionableAnchor(element);
      if (anchor) return anchor;
    }
    return null;
  }

  function findTextFallbackElement(prompt, scroller) {
    if (!scroller) return null;
    const needle = textMatchNeedle(prompt && prompt.text);
    if (needle.length < 6) return null;
    const selector =
      '[data-user-message-bubble="true"], .text-size-chat, .whitespace-pre-wrap';
    let best = null;
    let bestScore = Infinity;
    for (const element of scroller.querySelectorAll(selector)) {
      if (!elementHasLayout(element)) continue;
      const userAncestor = element.closest(
        '[data-chatgpt-search-unit-key$=":user"], [data-message-author-role="user"], [data-user-message-bubble="true"]'
      );
      if (!userAncestor) continue;
      const text = normalizeText(element.innerText || element.textContent);
      if (!text) continue;
      const exact = text === prompt.text;
      const starts = text.startsWith(needle);
      const contains = text.includes(needle);
      if (!exact && !starts && !contains) continue;
      const score = (exact ? 0 : starts ? 100 : 300) +
        Math.abs(text.length - prompt.text.length);
      if (score < bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  function resolvePromptElement(prompt, scroller = primaryScrollContainer()) {
    if (!prompt || !scroller) return null;
    return (
      findNewUserUnitByMessageId(prompt.messageId, scroller) ||
      findTurnByMessageId(prompt.messageId, scroller) ||
      findLegacyMessageElement(prompt.messageId, scroller) ||
      findTextFallbackElement(prompt, scroller)
    );
  }

  // "当前" counts only actual usable anchors in the active conversation.
  function currentMountedPromptEntries(scroller = primaryScrollContainer()) {
    if (!scroller) return [];
    const indexById = currentPromptIndexByMessageId();
    const entries = [];
    const seen = new Set();
    for (const unit of scroller.querySelectorAll(NEW_USER_UNIT_SELECTOR)) {
      const anchor = positionableAnchor(unit);
      if (!anchor) continue;
      for (const id of messageIdsFromElement(unit)) {
        const index = indexById.get(id);
        if (index === undefined || seen.has(index)) continue;
        seen.add(index);
        entries.push({ index, element: anchor });
        break;
      }
    }
    for (const turn of scroller.querySelectorAll(NEW_TURN_SELECTOR)) {
      const index = indexById.get(turn.getAttribute("data-turn-key") || "");
      if (index === undefined || seen.has(index)) continue;
      const anchor = positionableAnchor(turn);
      if (!anchor) continue;
      seen.add(index);
      entries.push({ index, element: anchor });
    }
    entries.sort((a, b) => a.index - b.index);
    return entries;
  }

  function updateStatusUi() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const status = root.querySelector(".cgpt-nav-status");
    if (!status) return;
    const total = state.prompts.length;
    const mounted = currentMountedPromptEntries().length;
    const suffix = state.navigationFeedback ? " · " + state.navigationFeedback : "";
    const note = state.navigationReason ? "；" + state.navigationReason : "";
    if (state.apiKnowledge && Array.isArray(state.apiKnowledge.prompts)) {
      status.textContent = total + "条 · 当前" + mounted + "/" + total + suffix;
      status.title =
        "目录来自完整会话数据；“当前”仅表示活动会话中可直接定位的锚点数量。" +
        "0 个锚点时仍可在有效滚动容器内尝试渐进寻找。" + note;
      return;
    }
    status.textContent = state.apiStatus + suffix;
    status.title = (state.apiStatusTitle || state.apiStatus) + note;
  }

  async function prefetchConversation(force = false) {
    const conversationId = conversationIdFromPath();
    if (!conversationId) {
      state.apiKnowledge = null;
      state.apiStatus = "本地索引";
      state.apiStatusTitle = "当前不是标准 /c/ 会话地址，使用页面 turn 外壳和本地缓存。";
      updateStatusUi();
      return;
    }

    const cached = state.apiCache.get(conversationId);
    if (!force && cached && cached.prompts) {
      state.apiKnowledge = cached;
      state.apiStatus = "完整索引";
      state.apiStatusTitle = "已从当前 ChatGPT 会话的只读数据构建完整提问目录。";
      refreshIndex(false);
      return;
    }

    state.apiAttemptAt = Date.now();
    const requestSeq = ++state.apiRequestSeq;
    state.apiStatus = "读取中…";
    state.apiStatusTitle = "正在读取当前聊天的完整提问列表。";
    updateStatusUi();

    try {
      const prompts = await fetchConversationPrompts(conversationId);
      if (requestSeq !== state.apiRequestSeq) return;
      if (conversationId !== conversationIdFromPath()) return;

      const knowledge = {
        id: conversationId,
        prompts,
        fetchedAt: Date.now()
      };

      state.apiCache.set(conversationId, knowledge);
      state.apiKnowledge = knowledge;
      state.apiStatus = "完整索引";
      state.apiStatusTitle =
        "完整提问文本来自当前 ChatGPT 会话的只读同源数据；不会发送到第三方。";
      refreshIndex(false);
    } catch (error) {
      if (requestSeq !== state.apiRequestSeq) return;
      state.apiKnowledge = null;
      state.apiStatus = "本地索引";
      state.apiStatusTitle =
        "完整会话读取失败，已退回 turn 外壳 + 已见文本缓存：" +
        (error && error.message ? error.message : String(error));
      refreshIndex(false);
    }
  }

  function makeFingerprint(prompts) {
    return [
      state.routeKey,
      prompts.length,
      ...prompts.map((prompt) => prompt.key + ":" + prompt.text.slice(0, 160))
    ].join("\u241f");
  }

  function refreshIndex() {
    if (location.pathname !== state.routeKey) {
      resetForRoute();
      return;
    }

    const apiPrompts = apiPromptsAsPrimary();
    const prompts = apiPrompts.length ? apiPrompts : legacyDomPrompts();

    const fingerprint = makeFingerprint(prompts);
    state.prompts = prompts;

    if (fingerprint !== state.fingerprint) {
      state.fingerprint = fingerprint;
      renderList();
    } else {
      updateActiveItem();
      updateStatusUi();
    }
  }

  function scheduleRefresh(delay = 120) {
    if (state.navigationActive) {
      state.pendingRefresh = true;
      return;
    }

    clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(refreshIndex, delay);
  }

  function explicitThemeHint() {
    const html = document.documentElement;
    const body = document.body;
    const values = [
      html && html.getAttribute("data-theme"),
      html && html.getAttribute("data-color-scheme"),
      html && html.getAttribute("data-color-mode"),
      body && body.getAttribute("data-theme"),
      body && body.getAttribute("data-color-scheme"),
      body && body.getAttribute("data-color-mode")
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    const classes = [
      html && html.className,
      body && body.className
    ]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();

    if (values.some((value) => value.includes("dark")) || /(^|\s)dark(\s|$)/.test(classes)) {
      return "dark";
    }

    if (values.some((value) => value.includes("light")) || /(^|\s)light(\s|$)/.test(classes)) {
      return "light";
    }

    return "";
  }

  function backgroundLooksDark(element) {
    if (!element) return null;

    const color = getComputedStyle(element).backgroundColor;
    const match = /rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)(?:\D+(\d+(?:\.\d+)?))?\s*\)/i.exec(color || "");
    if (!match) return null;

    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (alpha < 0.2) return null;

    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    return luminance < 128;
  }

  function detectChatGptDarkTheme() {
    const hint = explicitThemeHint();
    if (hint) return hint === "dark";

    const candidates = [
      document.querySelector("main"),
      document.body,
      document.documentElement
    ];

    for (const element of candidates) {
      const result = backgroundLooksDark(element);
      if (result !== null) return result;
    }

    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function syncTheme() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const dark = detectChatGptDarkTheme();
    root.classList.toggle("cgpt-theme-dark", dark);
    root.classList.toggle("cgpt-theme-light", !dark);
  }

  function toggleSidebar() {
    const root = ensureUi();
    state.collapsed = !state.collapsed;
    root.classList.toggle("is-collapsed", state.collapsed);
  }

  function ensureUi() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("aside");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="cgpt-nav-toggle" type="button" title="收起/展开提问导航 (Alt+Q)" aria-label="收起或展开提问导航">›</button>
      <div class="cgpt-nav-panel">
        <div class="cgpt-nav-header">
          <div class="cgpt-nav-title">
            <strong>我的提问</strong>
            <span class="cgpt-nav-count">0</span>
          </div>
          <div class="cgpt-nav-header-actions">
            <span class="cgpt-nav-status">等待索引</span>
            <button class="cgpt-nav-refresh" type="button" title="重新读取完整提问目录" aria-label="重新读取完整提问目录">↻</button>
          </div>
        </div>
        <input
          class="cgpt-nav-search"
          type="search"
          placeholder="筛选本聊天中的提问…"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="cgpt-nav-list"></div>
        <div class="cgpt-nav-footer">Alt+↑/↓ 上下提问 · Alt+Home/End 首问/末问 · Alt+Q 收起/展开</div>
      </div>
    `;

    document.body.appendChild(root);

    syncTheme();

    root.querySelector(".cgpt-nav-toggle").addEventListener("click", toggleSidebar);

    root.querySelector(".cgpt-nav-search").addEventListener("input", renderList);

    root.querySelector(".cgpt-nav-refresh").addEventListener("click", () => {
      refreshIndex(false);
      prefetchConversation(true);
    });

    updateStatusUi();
    return root;
  }

  function renderList() {
    const root = ensureUi();
    const list = root.querySelector(".cgpt-nav-list");
    const search = root.querySelector(".cgpt-nav-search");
    const count = root.querySelector(".cgpt-nav-count");
    const query = normalizeText(search.value).toLowerCase();

    list.textContent = "";
    let shown = 0;

    state.prompts.forEach((prompt, index) => {
      if (query && !prompt.text.toLowerCase().includes(query)) return;
      shown += 1;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgpt-nav-item";
      button.dataset.index = String(index);
      button.title = prompt.text;

      const number = document.createElement("span");
      number.className = "cgpt-nav-number";
      number.textContent = String(index + 1);

      const text = document.createElement("span");
      text.className = "cgpt-nav-text";
      text.textContent = prompt.text;

      button.append(number, text);
      button.addEventListener("click", () => jumpTo(index));
      list.appendChild(button);
    });

    count.textContent =
      query && shown !== state.prompts.length
        ? `${shown}/${state.prompts.length}`
        : String(state.prompts.length);

    if (state.prompts.length === 0 || shown === 0) {
      const empty = document.createElement("div");
      empty.className = "cgpt-nav-empty";
      empty.textContent =
        state.prompts.length === 0 ? "正在识别对话…" : "没有匹配的提问";
      list.appendChild(empty);
    }

    updateStatusUi();
    updateActiveItem();
  }

  function scrollMetrics(scroller) {
    if (!scroller) return null;
    const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const reverse = getComputedStyle(scroller).flexDirection === "column-reverse";
    return {
      range,
      top: scroller.scrollTop,
      oldest: reverse ? -range : 0,
      newest: reverse ? 0 : range,
      min: reverse ? -range : 0,
      max: reverse ? 0 : range
    };
  }

  // Never use DOM order, a hidden container, or scrollHeight alone.
  function primaryScrollContainer() {
    const indexById = currentPromptIndexByMessageId();
    const candidates = [...document.querySelectorAll(CHAT_SCROLL_SELECTOR)]
      .filter(elementHasLayout)
      .map((scroller) => {
        const matches = new Set();
        let visibleMatches = 0;
        const units = scroller.querySelectorAll(NEW_USER_UNIT_SELECTOR);
        const turns = scroller.querySelectorAll(NEW_TURN_SELECTOR);
        for (const unit of units) {
          for (const id of messageIdsFromElement(unit)) {
            const index = indexById.get(id);
            if (index === undefined || matches.has(index)) continue;
            matches.add(index);
            if (positionableAnchor(unit)) visibleMatches += 1;
          }
        }
        for (const turn of turns) {
          const index = indexById.get(turn.getAttribute("data-turn-key") || "");
          if (index === undefined || matches.has(index)) continue;
          matches.add(index);
          if (positionableAnchor(turn)) visibleMatches += 1;
        }
        return {
          scroller,
          matched: matches.size,
          visibleMatches,
          hasUserMarkers: units.length > 0 || turns.length > 0 ||
            !!scroller.querySelector("[data-message-author-role='user']"),
          inMain: !!scroller.closest("main"),
          hasRange: scrollMetrics(scroller).range > 2
        };
      });
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].scroller;
    const maxMatched = Math.max(...candidates.map((item) => item.matched));
    let eligible = maxMatched > 0
      ? candidates.filter((item) => item.matched === maxMatched)
      : candidates.filter((item) => item.inMain && item.hasUserMarkers);
    if (eligible.length === 1) return eligible[0].scroller;
    if (maxMatched > 0) {
      const maxVisible = Math.max(...eligible.map((item) => item.visibleMatches));
      if (maxVisible > 0) {
        eligible = eligible.filter((item) => item.visibleMatches === maxVisible);
        if (eligible.length === 1) return eligible[0].scroller;
      }
    }
    // For ID-free markup require a uniquely active, message-bearing main.
    if (maxMatched === 0) {
      const scrollable = eligible.filter((item) => item.hasRange);
      if (scrollable.length === 1) return scrollable[0].scroller;
    }
    return null;
  }

  function scrollElementIntoView(element, scroller) {
    if (!scroller || !element || !scroller.contains(element) ||
        !elementHasLayout(element)) return false;
    element.scrollIntoView({
      behavior: "auto", block: "start", inline: "nearest"
    });
    return true;
  }

  function anchorIsInViewport(element, scroller) {
    if (!element || !scroller || !elementHasLayout(element)) return false;
    const rect = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return rect.bottom >= view.top - 2 && rect.top <= view.bottom + 2;
  }

  function clearNavigationTimer() {
    if (state.navigationTimer !== null) {
      clearTimeout(state.navigationTimer);
      state.navigationTimer = null;
    }
  }

  function cancelNavigation(reason = "") {
    const wasActive = state.navigationActive;
    clearNavigationTimer();
    state.navigationSeq += 1;
    state.navigationActive = false;
    state.navigationTargetIndex = -1;
    state.navigationOriginIndex = -1;
    state.navigationRecoveryAttempts = 0;
    if (wasActive) {
      state.selectedIndex = -1;
      state.navigationFeedback = reason ? "已取消" : "";
      state.navigationReason = reason;
    }
  }

  function finishNavigation(seq, success = false, reason = "") {
    if (seq !== state.navigationSeq) return;
    clearNavigationTimer();
    if (success) {
      state.selectedIndex = state.navigationTargetIndex;
      const locatedScroller = primaryScrollContainer();
      state.navigationLocatedTop = locatedScroller ? locatedScroller.scrollTop : null;
      state.navigationFeedback = "已定位";
      state.navigationReason = "";
    } else {
      state.selectedIndex = -1;
      state.navigationLocatedTop = null;
      state.navigationFeedback = "无法定位";
      state.navigationReason = reason || "目标尚未成为可定位的活动消息节点";
    }
    state.navigationActive = false;
    state.navigationTargetIndex = -1;
    state.navigationOriginIndex = -1;
    updateStatusUi();
    updateActiveItem();
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      scheduleRefresh(80);
    }
  }

  function scheduleNavigationStep(seq, callback, delay) {
    if (seq !== state.navigationSeq) return;
    clearNavigationTimer();

    state.navigationTimer = window.setTimeout(() => {
      state.navigationTimer = null;
      if (seq === state.navigationSeq) callback();
    }, delay);
  }

  function scrollOneViewport(scroller, direction, scale = 0.86) {
    const metrics = scrollMetrics(scroller);
    if (!metrics || !direction || metrics.range <= 2) return false;
    const step = Math.max(240, scroller.clientHeight * scale);
    const next = Math.max(
      metrics.min, Math.min(metrics.max, metrics.top + direction * step)
    );
    if (Math.abs(next - metrics.top) < 2) return false;
    scroller.scrollTop = next;
    return true;
  }

  function mountedRangeSignature(entries, scroller) {
    const indices = entries.map((entry) => entry.index);
    const min = indices.length ? Math.min(...indices) : -1;
    const max = indices.length ? Math.max(...indices) : -1;
    return min + ":" + max + ":" + Math.round(scroller ? scroller.scrollTop : 0);
  }

  function navigationDirection(targetIndex, entries, scroller) {
    if (entries.length) {
      const minIndex = entries[0].index;
      const maxIndex = entries[entries.length - 1].index;
      if (targetIndex < minIndex) return -1;
      if (targetIndex > maxIndex) return 1;
      let nearest = entries[0];
      for (const entry of entries) {
        if (Math.abs(entry.index - targetIndex) <
            Math.abs(nearest.index - targetIndex)) nearest = entry;
      }
      if (targetIndex < nearest.index) return -1;
      if (targetIndex > nearest.index) return 1;
    }
    if (state.navigationOriginIndex >= 0) {
      return targetIndex < state.navigationOriginIndex ? -1 : 1;
    }
    const metrics = scrollMetrics(scroller);
    if (!metrics) return 0;
    if (Math.abs(metrics.top - metrics.newest) <= 3) return -1;
    if (Math.abs(metrics.top - metrics.oldest) <= 3) return 1;
    return 0;
  }

  function settleNavigation(index, seq, round = 0) {
    if (seq !== state.navigationSeq) return;
    if (location.pathname !== state.routeKey) {
      finishNavigation(seq, false, "会话已切换");
      return;
    }
    const scroller = primaryScrollContainer();
    const target = resolvePromptElement(state.prompts[index], scroller);
    if (!target || !scrollElementIntoView(target, scroller)) {
      state.navigationRecoveryAttempts += 1;
      if (state.navigationRecoveryAttempts > 3) {
        finishNavigation(seq, false, "目标锚点在定位期间失效");
      } else {
        runNavigation(index, seq);
      }
      return;
    }
    if (round >= 2) {
      if (anchorIsInViewport(target, scroller)) {
        finishNavigation(seq, true);
      } else {
        finishNavigation(seq, false, "目标没有进入活动聊天视口");
      }
      return;
    }
    scheduleNavigationStep(seq, () => settleNavigation(index, seq, round + 1), 120);
  }

  function runNavigation(index, seq, progress = {}) {
    if (seq !== state.navigationSeq) return;
    if (location.pathname !== state.routeKey) {
      finishNavigation(seq, false, "会话已切换");
      return;
    }
    const prompt = state.prompts[index];
    if (!prompt) {
      finishNavigation(seq, false, "提问目录已变更");
      return;
    }
    const scroller = primaryScrollContainer();
    if (!scroller) {
      const waits = (progress.waits || 0) + 1;
      if (waits > 12) {
        finishNavigation(seq, false, "活动聊天滚动区域未就绪或存在歧义");
      } else {
        scheduleNavigationStep(
          seq, () => runNavigation(index, seq, { ...progress, waits }), 160
        );
      }
      return;
    }
    const target = resolvePromptElement(prompt, scroller);
    if (target && scrollElementIntoView(target, scroller)) {
      scheduleNavigationStep(seq, () => settleNavigation(index, seq), 100);
      return;
    }
    const attempt = progress.attempt || 0;
    if (attempt >= 96) {
      finishNavigation(seq, false, "已达到本次有限导航步数");
      return;
    }
    const entries = currentMountedPromptEntries(scroller);
    const signature = mountedRangeSignature(entries, scroller);
    const stale = signature === progress.previousSignature
      ? (progress.stale || 0) + 1 : 0;
    if (stale >= 5) {
      finishNavigation(seq, false, "滚动或锚点没有进展");
      return;
    }
    const metrics = scrollMetrics(scroller);
    const startBoundary = progress.startBoundary ||
      (Math.abs(metrics.top - metrics.newest) <= 3 ? "newest" :
        Math.abs(metrics.top - metrics.oldest) <= 3 ? "oldest" : "middle");
    const inferred = navigationDirection(index, entries, scroller);
    const direction = entries.length
      ? inferred : (progress.direction || inferred || -1);
    const scale = attempt < 6 ? 0.82 : attempt < 20 ? 1.0 : 1.22;
    const moved = scrollOneViewport(scroller, direction, scale);
    updateStatusUi();
    updateActiveItem();
    if (!moved) {
      // Reverse once only for zero-anchor searches started in the middle.
      if (!entries.length && startBoundary === "middle" && !progress.reversed &&
          scrollOneViewport(scroller, -direction, scale)) {
        scheduleNavigationStep(seq, () => runNavigation(index, seq, {
          attempt: attempt + 1,
          direction: -direction,
          reversed: true,
          startBoundary,
          previousSignature: "",
          stale: 0
        }), 170);
      } else {
        finishNavigation(seq, false, "已达到滚动边界，目标尚不可定位");
      }
      return;
    }
    scheduleNavigationStep(seq, () => runNavigation(index, seq, {
      attempt: attempt + 1,
      direction,
      reversed: !!progress.reversed,
      startBoundary,
      previousSignature: signature,
      stale
    }), 170);
  }

  function jumpTo(index) {
    const prompt = state.prompts[index];
    if (!prompt) return;
    const origin = currentPromptIndex();
    cancelNavigation();
    state.selectedIndex = index;
    state.navigationTargetIndex = index;
    state.navigationOriginIndex = origin;
    state.navigationActive = true;
    state.navigationFeedback = "寻找中";
    state.navigationReason = "";
    state.navigationRecoveryAttempts = 0;
    state.navigationLocatedTop = null;
    const seq = state.navigationSeq;
    updateStatusUi();
    updateActiveItem();
    runNavigation(index, seq);
  }

  function currentPromptIndex() {
    if (!state.prompts.length) return -1;
    const scroller = primaryScrollContainer();
    if (!scroller) return -1;
    const view = scroller.getBoundingClientRect();
    const readingY = view.top + Math.min(view.height * 0.28, 320);
    const mounted = currentMountedPromptEntries(scroller)
      .map((entry) => {
        const rect = entry.element.getBoundingClientRect();
        return {
          index: entry.index,
          top: rect.top,
          bottom: rect.bottom,
          distance: Math.abs(rect.top - readingY)
        };
      })
      .filter((item) => item.bottom >= view.top - 2 && item.top <= view.bottom + 2)
      .sort((a, b) => a.top - b.top);
    if (mounted.length) {
      const above = mounted.filter((item) => item.top <= readingY);
      if (above.length) return above[above.length - 1].index;
      mounted.sort((a, b) => a.distance - b.distance);
      return mounted[0].index;
    }
    return -1; // Unknown position is not prompt #0.
  }

  function updateActiveItem() {
    const root = document.getElementById(ROOT_ID);
    if (!root || !state.prompts.length) return;
    const visibleIndex = currentPromptIndex();
    const active = !state.navigationActive &&
      state.navigationFeedback === "已定位" && state.selectedIndex >= 0
      ? state.selectedIndex : visibleIndex;
    root.querySelectorAll(".cgpt-nav-item").forEach((button) => {
      button.classList.toggle(
        "is-active", Number(button.dataset.index) === active
      );
    });
  }

  function jumpRelative(direction) {
    if (!state.prompts.length) return;
    let current = state.navigationActive && state.selectedIndex >= 0
      ? state.selectedIndex : currentPromptIndex();
    if (current < 0) {
      const metrics = scrollMetrics(primaryScrollContainer());
      if (metrics && Math.abs(metrics.top - metrics.newest) <= 3) {
        current = state.prompts.length - 1;
      } else if (metrics && Math.abs(metrics.top - metrics.oldest) <= 3) {
        current = 0;
      } else {
        current = direction < 0 ? state.prompts.length : -1;
      }
    }
    const target = direction < 0
      ? Math.max(0, current - 1)
      : Math.min(state.prompts.length - 1, current + 1);
    jumpTo(target);
  }

  function handleKeyboard(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
      return;
    }
    // Only Alt+Q (physical Q key) toggles the sidebar; ignore Shift and key repeats.
    if (event.code === "KeyQ") {
      if (event.shiftKey || event.repeat) return;
      toggleSidebar();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    let handled = true;
    switch (event.key) {
      case "ArrowUp":
        jumpRelative(-1);
        break;
      case "ArrowDown":
        jumpRelative(1);
        break;
      case "Home":
        if (state.prompts.length) jumpTo(0);
        break;
      case "End":
        if (state.prompts.length) jumpTo(state.prompts.length - 1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function resetForRoute() {
    cancelNavigation();
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.pendingRefresh = false;
    state.routeKey = location.pathname;
    state.apiRequestSeq += 1;
    state.apiKnowledge = null;
    state.labelCache.clear();
    state.prompts = [];
    state.fingerprint = "";
    state.selectedIndex = -1;
    state.navigationFeedback = "";
    state.navigationReason = "";
    state.navigationRecoveryAttempts = 0;
    state.navigationLocatedTop = null;
    state.apiStatus = "读取中…";
    state.apiStatusTitle = "正在切换聊天并重建目录。";

    const root = ensureUi();
    const search = root.querySelector(".cgpt-nav-search");
    if (search) search.value = "";

    renderList();
    window.setTimeout(() => {
      refreshIndex();
      prefetchConversation(false);
    }, 80);
  }

  function checkRoute() {
    if (location.pathname !== state.routeKey) resetForRoute();
  }

  function start() {
    ensureUi();
    refreshIndex();
    prefetchConversation(false);

    document.addEventListener("keydown", handleKeyboard, true);

    const cancelOnManualInput = (event) => {
      if (!state.navigationActive) return;

      const root = document.getElementById(ROOT_ID);
      const target = event.target;
      if (root && target && (target === root || root.contains(target))) return;

      cancelNavigation("用户手动操作了聊天区域");
      updateStatusUi();
      updateActiveItem();
    };

    document.addEventListener("wheel", cancelOnManualInput, {
      passive: true,
      capture: true
    });
    document.addEventListener("touchstart", cancelOnManualInput, {
      passive: true,
      capture: true
    });
    document.addEventListener("pointerdown", cancelOnManualInput, true);

    document.addEventListener(
      "scroll",
      () => {
        if (state.scrollTicking) return;
        state.scrollTicking = true;
        requestAnimationFrame(() => {
          if (!state.navigationActive && state.navigationFeedback === "已定位") {
            const activeScroller = primaryScrollContainer();
            if (!activeScroller || state.navigationLocatedTop === null ||
                Math.abs(activeScroller.scrollTop - state.navigationLocatedTop) > 2) {
              state.navigationFeedback = "";
              state.selectedIndex = -1;
              state.navigationLocatedTop = null;
              updateStatusUi();
            }
          }
          updateActiveItem();
          state.scrollTicking = false;
        });
      },
      { passive: true, capture: true }
    );

    const observer = new MutationObserver((mutations) => {
      checkRoute();

      const root = document.getElementById(ROOT_ID);
      const onlyNavigatorMutations = mutations.every((mutation) => {
        const target = mutation.target;
        return root && (target === root || root.contains(target));
      });

      if (!onlyNavigatorMutations) scheduleRefresh(140);
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true
    });

    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-color-mode"]
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-color-mode"]
    });

    window.setInterval(checkRoute, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

