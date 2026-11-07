create table if not exists public.rr_rooms (id text primary key, name text not null, url text not null, created_at timestamptz not null default now());
create table if not exists public.rr_recordings (id text primary key, room_id text not null references public.rr_rooms(id), created_at timestamptz not null default now(), state text not null default 'pending' check (state in ('pending','active','deleted','deleting')));
create sequence if not exists public.rr_events_seq;
create table if not exists public.rr_events (seq bigint primary key, room_id text not null references public.rr_rooms(id), id text unique not null, type text not null, author text not null, data jsonb not null, at timestamptz not null default now(), transient boolean not null default false);
create index if not exists rr_events_room_seq on public.rr_events(room_id,seq);
create or replace function public.rr_sequence_event() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.room_id, 179));
  new.seq := nextval('public.rr_events_seq');
  delete from public.rr_events where room_id = new.room_id and transient and at < now() - interval '10 minutes';
  if not new.transient and (
    (new.type <> 'recording_deleted' and (select count(*) from public.rr_events where room_id = new.room_id and not transient) >= 19000) or
    coalesce((select sum(octet_length(data::text) + 6 * octet_length(author) + 512) from public.rr_events where room_id = new.room_id and not transient), 0)
      + octet_length(new.data::text) + 6 * octet_length(new.author) + 512 > (case when new.type = 'recording_deleted' then 4 else 3 end) * 1024 * 1024
  ) then raise exception 'review_room_event_limit'; end if;
  if new.type = 'recording' then
    update public.rr_recordings set state = 'active'
      where room_id = new.room_id and state in ('pending','active')
        and new.data->>'url' = '/recordings/' || new.room_id || '/' || id;
    if not found then raise exception 'review_room_recording_missing'; end if;
  end if;
  return new;
end $$;
drop trigger if exists rr_sequence_event on public.rr_events;
create trigger rr_sequence_event before insert on public.rr_events for each row execute function public.rr_sequence_event();
revoke all on function public.rr_sequence_event() from public, anon, authenticated;
create table if not exists public.rr_invitations (hash text primary key, room_id text not null references public.rr_rooms(id), expires_at timestamptz not null);
create table if not exists public.rr_sessions (hash text primary key, room_id text, invitation_hash text, expires_at timestamptz not null);
alter table public.rr_sessions add column if not exists invitation_hash text;
create table if not exists public.rr_attempts (at timestamptz not null default now());
alter table public.rr_rooms enable row level security;
alter table public.rr_events enable row level security;
alter table public.rr_invitations enable row level security;
alter table public.rr_sessions enable row level security;
alter table public.rr_attempts enable row level security;
alter table public.rr_recordings enable row level security;
revoke all on public.rr_rooms, public.rr_events, public.rr_invitations, public.rr_sessions, public.rr_attempts, public.rr_recordings from anon, authenticated;
grant all on public.rr_rooms, public.rr_events, public.rr_invitations, public.rr_sessions, public.rr_attempts, public.rr_recordings to service_role;
grant usage, select on sequence public.rr_events_seq to service_role;
create or replace function public.rr_claim_login_attempt() returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(701313);
  delete from public.rr_attempts where at < now() - interval '15 minutes';
  if (select count(*) from public.rr_attempts) >= 20 then return false; end if;
  insert into public.rr_attempts default values;
  return true;
end $$;
revoke all on function public.rr_claim_login_attempt() from public, anon, authenticated;
grant execute on function public.rr_claim_login_attempt() to service_role;
create or replace function public.rr_reserve_recording(new_id text, new_room text) returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(701314);
  if (select count(*) from public.rr_recordings) >= 20 or (select count(*) from public.rr_recordings where room_id = new_room) >= 5 then return false; end if;
  insert into public.rr_recordings(id,room_id) values(new_id,new_room);
  return true;
end $$;
revoke all on function public.rr_reserve_recording(text,text) from public, anon, authenticated;
grant execute on function public.rr_reserve_recording(text,text) to service_role;
create or replace function public.rr_delete_recording(target_id text, target_room text, event_id text) returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(target_room, 179));
  update public.rr_recordings set state = 'deleted' where id = target_id and room_id = target_room and state in ('pending','active');
  if not found then return false; end if;
  insert into public.rr_events(room_id,id,type,author,data,transient)
    values(target_room,event_id,'recording_deleted','Owner',jsonb_build_object('url','/recordings/' || target_room || '/' || target_id),false);
  return true;
end $$;
revoke all on function public.rr_delete_recording(text,text,text) from public, anon, authenticated;
grant execute on function public.rr_delete_recording(text,text,text) to service_role;

create table if not exists public.rr_pending_switch (hash text primary key, room_id text not null references public.rr_rooms(id), expires_at timestamptz not null);
alter table public.rr_pending_switch enable row level security;
revoke all on public.rr_pending_switch from anon, authenticated;
grant all on public.rr_pending_switch to service_role;
create or replace function public.rr_switch_prepare(token_hash text, target_room text) returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(701315);
  delete from public.rr_pending_switch where expires_at <= now();
  if (select count(*) from public.rr_pending_switch) >= 1000 then return false; end if;
  insert into public.rr_pending_switch(hash, room_id, expires_at) values (token_hash, target_room, now() + interval '15 minutes');
  return true;
end $$;
revoke all on function public.rr_switch_prepare(text,text) from public, anon, authenticated;
grant execute on function public.rr_switch_prepare(text,text) to service_role;
create or replace function public.rr_switch_reply(token_hash text, reply_text text, event_id text) returns boolean language plpgsql security definer set search_path = public as $$
declare target_room text;
begin
  delete from public.rr_pending_switch where hash = token_hash and expires_at > now() returning room_id into target_room;
  if not found then return false; end if;
  insert into public.rr_events(room_id,id,type,author,data,transient)
    values(target_room,event_id,'switch_reply','Switch agent',jsonb_build_object('text',reply_text),false);
  return true;
end $$;
revoke all on function public.rr_switch_reply(text,text,text) from public, anon, authenticated;
grant execute on function public.rr_switch_reply(text,text,text) to service_role;
