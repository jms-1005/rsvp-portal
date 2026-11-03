# RSVP Portal

A small event invite and RSVP app for the Lampstand web app module. Plain HTML and JavaScript on the front, Supabase for the database, login and API, and a Supabase Edge Function that sends invite emails through Resend.

## Quick start

1. Create a Supabase project and run `supabase/schema.sql` in the SQL Editor.
2. Put your Project URL and anon key in `js/config.js`.
3. In Supabase → Authentication → URL Configuration, set the Site URL and add it to Redirect URLs.
4. Serve this folder, e.g. `python3 -m http.server 5500`, and open http://localhost:5500.
5. Deploy the email function (see Lesson 5 in `BUILD-GUIDE.md`).

The full lesson by lesson walkthrough, setup for Google login and Resend, and a pre-class test checklist are in **BUILD-GUIDE.md**.
