-- =====================================================================
-- RSVP Portal · database schema
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to re-run: it drops and recreates the app's own objects.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Clean slate (only the RSVP objects, never Supabase's own tables)
-- ---------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.invitations cascade;
drop table if exists public.events cascade;
drop table if exists public.profiles cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_event_organizer(uuid) cascade;
drop function if exists public.is_invited_to_event(uuid) cascade;
drop function if exists public.my_email() cascade;
drop function if exists public.respond_to_invite(uuid, text, text) cascade;
drop function if exists public.touch_updated_at() cascade;

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- One row per person who has an account. Filled automatically by a
-- trigger when someone signs up (email/password, magic link or Google).
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

create table public.events (
  id             uuid primary key default gen_random_uuid(),
  organizer_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 120),
  description    text,
  location       text,
  starts_at      timestamptz not null,
  rsvp_deadline  timestamptz,
  status         text not null default 'active' check (status in ('active', 'cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- An invitation is keyed by EMAIL, not by user id. That is what lets an
-- organizer invite someone who has no account yet: the moment that
-- person signs up with the same email, the invite is waiting for them.
create table public.invitations (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  invitee_email  text not null check (invitee_email = lower(invitee_email)),
  invitee_name   text,
  status         text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  note           text check (char_length(note) <= 500),
  responded_at   timestamptz,
  last_sent_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (event_id, invitee_email)
);

create index invitations_email_idx on public.invitations (invitee_email);
create index events_organizer_idx  on public.events (organizer_id);

-- ---------------------------------------------------------------------
-- 2. TRIGGERS
-- ---------------------------------------------------------------------

-- Create a profile whenever a new auth user appears.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep events.updated_at honest.
create function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. HELPER FUNCTIONS
-- These are SECURITY DEFINER so policies on events can look at
-- invitations (and vice versa) without RLS calling itself forever
-- ("infinite recursion detected in policy" is a classic beginner bug).
-- ---------------------------------------------------------------------

create function public.my_email()
returns text
language sql stable
as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create function public.is_event_organizer(p_event_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event_id and e.organizer_id = auth.uid()
  )
$$;

create function public.is_invited_to_event(p_event_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.invitations i
    where i.event_id = p_event_id and i.invitee_email = public.my_email()
  )
$$;

-- Invitees answer through this function instead of updating the table
-- directly, so they can only ever change status and note, and only
-- while the event is open.
create function public.respond_to_invite(p_invite_id uuid, p_status text, p_note text default null)
returns public.invitations
language plpgsql
security definer set search_path = public
as $$
declare
  v_inv   public.invitations;
  v_event public.events;
begin
  if p_status not in ('accepted', 'declined') then
    raise exception 'Status must be accepted or declined';
  end if;

  select * into v_inv from public.invitations where id = p_invite_id;
  if not found or v_inv.invitee_email <> public.my_email() then
    raise exception 'Invitation not found';
  end if;

  select * into v_event from public.events where id = v_inv.event_id;
  if v_event.status = 'cancelled' then
    raise exception 'This event was cancelled';
  end if;
  if coalesce(v_event.rsvp_deadline, v_event.starts_at) < now() then
    raise exception 'RSVPs for this event are closed';
  end if;

  update public.invitations
     set status = p_status,
         note = nullif(trim(p_note), ''),
         responded_at = now()
   where id = p_invite_id
  returning * into v_inv;

  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- Rule of thumb: turn RLS on for every table, then open exactly the
-- doors each story needs.
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.events      enable row level security;
alter table public.invitations enable row level security;

-- PROFILES -------------------------------------------------------------
-- Any signed-in user can see the people list (story 2: organizer picks
-- from existing users). Fine for a class; a real product might limit
-- this to people in the same organisation.
create policy "profiles: signed-in users can read"
  on public.profiles for select to authenticated
  using (true);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- EVENTS ---------------------------------------------------------------
create policy "events: organizer or invitee can read"
  on public.events for select to authenticated
  using (organizer_id = auth.uid() or public.is_invited_to_event(id));

create policy "events: create as yourself"
  on public.events for insert to authenticated
  with check (organizer_id = auth.uid());

create policy "events: organizer can update"
  on public.events for update to authenticated
  using (organizer_id = auth.uid()) with check (organizer_id = auth.uid());

create policy "events: organizer can delete"
  on public.events for delete to authenticated
  using (organizer_id = auth.uid());

-- INVITATIONS ----------------------------------------------------------
-- Invitees see ONLY their own row, never the rest of the guest list.
create policy "invitations: organizer sees all, invitee sees own"
  on public.invitations for select to authenticated
  using (public.is_event_organizer(event_id) or invitee_email = public.my_email());

create policy "invitations: organizer can add"
  on public.invitations for insert to authenticated
  with check (public.is_event_organizer(event_id));

create policy "invitations: organizer can update"
  on public.invitations for update to authenticated
  using (public.is_event_organizer(event_id))
  with check (public.is_event_organizer(event_id));

create policy "invitations: organizer can remove"
  on public.invitations for delete to authenticated
  using (public.is_event_organizer(event_id));

-- ---------------------------------------------------------------------
-- 5. GRANTS
-- ---------------------------------------------------------------------
revoke execute on function public.respond_to_invite(uuid, text, text) from public, anon;
grant  execute on function public.respond_to_invite(uuid, text, text) to authenticated;

-- Hardening flagged by Supabase's security advisor:
-- pin search_path, and keep helper functions away from signed-out callers.
alter function public.touch_updated_at() set search_path = public;
alter function public.my_email() set search_path = public;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_event_organizer(uuid) from public, anon;
revoke execute on function public.is_invited_to_event(uuid) from public, anon;
grant  execute on function public.is_event_organizer(uuid) to authenticated;
grant  execute on function public.is_invited_to_event(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. BACKFILL: create profiles for anyone who signed up before this ran
-- ---------------------------------------------------------------------
insert into public.profiles (id, email, full_name)
select id, lower(email),
       coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name')
from auth.users
where email is not null
on conflict (id) do nothing;
