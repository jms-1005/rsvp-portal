// =====================================================================
// send-invite · Supabase Edge Function
//
// Called from the browser with:
//   { event_id, kind, invitation_ids?, site_url? }
//   kind = "invite" | "reminder" | "update" | "cancel"
//
// It runs AS THE SIGNED-IN USER (we pass their login token through), so
// Row Level Security still applies. Only the event's organizer can read
// its guest list, which means nobody else can trigger emails for it.
//
// Secrets (set with `supabase secrets set ...`):
//   RESEND_API_KEY   your key from resend.com
//   FROM_EMAIL       optional, defaults to "RSVP Portal <invites@rsvp.lampstand.school>"
//   SITE_URL         where the app is hosted, e.g. https://rsvp.example.com/
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const { event_id, kind = "invite", invitation_ids, site_url } = await req.json();
    if (!event_id) return json({ error: "event_id is required" }, 400);
    if (!["invite", "reminder", "update", "cancel"].includes(kind)) return json({ error: "Unknown kind" }, 400);

    // 1. A Supabase client that acts as the caller.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);

    // 2. Load the event and check the caller organizes it.
    const { data: event, error: evErr } = await supabase
      .from("events")
      .select("*, organizer:profiles(full_name, email)")
      .eq("id", event_id)
      .single();
    if (evErr || !event) return json({ error: "Event not found" }, 404);
    if (event.organizer_id !== user.id) return json({ error: "Only the organizer can send emails" }, 403);

    // 3. Who gets the email?
    let q = supabase.from("invitations").select("*").eq("event_id", event_id);
    if (Array.isArray(invitation_ids) && invitation_ids.length) q = q.in("id", invitation_ids);
    const { data: guests, error: gErr } = await q;
    if (gErr) return json({ error: gErr.message }, 400);

    // 4. Build and send, one at a time with a short pause. Resend's free
    //    plan allows about 2 requests a second, and slow steady sending
    //    keeps you out of spam folders.
    const base = (Deno.env.get("SITE_URL") || site_url || "").replace(/\/?$/, "/");
    const host = event.organizer?.full_name || event.organizer?.email || "Someone";
    const when = new Date(event.starts_at).toLocaleString("en-CA", {
      weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: Deno.env.get("APP_TIMEZONE") || "America/Vancouver",
    });

    const results: { id: string; email: string; ok: boolean; error?: string }[] = [];

    for (const g of guests ?? []) {
      const link = `${base}#/invite/${g.id}`;
      const { subject, intro, cta } = copyFor(kind, event.title, host);

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#14171f">
          <p>Hi ${esc(g.invitee_name || "there")},</p>
          <p>${esc(intro)}</p>
          <div style="border:1px solid #e4e7ec;border-radius:12px;padding:16px;margin:16px 0">
            <h2 style="margin:0 0 6px">${esc(event.title)}</h2>
            <p style="margin:0;color:#667085">${esc(when)}${event.location ? " · " + esc(event.location) : ""}</p>
            ${event.description ? `<p style="white-space:pre-wrap">${esc(event.description)}</p>` : ""}
          </div>
          ${cta ? `<p><a href="${link}" style="background:#3b5bdb;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">${esc(cta)}</a></p>
          <p style="font-size:13px;color:#667085">Sign in with this email address (${esc(g.invitee_email)}) to see your invite. New here? Choose Sign up or Magic link.</p>` : ""}
        </div>`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("FROM_EMAIL") || "RSVP Portal <invites@rsvp.lampstand.school>",
          to: [g.invitee_email],
          subject,
          html,
        }),
      });

      if (res.ok) {
        results.push({ id: g.id, email: g.invitee_email, ok: true });
        await supabase.from("invitations").update({ last_sent_at: new Date().toISOString() }).eq("id", g.id);
      } else {
        results.push({ id: g.id, email: g.invitee_email, ok: false, error: await res.text() });
      }
      await sleep(600);
    }

    return json({ sent: results.filter((r) => r.ok).length, results });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

function copyFor(kind: string, title: string, host: string) {
  switch (kind) {
    case "reminder":
      return { subject: `Reminder: will you be at ${title}?`, intro: `${host} is still waiting to hear from you.`, cta: "Reply now" };
    case "update":
      return { subject: `Updated: ${title}`, intro: `${host} changed some details for this event. Please check you can still make it.`, cta: "View the update" };
    case "cancel":
      return { subject: `Cancelled: ${title}`, intro: `Sorry, ${host} has cancelled this event.`, cta: "" };
    default:
      return { subject: `You're invited: ${title}`, intro: `${host} has invited you to an event.`, cta: "View invite and RSVP" };
  }
}
