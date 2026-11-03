# RSVP Portal · Build Guide

A step by step path for building the RSVP Portal in class. Each lesson adds one layer, in the same order as the module (CRUD, databases, APIs, login and logout, backend APIs). By the end students have a working app where an organizer creates an event, invites people by email, and watches the RSVPs come in.

**Stack**

| Layer | Tool | Why |
|---|---|---|
| Frontend | Plain HTML, CSS and JavaScript | Nothing hidden. Every line is readable, no build step |
| Database and API | Supabase (Postgres) | Tables become an API automatically |
| Login | Supabase Auth | Email and password, magic link, Google |
| Email | Supabase Edge Function + Resend | Our first piece of backend code |
| Hosting | Any static host (Netlify, Vercel, GitHub Pages) | It is just files |

**Files**

```
rsvp-portal/
├── index.html                  the single page that loads everything
├── css/styles.css              all the styling
├── js/config.js                your Supabase URL and anon key
├── js/app.js                   the whole app, in 7 labelled sections
└── supabase/
    ├── schema.sql              tables, security rules, helper functions
    └── functions/send-invite/  the email sender (backend)
```

---

## Before class (instructor setup, about 30 minutes)

1. Create a free project at supabase.com. Pick the Canada (Central) region if offered.
2. Create a free account at resend.com and get an API key.
3. Install a code editor (VS Code) and the **Live Server** extension, or have Python available for `python3 -m http.server`.
4. Install the Supabase CLI for Lesson 5: `brew install supabase/tap/supabase`.
5. Optional but worth it: set up Google login ahead of time (Lesson 4, step 3). The Google Cloud console takes a while the first time.

**Resend gotcha.** Until you verify a domain in Resend, you can only send email **to your own Resend account address**, from `onboarding@resend.dev`. For a class demo that is fine if you invite yourself. For students to receive real invites, verify a domain (add the DNS records Resend gives you) and set `FROM_EMAIL` to an address on it.

---

## Lesson 1 · Stories and the data model (CRUD thinking)

**Goal.** Turn the user stories into the "things" the app stores and what we do with them.

Walk through the stories (see the User Stories doc) and pull out the nouns.

| Noun | Becomes a table | Key fields |
|---|---|---|
| Person with an account | `profiles` | email, full name |
| Event | `events` | title, when, where, RSVP deadline, status, organizer |
| Invite | `invitations` | which event, invitee email, status, note |

Then map each story to Create, Read, Update, Delete.

| Story | C | R | U | D |
|---|---|---|---|---|
| Organizer creates an event | events | | | |
| Organizer invites people | invitations | profiles | | |
| Invitee sees invites | | invitations, events | | |
| Invitee accepts or declines | | | invitations | |
| Organizer manages events | | events, invitations | events | events, invitations |

**Discussion point.** Why does an invitation store an *email* and not a user id? Because we want to invite people who don't have an account yet. When they sign up with that email, the invite is already waiting. Ask students what would break if we used user ids instead.

---

## Lesson 2 · Build the database

**Goal.** Create the tables and understand what each line does.

1. In Supabase open **SQL Editor → New query**.
2. Paste in `supabase/schema.sql` and press **Run**. It should say "Success. No rows returned".
3. Open **Table Editor** and look at the three tables.

Walk through the file section by section.

