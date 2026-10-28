'use strict';

// Chat panel: the followed session's conversation, buttons for the decisions
// Claude is waiting on, and a message box that adapts to where the session
// runs (straight in for buddy chats and channel-connected terminals, pre-fill
// for VS Code, read-only for Claude Desktop).

(function () {
  const chatEl = $('chat');
  const logEl = $('chat-log');
  const actionsEl = $('chat-actions');
  const form = $('chat-form');
  const input = $('chat-input');
  const sendBtn = $('chat-send');
  const hint = $('chat-hint');
  const newForm = $('chat-newform');

  let open = false;
  let sessionId = null;
  const rendered = new Map(); // item id -> { el, sig }
  let pending = []; // optimistic messages: { text, el, at }
  let note = null; // { text, error, until }
  const answered = new Set(); // decision ids clicked, waiting to disappear
  let lastActionsSig = '';

  // ---------- open / close ----------

  function setOpen(v, { fresh = false } = {}) {
    open = v;
    chatEl.hidden = !v;
    if (api) api.setChatOpen(v);
    if (v) {
      document.body.classList.add('chat-open');
      position();
      if (fresh) showNewForm();
      else setTimeout(() => input.focus(), 50);
    } else {
      document.body.classList.remove('chat-open');
      newForm.hidden = true;
    }
    if (snap) render(snap);
  }

  function position() {
    const row = $('row').getBoundingClientRect();
    chatEl.style.bottom = `${window.innerHeight - row.top + 4}px`;
    // Never taller than the room above the buddy, so the header stays visible.
    chatEl.style.maxHeight = `${Math.max(200, Math.min(380, row.top - 8))}px`;
  }

  $('chat-toggle').addEventListener('mousedown', (e) => e.stopPropagation());
  $('chat-toggle').addEventListener('mouseup', (e) => e.stopPropagation());
  $('chat-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  $('chat-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) setOpen(false);
  });
  if (api && api.onChatShow) api.onChatShow(({ fresh }) => setOpen(true, { fresh }));

  // ---------- rendering ----------

  function md(text) {
    let html = esc(text);
    html = html.replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, (_m, code) => `<pre>${code.replace(/\n$/, '')}</pre>`);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1');
    html = html.replace(/^#{1,6} (.*)$/gm, '<b>$1</b>');
    return html.replace(/\n/g, '<br>').replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, code) => `<pre>${code.replace(/<br>/g, '\n')}</pre>`);
  }

  function itemHtml(it, f) {
    switch (it.kind) {
      case 'user':
        return `<div class="msg user">${md(it.text)}</div>`;
      case 'assistant':
        return `<div class="msg assistant">${md(it.text)}</div>`;
      case 'tools': {
        const more = it.count > it.items.length ? ` <span class="more">+${it.count - it.items.length} more</span>` : '';
        return `<div class="msg tools">${it.items.map((x) => esc(x)).join(' · ')}${more}</div>`;
      }
      case 'question':
        return `<div class="msg card">${it.questions.map((q) => `<div class="q">${esc(q.question)}</div><div class="chips">${q.options.map((o) => `<span class="chip-opt">${esc(o)}</span>`).join('')}</div>`).join('')}</div>`;
      case 'plan':
        return `<div class="msg card plan"><div class="q">Plan</div><div class="plan-body">${md(it.text)}</div></div>`;
      case 'ask': {
        const canSend = f && f.input && (f.input.mode === 'direct' || f.input.mode === 'vscode');
        const buttons = it.options.map((o) => `<button type="button" class="opt" data-say="${esc(o)}" ${canSend ? '' : 'disabled'}>${esc(o)}</button>`).join('');
        return `<div class="msg card"><div class="q">${esc(it.text)}</div><div class="chips">${buttons}</div></div>`;
      }
      case 'error':
        return `<div class="msg error">${esc(it.text)}</div>`;
      default:
        return `<div class="msg system">${esc(it.text)}</div>`;
    }
  }

  function renderLog(items, f) {
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const keep = new Set(items.map((it) => it.id));
    for (const [id, r] of rendered) {
      if (!keep.has(id)) {
        r.el.remove();
        rendered.delete(id);
      }
    }
    let prev = null;
    for (const it of items) {
      const sig = JSON.stringify(it) + (it.kind === 'ask' && f && f.input ? f.input.mode : '');
      let r = rendered.get(it.id);
      if (!r) {
        const wrap = document.createElement('div');
        wrap.innerHTML = itemHtml(it, f);
        r = { el: wrap.firstElementChild, sig };
        rendered.set(it.id, r);
        if (prev) prev.after(r.el);
        else logEl.prepend(r.el);
      } else if (r.sig !== sig) {
        const wrap = document.createElement('div');
        wrap.innerHTML = itemHtml(it, f);
        r.el.replaceWith(wrap.firstElementChild);
        r.el = wrap.firstElementChild;
        r.sig = sig;
      }
      prev = r.el;
    }
    // Optimistic messages disappear once the transcript has them.
    const userTexts = items.filter((it) => it.kind === 'user').slice(-5).map((it) => it.text.trim());
    pending = pending.filter((p) => {
      const done = userTexts.includes(p.text.trim()) || Date.now() - p.at > 60000;
      if (done) p.el.remove();
      else logEl.appendChild(p.el);
      return !done;
    });
    if (!items.length && !pending.length) {
      logEl.dataset.empty = f ? (f.chat && f.chat.running ? 'Starting Claude…' : 'Nothing said yet in this session.') : 'No session to chat with yet. Start one with ＋.';
    } else {
      delete logEl.dataset.empty;
    }
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  function actionsHtml(actions) {
    return actions
      .map((a) => {
        const done = answered.has(a.id);
        const who = a.helper ? '<span class="who">Helper</span> ' : '';
        let body = '';
        let buttons = '';
        if (a.kind === 'question') {
          body = a.questions
            .map(
              (q, qi) =>
                `<div class="q">${esc(q.question)}</div><div class="chips">${q.options
                  .map((o) => `<button type="button" class="opt" data-q="${qi}" data-label="${esc(o.label)}" title="${esc(o.description)}">${esc(o.label)}</button>`)
                  .join('')}</div>`,
            )
            .join('');
          const single = a.questions.length === 1 && !a.questions[0].multiSelect;
          buttons = single ? '' : `<button type="button" class="primary" data-act="answers">Send answers</button>`;
        } else if (a.kind === 'plan') {
          body = `<div class="plan-body">${md(a.detail)}</div>`;
          buttons = `<button type="button" class="primary" data-act="allow">Approve plan</button><button type="button" data-act="deny" title="Uses what you typed below as feedback">Keep planning</button>`;
        } else {
          body = `${a.detail ? `<div class="detail">${esc(a.detail)}</div>` : ''}${a.preview ? `<pre>${esc(a.preview)}</pre>` : ''}`;
          buttons = `<button type="button" class="primary" data-act="allow">Allow</button>${a.canAlways ? '<button type="button" data-act="always" title="Allow and don’t ask again for this">Always allow</button>' : ''}<button type="button" class="danger" data-act="deny">Deny</button>`;
        }
        return `<div class="action ${done ? 'done' : ''}" data-id="${esc(a.id)}" data-kind="${a.kind}"><div class="a-title">${who}${esc(a.title)}</div>${body}<div class="a-buttons">${done ? '<span class="sent">Sent ✓</span>' : buttons}</div></div>`;
      })
      .join('');
  }

  function renderActions(actions) {
    for (const id of [...answered]) if (!actions.some((a) => a.id === id)) answered.delete(id);
    const sig = JSON.stringify(actions) + [...answered].join();
    if (sig === lastActionsSig) return;
    lastActionsSig = sig;
    actionsEl.innerHTML = actionsHtml(actions);
    actionsEl.hidden = !actions.length;
  }

  function renderInput(f) {
    const inputInfo = (f && f.input) || { mode: 'none', hint: 'No session to talk to yet. Start one with ＋.' };
    const busy = f && f.chat && f.chat.busy;
    input.disabled = inputInfo.mode === 'none';
    sendBtn.disabled = inputInfo.mode === 'none';
    sendBtn.textContent = inputInfo.mode === 'vscode' ? 'To VS Code ↗' : 'Send';
    input.placeholder =
      inputInfo.mode === 'none' ? 'Typing isn’t available for this session' : inputInfo.mode === 'vscode' ? 'Message for VS Code…' : busy ? 'Claude is working… (you can queue a message)' : 'Message Claude…';
    let text = inputInfo.mode === 'vscode' || inputInfo.mode === 'none' ? inputInfo.hint || '' : '';
    let error = false;
    if (f && f.chat && f.chat.error) {
      text = f.chat.error;
      error = true;
    }
    if (note && Date.now() < note.until) {
      text = note.text;
      error = note.error;
    }
    hint.textContent = text;
    hint.classList.toggle('error', error);
    hint.hidden = !text;
  }

  function renderHeader(s) {
    const f = s.focus;
    $('chat-src').className = `src-dot s-${(f && f.source) || ''}`;
    $('chat-title').textContent = f ? f.title || f.project : 'Chat';
    const where = { vscode: 'VS Code', desktop: 'Claude Desktop', terminal: 'Terminal', buddy: 'Buddy chat', sdk: 'Agent SDK' }[f && f.source] || '';
    const state = f && f.chat && f.chat.busy ? 'working…' : f ? STATUS_WORDS[f.status] || f.status : '';
    $('chat-sub').textContent = [where, state].filter(Boolean).join(' · ');
    $('chat-stop').hidden = !(f && f.chat && f.chat.running);
  }

  function render(s) {
    const f = s.focus;
    const actions = (f && f.actions) || [];
    const badge = $('chat-badge');
    badge.hidden = !actions.length;
    badge.textContent = actions.length;
    if (!open) return;
    if (!f || f.id !== sessionId) {
      sessionId = f ? f.id : null;
      for (const r of rendered.values()) r.el.remove();
      rendered.clear();
      // Keep the first message of a just-started chat across the switch.
      for (const p of pending) if (!p.carry) p.el.remove();
      pending = pending.filter((p) => p.carry).map((p) => ({ ...p, carry: false }));
      lastActionsSig = '';
    }
    position();
    renderHeader(s);
    renderLog(s.chatItems || [], f);
    renderActions(actions);
    renderInput(f);
  }

  // ---------- sending ----------

  function flash(text, error = false) {
    note = { text, error, until: Date.now() + 5000 };
    if (snap) renderInput(snap.focus);
  }

  async function send(text) {
    const f = snap && snap.focus;
    text = text.trim();
    if (!f || !text || !api) return;
    const r = await api.sendChat(f.id, text);
    if (!r.ok) return flash(r.error || 'Couldn’t send that.', true);
    if (r.mode === 'prefilled') return flash('Ready in VS Code: press Enter there to send.');
    const el = document.createElement('div');
    el.className = 'msg user pending';
    el.innerHTML = md(text);
    logEl.appendChild(el);
    pending.push({ text, el, at: Date.now() });
    logEl.scrollTop = logEl.scrollHeight;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    autosize();
    send(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(96, input.scrollHeight)}px`;
  }
  input.addEventListener('input', autosize);

  // Buttons Claude suggested at the end of a turn (Desktop's next-step box).
  logEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-say]');
    if (b && !b.disabled) send(b.dataset.say);
  });

  // ---------- decisions ----------

  const picks = new Map(); // decision id -> { [questionIndex]: Set(labels) }

  actionsEl.addEventListener('click', async (e) => {
    const card = e.target.closest('.action');
    if (!card || !api) return;
    const id = card.dataset.id;
    const a = ((snap && snap.focus && snap.focus.actions) || []).find((x) => x.id === id);
    if (!a || answered.has(id)) return;

    const opt = e.target.closest('.opt');
    if (opt && a.kind === 'question') {
      const qi = Number(opt.dataset.q);
      const q = a.questions[qi];
      const sel = picks.get(id) || {};
      const set = sel[qi] || new Set();
      if (q.multiSelect) {
        if (set.has(opt.dataset.label)) set.delete(opt.dataset.label);
        else set.add(opt.dataset.label);
      } else {
        set.clear();
        set.add(opt.dataset.label);
      }
      sel[qi] = set;
      picks.set(id, sel);
      for (const b of card.querySelectorAll(`.opt[data-q="${qi}"]`)) b.classList.toggle('picked', set.has(b.dataset.label));
      if (a.questions.length === 1 && !q.multiSelect) submitAnswers(a);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'answers') return submitAnswers(a);
    const behavior = act.dataset.act === 'deny' ? 'deny' : 'allow';
    const message = behavior === 'deny' && input.value.trim() ? input.value.trim() : undefined;
    if (message) input.value = '';
    await decide(a, { behavior, always: act.dataset.act === 'always', message });
  });

  async function submitAnswers(a) {
    const sel = picks.get(a.id) || {};
    const answers = {};
    a.questions.forEach((q, i) => {
      if (sel[i] && sel[i].size) answers[q.question] = [...sel[i]].join(', ');
    });
    if (Object.keys(answers).length < a.questions.length) return flash('Pick an answer for each question.', true);
    await decide(a, { behavior: 'allow', answers });
  }

  async function decide(a, answer) {
    answered.add(a.id);
    lastActionsSig = '';
    if (snap) renderActions(snap.focus.actions || []);
    const ok = await api.answer(a.id, answer);
    if (!ok) {
      answered.delete(a.id);
      flash('That prompt was already answered somewhere else.', true);
    }
  }

  // Quick Allow / Deny right in the speech bubble.
  window.bubbleDecide = async (id, behavior) => {
    const a = ((snap && snap.focus && snap.focus.actions) || []).find((x) => x.id === id);
    if (!a) return;
    if (a.kind !== 'permission') return setOpen(true);
    await decide(a, { behavior });
  };

  $('chat-stop').addEventListener('click', () => {
    const f = snap && snap.focus;
    if (f && api) api.stopChat(f.id);
  });

  // ---------- new buddy chat ----------

  async function showNewForm() {
    newForm.hidden = false;
    $('new-hint').textContent = '';
    if (api) {
      const d = await api.chatDefaults();
      $('new-cwd').value = d.cwd || '';
      if (!d.claude) {
        $('new-hint').textContent = 'Claude Code wasn’t found. Set its location in Settings → Connect.';
        $('new-hint').classList.add('error');
      }
    }
    $('new-text').focus();
  }
  $('chat-new').addEventListener('click', showNewForm);
  $('new-cancel').addEventListener('click', () => (newForm.hidden = true));
  $('new-pick').addEventListener('click', async () => {
    const p = api && (await api.pickFolder($('new-cwd').value));
    if (p) $('new-cwd').value = p;
  });
  $('new-start').addEventListener('click', async () => {
    const text = $('new-text').value.trim();
    if (!api) return;
    $('new-start').disabled = true;
    const r = await api.newChat($('new-cwd').value, text);
    $('new-start').disabled = false;
    if (!r.ok) {
      $('new-hint').textContent = r.error;
      $('new-hint').classList.add('error');
      return;
    }
    $('new-text').value = '';
    newForm.hidden = true;
    sessionId = null; // the panel switches to the new chat on the next update
    const el = document.createElement('div');
    el.className = 'msg user pending';
    el.innerHTML = md(text);
    pending.push({ text, el, at: Date.now(), carry: true });
  });
  $('new-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('new-start').click();
  });

  window.chatUI = { render, isOpen: () => open, setOpen };
  if (snap && snap.demoChat) setOpen(true);
  else if (snap) render(snap);
})();
