/* =====================================================================
   RSVP Portal · app.js
   Plain JavaScript, no build step. Sections:
     1. Setup and helpers
     2. Router
     3. Auth screens (login, sign up, magic link, Google, reset)
     4. Invitee screens (my invites, one invite)
     5. Organizer screens (my events, event form, event detail)
     6. Email (calls the send-invite Edge Function)
     7. Boot
   ===================================================================== */

/* ---------- 1. Setup and helpers ---------- */

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.RSVP_CONFIG;
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = document.getElementById("app");
let currentUser = null;           // the signed-in Supabase user, or null
const NEXT_KEY = "rsvp.next";     // where to go after login (e.g. an invite link)

// Escape anything that came from a user before putting it in HTML.
function h(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast show" + (isError ? " err" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = "toast"), 3500);
}

function myEmail() {
  return (currentUser?.email || "").toLowerCase();
}

function isOpen(event) {
  const closesAt = new Date(event.rsvp_deadline || event.starts_at);
  return event.status === "active" && closesAt > new Date();
}

function siteUrl() {
  return window.location.origin + window.location.pathname;
}

/* ---------- 2. Router ---------- */

// Each route is a pattern and a function that draws the page.
const routes = [
  { path: /^#\/login$/,                 view: viewLogin,        public: true },
  { path: /^#\/reset$/,                 view: viewResetPassword },
  { path: /^#\/invites$/,               view: viewMyInvites },
  { path: /^#\/invite\/([\w-]+)$/,      view: viewInvite },
  { path: /^#\/events$/,                view: viewMyEvents },
  { path: /^#\/events\/new$/,           view: viewEventForm },
  { path: /^#\/events\/([\w-]+)\/edit$/, view: viewEventForm },
  { path: /^#\/events\/([\w-]+)$/,      view: viewEventDetail },
];

function go(hash) {
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

async function render() {
  let hash = window.location.hash || "#/invites";
  if (recovering && hash !== "#/reset") hash = "#/reset";

  // Supabase puts login tokens or errors in the hash after a redirect.
  if (hash.startsWith("#access_token") || hash.startsWith("#error")) {
    const params = new URLSearchParams(hash.slice(1));
    if (params.get("error_description")) toast(params.get("error_description"), true);
    hash = "#/invites";
    history.replaceState(null, "", siteUrl() + hash);
  }

  const match = routes.map(r => ({ r, m: hash.match(r.path) })).find(x => x.m);
  if (!match) return go("#/invites");

  // Not signed in? Remember where they wanted to go, then show login.
  if (!match.r.public && !currentUser) {
    localStorage.setItem(NEXT_KEY, hash);
    return go("#/login");
  }
  if (match.r.public && currentUser) return go("#/invites");

  document.getElementById("topbar").hidden = !currentUser;
  document.querySelectorAll("[data-nav]").forEach(a => {
    a.classList.toggle("active", hash.startsWith("#/" + a.dataset.nav.replace(/s$/, "")));
  });

  app.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    await match.r.view(...match.m.slice(1));
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="banner err">Something went wrong: ${h(err.message)}</div>`;
  }
}

function goAfterLogin() {
  const next = localStorage.getItem(NEXT_KEY) || "#/invites";
  localStorage.removeItem(NEXT_KEY);
  go(next);
}

/* ---------- 3. Auth screens ---------- */

function viewLogin() {
  let mode = "signin"; // signin | signup | magic | forgot

  const draw = () => {
    const titles = {
      signin: "Welcome back", signup: "Create your account",
      magic: "Email me a sign-in link", forgot: "Reset your password"
    };
    app.innerHTML = `
      <div class="narrow">
        <div class="card">
          <h1>${titles[mode]}</h1>
          <p class="muted small">Sign in to see your invites and manage your events.</p>

          <div class="tabs" role="tablist">
            <button data-mode="signin" class="${mode === "signin" ? "active" : ""}">Sign in</button>
            <button data-mode="signup" class="${mode === "signup" ? "active" : ""}">Sign up</button>
            <button data-mode="magic"  class="${mode === "magic"  ? "active" : ""}">Magic link</button>
          </div>

          <form id="auth-form">
            ${mode === "signup" ? `<label for="name">Full name</label>
              <input id="name" autocomplete="name" required>` : ""}
            <label for="email">Email</label>
            <input id="email" type="email" autocomplete="email" required>
            ${mode === "signin" || mode === "signup" ? `<label for="password">Password</label>
              <input id="password" type="password" minlength="6"
                autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required>` : ""}
            <button class="btn primary block" type="submit">${{
              signin: "Sign in", signup: "Create account", magic: "Send magic link", forgot: "Send reset link"
            }[mode]}</button>
          </form>

          ${mode === "signin" ? `<p class="small" style="margin-top:12px">
            <button class="link" data-mode="forgot">Forgot your password?</button></p>` : ""}
          ${mode === "forgot" ? `<p class="small" style="margin-top:12px">
            <button class="link" data-mode="signin">Back to sign in</button></p>` : ""}

          <div class="divider">or</div>
          <button class="btn block" id="google">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            Continue with Google
          </button>
        </div>
      </div>`;

    app.querySelectorAll("[data-mode]").forEach(b =>
      b.addEventListener("click", e => { e.preventDefault(); mode = b.dataset.mode; draw(); }));

    app.querySelector("#google").addEventListener("click", async () => {
      const { error } = await db.auth.signInWithOAuth({
        provider: "google", options: { redirectTo: siteUrl() }
      });
      if (error) toast(error.message, true);
    });

    app.querySelector("#auth-form").addEventListener("submit", async e => {
      e.preventDefault();
      const btn = e.submitter; btn.disabled = true;
      const email = app.querySelector("#email").value.trim().toLowerCase();
      const password = app.querySelector("#password")?.value;
      let result;

      if (mode === "signin") {
        result = await db.auth.signInWithPassword({ email, password });
      } else if (mode === "signup") {
        const full_name = app.querySelector("#name").value.trim();
        result = await db.auth.signUp({
          email, password, options: { data: { full_name }, emailRedirectTo: siteUrl() }
        });
        if (!result.error && !result.data.session) {
          toast("Check your email to confirm your account.");
        }
      } else if (mode === "magic") {
        result = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: siteUrl() } });
        if (!result.error) toast("Magic link sent. Check your inbox.");
      } else if (mode === "forgot") {
        result = await db.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
        if (!result.error) toast("Reset link sent. Check your inbox.");
      }

      btn.disabled = false;
      if (result.error) toast(result.error.message, true);
      // A successful sign in fires onAuthStateChange, which moves us on.
    });
  };

  draw();
}

function viewResetPassword() {
  app.innerHTML = `
    <div class="narrow"><div class="card">
      <h1>Choose a new password</h1>
      <form id="reset-form">
        <label for="pw">New password</label>
        <input id="pw" type="password" minlength="6" autocomplete="new-password" required>
        <button class="btn primary block">Save password</button>
      </form>
    </div></div>`;
  app.querySelector("#reset-form").addEventListener("submit", async e => {
    e.preventDefault();
    const { error } = await db.auth.updateUser({ password: app.querySelector("#pw").value });
    if (error) return toast(error.message, true);
    toast("Password updated.");
    recovering = false;
    go("#/invites");
  });
}

/* ---------- 4. Invitee screens ---------- */

async function viewMyInvites() {
  // RLS only returns invitations addressed to my email, so no filter is
  // strictly needed. We add one anyway so organizers don't see their
  // own events' guest lists mixed into "My invites".
  const { data, error } = await db
    .from("invitations")
    .select("id, status, event:events(id, title, starts_at, location, status, rsvp_deadline, organizer:profiles(full_name, email))")
    .eq("invitee_email", myEmail());
  if (error) throw error;

  const invites = (data || []).sort((a, b) => new Date(a.event.starts_at) - new Date(b.event.starts_at));
  const upcoming = invites.filter(i => new Date(i.event.starts_at) >= new Date());
  const past = invites.filter(i => new Date(i.event.starts_at) < new Date());

  const card = i => `
    <a class="card row" href="#/invite/${i.id}" style="color:inherit;text-decoration:none">
      <div>
        <h2 style="margin:0">${h(i.event.title)}</h2>
        <div class="meta">
          <span>${fmtDate(i.event.starts_at)}</span>
          ${i.event.location ? `<span>${h(i.event.location)}</span>` : ""}
          <span>From ${h(i.event.organizer?.full_name || i.event.organizer?.email)}</span>
        </div>
      </div>
      ${i.event.status === "cancelled"
        ? `<span class="pill cancelled">Cancelled</span>`
        : `<span class="pill ${i.status}">${i.status}</span>`}
    </a>`;

  app.innerHTML = `
    <div class="page-head"><div><h1>My invites</h1>
      <p class="muted">Signed in as ${h(myEmail())}</p></div></div>
    ${upcoming.length ? `<div class="list">${upcoming.map(card).join("")}</div>`
      : `<div class="card empty">No upcoming invites yet.</div>`}
    ${past.length ? `<h2 style="margin-top:32px">Past</h2><div class="list">${past.map(card).join("")}</div>` : ""}`;
}

async function viewInvite(inviteId) {
  const { data: inv, error } = await db
    .from("invitations")
    .select("*, event:events(*, organizer:profiles(full_name, email))")
    .eq("id", inviteId)
    .maybeSingle();
  if (error) throw error;
  if (!inv) {
    app.innerHTML = `<div class="card empty">
      <h2>Invite not found</h2>
      <p>This invite may belong to a different email address. You are signed in as <b>${h(myEmail())}</b>.</p>
      <a class="btn" href="#/invites">Go to my invites</a></div>`;
    return;
  }

  const ev = inv.event;
  const open = isOpen(ev);

  app.innerHTML = `
    <p><a href="#/invites">← My invites</a></p>
    ${ev.status === "cancelled" ? `<div class="banner err">This event has been cancelled.</div>` : ""}
    ${ev.status === "active" && !open ? `<div class="banner warn">RSVPs for this event are closed.</div>` : ""}
    <div class="card">
      <div class="row">
        <h1>${h(ev.title)}</h1>
        <span class="pill ${inv.status}">${inv.status}</span>
      </div>
      <div class="meta">
        <span>${fmtDate(ev.starts_at)}</span>
        ${ev.location ? `<span>${h(ev.location)}</span>` : ""}
        <span>Hosted by ${h(ev.organizer?.full_name || ev.organizer?.email)}</span>
      </div>
      ${ev.description ? `<p style="white-space:pre-wrap">${h(ev.description)}</p>` : ""}
      ${ev.rsvp_deadline ? `<p class="small muted">Please reply by ${fmtDate(ev.rsvp_deadline)}</p>` : ""}
    </div>

    ${open ? `
    <div class="card">
      <h2>${inv.status === "pending" ? "Will you be there?" : "Change your response"}</h2>
      <label for="note">Note to the organizer (optional)</label>
      <textarea id="note" maxlength="500" placeholder="e.g. Bringing a salad">${h(inv.note)}</textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ok" data-answer="accepted">Accept</button>
        <button class="btn danger" data-answer="declined">Decline</button>
      </div>
      ${inv.responded_at ? `<p class="small muted">Last answered ${fmtDate(inv.responded_at)}</p>` : ""}
    </div>` : ""}`;

  app.querySelectorAll("[data-answer]").forEach(btn => btn.addEventListener("click", async () => {
    btn.disabled = true;
    const { error } = await db.rpc("respond_to_invite", {
      p_invite_id: inviteId,
      p_status: btn.dataset.answer,
      p_note: app.querySelector("#note").value
    });
    if (error) { btn.disabled = false; return toast(error.message, true); }
    toast(btn.dataset.answer === "accepted" ? "See you there!" : "Thanks for letting them know.");
    render();
  }));
}

/* ---------- 5. Organizer screens ---------- */

async function viewMyEvents() {
  const { data, error } = await db
    .from("events")
    .select("id, title, starts_at, location, status, invitations(status)")
    .eq("organizer_id", currentUser.id)
    .order("starts_at", { ascending: true });
  if (error) throw error;

  const count = (ev, s) => ev.invitations.filter(i => i.status === s).length;

  app.innerHTML = `
    <div class="page-head">
      <div><h1>My events</h1><p class="muted">Events you are organizing</p></div>
      <a class="btn primary" href="#/events/new">+ New event</a>
    </div>
    ${data.length ? `<div class="list">${data.map(ev => `
      <a class="card row" href="#/events/${ev.id}" style="color:inherit;text-decoration:none">
        <div>
          <h2 style="margin:0">${h(ev.title)}</h2>
          <div class="meta"><span>${fmtDate(ev.starts_at)}</span>
            ${ev.location ? `<span>${h(ev.location)}</span>` : ""}</div>
        </div>
        ${ev.status === "cancelled" ? `<span class="pill cancelled">Cancelled</span>` : `
        <div class="meta">
          <span class="pill accepted">${count(ev, "accepted")} yes</span>
          <span class="pill declined">${count(ev, "declined")} no</span>
          <span class="pill pending">${count(ev, "pending")} waiting</span>
        </div>`}
      </a>`).join("")}</div>`
      : `<div class="card empty"><p>You haven't created any events yet.</p>
         <a class="btn primary" href="#/events/new">Create your first event</a></div>`}`;
}

async function viewEventForm(eventId) {
  let ev = { title: "", description: "", location: "", starts_at: "", rsvp_deadline: "" };
  let guestCount = 0;
  if (eventId) {
    const { data, error } = await db.from("events").select("*, invitations(id)").eq("id", eventId).single();
    if (error) throw error;
    ev = data;
    guestCount = data.invitations.length;
  }

  app.innerHTML = `
    <p><a href="${eventId ? `#/events/${eventId}` : "#/events"}">← Back</a></p>
    <div class="card">
      <h1>${eventId ? "Edit event" : "New event"}</h1>
      <form id="event-form">
        <label for="title">Title</label>
        <input id="title" maxlength="120" required value="${h(ev.title)}">
        <label for="description">Description</label>
        <textarea id="description">${h(ev.description)}</textarea>
        <label for="location">Location</label>
        <input id="location" value="${h(ev.location)}">
        <div class="grid-2">
          <div><label for="starts_at">Starts</label>
            <input id="starts_at" type="datetime-local" required value="${toLocalInput(ev.starts_at)}"></div>
          <div><label for="rsvp_deadline">RSVP by (optional)</label>
            <input id="rsvp_deadline" type="datetime-local" value="${toLocalInput(ev.rsvp_deadline)}"></div>
        </div>
        ${eventId && guestCount ? `<label class="check"><input type="checkbox" id="notify" checked>
          Email the ${guestCount} invitee${guestCount > 1 ? "s" : ""} about this change</label>` : ""}
        <button class="btn primary block">${eventId ? "Save changes" : "Create event"}</button>
      </form>
    </div>`;

  app.querySelector("#event-form").addEventListener("submit", async e => {
    e.preventDefault();
    const val = id => app.querySelector("#" + id).value.trim();
    const record = {
      title: val("title"),
      description: val("description") || null,
      location: val("location") || null,
      starts_at: new Date(val("starts_at")).toISOString(),
      rsvp_deadline: val("rsvp_deadline") ? new Date(val("rsvp_deadline")).toISOString() : null
    };
    if (record.rsvp_deadline && record.rsvp_deadline > record.starts_at) {
      return toast("The RSVP deadline should be before the event starts.", true);
    }

    const query = eventId
      ? db.from("events").update(record).eq("id", eventId).select().single()
      : db.from("events").insert(record).select().single();
    const { data, error } = await query;
    if (error) return toast(error.message, true);

    if (eventId && app.querySelector("#notify")?.checked) {
      await sendEmails(eventId, "update");
    }
    toast(eventId ? "Event updated." : "Event created. Now invite some people.");
    go(`#/events/${data.id}`);
  });
}

async function viewEventDetail(eventId) {
  const [{ data: ev, error }, { data: people }] = await Promise.all([
    db.from("events").select("*, invitations(*)").eq("id", eventId).eq("organizer_id", currentUser.id).maybeSingle(),
    db.from("profiles").select("id, email, full_name").order("full_name", { nullsFirst: false })
  ]);
  if (error) throw error;
  if (!ev) {
    app.innerHTML = `<div class="card empty">Event not found, or you are not its organizer.</div>`;
    return;
  }

  const guests = ev.invitations.sort((a, b) => a.invitee_email.localeCompare(b.invitee_email));
  const invited = new Set(guests.map(g => g.invitee_email));
  const available = (people || []).filter(p => p.email !== myEmail() && !invited.has(p.email));
  const n = s => guests.filter(g => g.status === s).length;
  const cancelled = ev.status === "cancelled";

  app.innerHTML = `
    <p><a href="#/events">← My events</a></p>
    ${cancelled ? `<div class="banner err">You cancelled this event. Invitees can no longer respond.</div>` : ""}
    <div class="page-head">
      <div>
        <h1>${h(ev.title)}</h1>
        <div class="meta"><span>${fmtDate(ev.starts_at)}</span>
          ${ev.location ? `<span>${h(ev.location)}</span>` : ""}
          ${ev.rsvp_deadline ? `<span>RSVP by ${fmtDate(ev.rsvp_deadline)}</span>` : ""}</div>
      </div>
      <div class="btn-row">
        ${!cancelled ? `<a class="btn" href="#/events/${ev.id}/edit">Edit</a>
          <button class="btn danger" id="cancel-event">Cancel event</button>` : ""}
        <button class="btn danger" id="delete-event">Delete</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><b>${guests.length}</b><span>Invited</span></div>
      <div class="stat"><b>${n("accepted")}</b><span>Accepted</span></div>
      <div class="stat"><b>${n("declined")}</b><span>Declined</span></div>
      <div class="stat"><b>${n("pending")}</b><span>No reply yet</span></div>
    </div>

    <div class="card">
      <div class="row"><h2>Guest list</h2>
        ${!cancelled && n("pending") ? `<button class="btn sm" id="remind">Resend to everyone who hasn't replied</button>` : ""}
      </div>
      ${guests.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Guest</th><th>Status</th><th>Note</th><th>Last emailed</th><th></th></tr></thead>
        <tbody>${guests.map(g => `
          <tr>
            <td><b>${h(g.invitee_name || "")}</b><div class="small muted">${h(g.invitee_email)}</div></td>
            <td><span class="pill ${g.status}">${g.status}</span></td>
            <td class="small">${h(g.note || "")}</td>
            <td class="small muted">${g.last_sent_at ? fmtDate(g.last_sent_at) : "Not sent"}</td>
            <td><div class="btn-row">
              ${!cancelled ? `<button class="btn sm" data-resend="${g.id}">Resend</button>` : ""}
              <button class="btn sm danger" data-remove="${g.id}">Remove</button>
            </div></td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">Nobody invited yet. Add people below.</p>`}
    </div>

    ${!cancelled ? `
    <div class="card">
      <h2>Invite people</h2>
      <form id="invite-form">
        <label>Choose from existing users</label>
        ${available.length ? `<input id="people-filter" placeholder="Search by name or email">
          <div class="people" id="people">${available.map(p => `
            <label class="check" data-search="${h((p.full_name || "") + " " + p.email).toLowerCase()}">
              <input type="checkbox" name="person" value="${h(p.email)}" data-name="${h(p.full_name || "")}">
              ${h(p.full_name || p.email)} <span class="muted small">${p.full_name ? h(p.email) : ""}</span>
            </label>`).join("")}</div>`
          : `<p class="muted small">Everyone with an account is already invited.</p>`}

        <label>Or add someone new</label>
        <div id="new-people"></div>
        <button type="button" class="btn sm" id="add-row">+ Add another person</button>

        <button class="btn primary block">Send invites</button>
      </form>
    </div>` : ""}`;

  // --- wire up the buttons ---

  const newRow = () => {
    const div = document.createElement("div");
    div.className = "grid-2";
    div.style.marginBottom = "8px";
    div.innerHTML = `<input placeholder="Name" class="new-name"><input type="email" placeholder="email@example.com" class="new-email">`;
    app.querySelector("#new-people").appendChild(div);
  };
  if (!cancelled) {
    newRow();
    app.querySelector("#add-row").addEventListener("click", newRow);
  }

  app.querySelector("#people-filter")?.addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    app.querySelectorAll("#people [data-search]").forEach(el => {
      el.style.display = el.dataset.search.includes(q) ? "" : "none";
    });
  });

  app.querySelector("#invite-form")?.addEventListener("submit", async e => {
    e.preventDefault();
    const rows = [];
    app.querySelectorAll("input[name=person]:checked").forEach(cb =>
      rows.push({ event_id: eventId, invitee_email: cb.value, invitee_name: cb.dataset.name || null }));
    app.querySelectorAll("#new-people .grid-2").forEach(div => {
      const email = div.querySelector(".new-email").value.trim().toLowerCase();
      const name = div.querySelector(".new-name").value.trim();
      if (email) rows.push({ event_id: eventId, invitee_email: email, invitee_name: name || null });
    });
    if (!rows.length) return toast("Pick at least one person or add a new email.", true);

    const btn = e.submitter; btn.disabled = true; btn.textContent = "Sending…";
    // ignoreDuplicates: inviting the same email twice does nothing.
    const { data: created, error } = await db
      .from("invitations")
      .upsert(rows, { onConflict: "event_id,invitee_email", ignoreDuplicates: true })
      .select("id");
    if (error) { btn.disabled = false; btn.textContent = "Send invites"; return toast(error.message, true); }

    if (created.length) await sendEmails(eventId, "invite", created.map(r => r.id));
    else toast("Those people were already invited.");
    render();
  });

  app.querySelector("#remind")?.addEventListener("click", async e => {
    e.target.disabled = true;
    const ids = guests.filter(g => g.status === "pending").map(g => g.id);
    await sendEmails(eventId, "reminder", ids);
    render();
  });

  app.querySelectorAll("[data-resend]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    await sendEmails(eventId, "invite", [b.dataset.resend]);
    render();
  }));

  app.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Remove this person from the guest list?")) return;
    const { error } = await db.from("invitations").delete().eq("id", b.dataset.remove);
    if (error) return toast(error.message, true);
    render();
  }));

  app.querySelector("#cancel-event")?.addEventListener("click", async () => {
    if (!confirm("Cancel this event? Everyone invited will get an email.")) return;
    const { error } = await db.from("events").update({ status: "cancelled" }).eq("id", eventId);
    if (error) return toast(error.message, true);
    if (guests.length) await sendEmails(eventId, "cancel");
    render();
  });

  app.querySelector("#delete-event").addEventListener("click", async () => {
    if (!confirm("Delete this event and its guest list for good? No emails are sent.")) return;
    const { error } = await db.from("events").delete().eq("id", eventId);
    if (error) return toast(error.message, true);
    toast("Event deleted.");
    go("#/events");
  });
}

/* ---------- 6. Email ---------- */

// kind: "invite" | "reminder" | "update" | "cancel"
// invitationIds: optional, defaults to everyone on the guest list.
async function sendEmails(eventId, kind, invitationIds) {
  const { data, error } = await db.functions.invoke("send-invite", {
    body: { event_id: eventId, kind, invitation_ids: invitationIds, site_url: siteUrl() }
  });
  if (error) {
    toast("Saved, but emails failed: " + error.message, true);
    return;
  }
  const failed = data.results.filter(r => !r.ok).length;
  if (failed) toast(`${data.sent} email(s) sent, ${failed} failed. Check the function logs.`, true);
  else toast(`${data.sent} email(s) sent.`);
}

/* ---------- 7. Boot ---------- */

document.getElementById("signout").addEventListener("click", async () => {
  await db.auth.signOut();
});

let recovering = false; // true after clicking a "reset password" email link

db.auth.onAuthStateChange((event, session) => {
  const wasSignedIn = !!currentUser;
  currentUser = session?.user ?? null;

  if (event === "PASSWORD_RECOVERY") { recovering = true; return go("#/reset"); }
  if (event === "SIGNED_OUT") return go("#/login");
  if (event === "SIGNED_IN" && !wasSignedIn) {
    // Only jump to the saved page if we were on the login screen or just
    // came back from a magic link / Google redirect. A plain page reload
    // should stay where it is.
    const h = window.location.hash;
    if (!h || h === "#/login" || h.startsWith("#access_token")) return goAfterLogin();
    render();
  }
});

window.addEventListener("hashchange", render);

(async function start() {
  const { data } = await db.auth.getSession(); // also finishes magic link / Google redirects
  currentUser = data.session?.user ?? null;
  render();
})();