- **Tables.** Point out `primary key`, `references` (foreign keys), `default`, `check` constraints and the `unique (event_id, invitee_email)` rule that stops double invites.
- **Trigger.** `handle_new_user` copies every new sign up into `profiles`. Ask why we need our own profiles table when Supabase already has `auth.users` (answer: `auth.users` is private and we can't query it from the browser).
- **Leave Row Level Security for Lesson 4.** Just mention that it's on.

**Try it.** Insert a test event by hand in the Table Editor. Notice it fails because `organizer_id` is empty (the Table Editor isn't signed in as anyone) and it must point to a real profile. That's the `not null` and foreign key rules doing their job.

---

## Lesson 3 · Talk to the API from the browser

**Goal.** See that Supabase turns every table into an API, and call it from JavaScript.

1. In Supabase go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `js/config.js`.
2. Open the folder in VS Code and click **Go Live** (or run `python3 -m http.server 5500` in the folder and open http://localhost:5500).
3. Open `js/app.js` and read **section 1**. The line `window.supabase.createClient(...)` is the whole connection.

Show the four CRUD calls side by side. They live in sections 4 and 5.

```js
// Create
await db.from("events").insert({ title, starts_at }).select().single();
// Read
await db.from("events").select("*, invitations(status)").eq("organizer_id", me);
// Update
await db.from("events").update({ status: "cancelled" }).eq("id", eventId);
// Delete
await db.from("invitations").delete().eq("id", inviteId);
```

**Show the network tab.** Open browser DevTools → Network, click around, and show that each of these is a plain HTTPS request to `/rest/v1/events`. That's the API.

**Explain the anon key.** It is public on purpose. What keeps data safe is the next lesson.

---

## Lesson 4 · Login, logout and who can see what

**Goal.** Add three ways to sign in, then lock the data down so people only see what's theirs.

### 4a. Email and password

1. Supabase → **Authentication → Providers → Email** is on by default.
2. Supabase → **Authentication → URL Configuration**. Set **Site URL** to where the app runs (e.g. `http://localhost:5500/`). Add the same URL, plus your hosted URL later, to **Redirect URLs**.
3. In the app, use the **Sign up** tab, confirm the email, then sign in.

Code to read in `viewLogin()` (section 3): `signUp`, `signInWithPassword`, `resetPasswordForEmail`.

### 4b. Magic link

Same screen, **Magic link** tab. One call, `signInWithOtp`. It creates the account if it doesn't exist, which is why it's perfect for brand new invitees.

### 4c. Google

1. In Google Cloud Console create an **OAuth client ID** (type Web application).
2. Under **Authorized redirect URIs** paste the callback URL shown in Supabase → **Authentication → Providers → Google**.
3. Paste the Google client ID and secret into Supabase and enable the provider.
4. In the app, **Continue with Google** calls `signInWithOAuth({ provider: "google" })`.

### 4d. Logout

`db.auth.signOut()`. Look at `onAuthStateChange` in section 7. One listener reacts to sign in, sign out and password recovery for the whole app.

### 4e. Row Level Security (the important bit)

Go back to section 4 of `schema.sql`. RLS is the database asking "who is asking?" on every single row.

| Who | Can see | Can change |
|---|---|---|
| Organizer | their events and the full guest list | their events, their guest list |
| Invitee | events they're invited to, **only their own** invitation row | their answer, through `respond_to_invite` only |
| Anyone else | nothing | nothing |

**Live demo that lands well.** Sign in as two different people in two browsers (one normal, one private window). Organizer invites person B. Person B sees the event but not who else is invited. Person C sees nothing at all.

**Why the helper functions?** The events rule looks at invitations and the invitations rule looks at events. Without the `security definer` helpers, Postgres loops forever and throws "infinite recursion detected in policy". Students will hit this in their own apps, so it's worth showing.

**Why an RPC for answering?** If invitees could `update` the invitations table directly, they could change their email or someone else's status. `respond_to_invite` only lets them set accepted or declined plus a note, and refuses once the event is cancelled or past the deadline.

---

## Lesson 5 · Backend API: sending the emails

**Goal.** Write and deploy a small piece of server code. This is where secrets live, because nothing in the browser is secret.

1. In a terminal, inside the `rsvp-portal` folder:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set FROM_EMAIL="RSVP Portal <rsvp@yourdomain.com>"
supabase secrets set SITE_URL=http://localhost:5500/
supabase functions deploy send-invite
```

2. Read `supabase/functions/send-invite/index.ts` together. Four steps, each commented.
   1. Make a Supabase client **as the signed-in user** (passes their token through).
   2. Load the event and check the caller is the organizer.
   3. Load the guest list (RLS means only the organizer can).
   4. Send each email through Resend, pausing 0.6 seconds between sends.
3. In the app, create an event, invite yourself, press **Send invites**, and check your inbox.
4. Click the link in the email. If you're signed out, the app remembers the invite, asks you to sign in, then takes you straight to it.

**Debugging.** Supabase → **Edge Functions → send-invite → Logs** shows every call and error.

**Discussion point.** Why not call Resend straight from `app.js`? Because the API key would be visible to anyone who opens DevTools. Rule: if it costs money or sends something, it goes in the backend.

---

## Lesson 6 · Ship it

1. Change `SITE_URL` to the real hosted URL and redeploy the function.
2. Add the hosted URL to Supabase **Redirect URLs** (and to Google's authorized origins if you use Google).
3. Drag the folder (without the `supabase` folder) onto Netlify Drop, or push it to GitHub Pages.

---

## Testing checklist (run this before class)

- [ ] Sign up with email and password, confirm, sign in, sign out
- [ ] Magic link sign in from a new email address
- [ ] Google sign in
- [ ] Forgot password email arrives and the reset screen works
- [ ] Create an event, edit it, see "Email invitees about this change"
- [ ] Invite an existing user from the list and a brand new email
- [ ] Brand new invitee signs up with that email and sees the invite
- [ ] Accept, then change to decline with a note. Organizer sees both changes
- [ ] Second invitee cannot see the first invitee's response
- [ ] "Resend to everyone who hasn't replied" only emails pending people
- [ ] Cancel the event. Invitees get an email and can no longer respond
- [ ] Past the RSVP deadline the buttons disappear

## Stretch goals for students

1. **Plus ones.** Add a `guest_count` column and a number input on the invite page.
2. **Add to calendar.** Generate an `.ics` file for accepted invites.
3. **Capacity and waitlist.** Add `capacity` to events and refuse accepts once it's full.
4. **Scheduled reminders.** Use Supabase cron to email pending invitees two days before the deadline.
5. **Organizer chat.** A comments table so guests can ask questions.
