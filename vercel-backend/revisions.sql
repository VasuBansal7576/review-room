create table if not exists public.rr_worker_sessions (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  last_seen_at timestamptz
);
create table if not exists public.rr_revisions (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  room_id text not null references public.rr_rooms(id),
  request_id text not null,
  state text not null default 'queued' check (state in ('queued','preparing','proposed','approved','applying','ready','failed')),
  input jsonb not null,
  proposal jsonb,
  result jsonb,
  error text,
  lease text,
  lease_operation text check (lease_operation in ('prepare','apply')),
  lease_session text,
  lease_expires_at timestamptz,
  completion_hash text,
  prepare_completion_lease text,
  prepare_completion_session text,
  prepare_completion_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id,request_id),
  check (octet_length(input::text) <= 1200 * 1024),
  check (proposal is null or octet_length(proposal::text) <= 2400 * 1024),
  check (result is null or octet_length(result::text) <= 1000 * 1024),
  check (state not in ('proposed','approved','applying','ready') or proposal is not null),
  check (state <> 'ready' or result is not null)
);
create index if not exists rr_revisions_room_created on public.rr_revisions(room_id,created_at desc);
create index if not exists rr_revisions_work on public.rr_revisions(state,created_at);
alter table public.rr_worker_sessions enable row level security;
alter table public.rr_revisions enable row level security;
revoke all on public.rr_worker_sessions, public.rr_revisions from anon, authenticated;
grant all on public.rr_worker_sessions, public.rr_revisions to service_role;

create or replace function public.rr_worker_session_create(token_hash text, expiration timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(701316);
  delete from public.rr_worker_sessions where expires_at <= now();
  if (select count(*) from public.rr_worker_sessions) >= 5 then return false; end if;
  if expiration > now() + interval '25 hours' or expiration <= now() then return false; end if;
  insert into public.rr_worker_sessions(hash,expires_at) values(token_hash,expiration);
  return true;
end $$;

create or replace function public.rr_revision_create(new_id text, target_room text, request_id_value text, request_input jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare revision public.rr_revisions; notes jsonb; recording public.rr_recordings;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_room, 180));
  select * into revision from public.rr_revisions where room_id = target_room and request_id = request_id_value;
  if found then return to_jsonb(revision); end if;
  select * into recording from public.rr_recordings where room_id = target_room and id = request_input->>'recordingId' and state = 'active' for share;
  if not found then return jsonb_build_object('error','recording'); end if;
  if (select count(*) from public.rr_revisions where room_id = target_room) >= 20 then return jsonb_build_object('error','limit'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'text',n.data->>'text','author',n.author,'at',n.at) order by n.seq), '[]'::jsonb)
    into notes from (
      select e.* from public.rr_events e
      where e.room_id = target_room and e.type = 'note' and not e.transient
        and coalesce((select s.data->>'status' from public.rr_events s where s.room_id = target_room and s.type = 'note_status' and s.data->>'noteId' = e.id order by s.seq desc limit 1),'open') <> 'resolved'
      order by e.seq desc limit 100
    ) n;
  insert into public.rr_revisions(id,room_id,request_id,input)
    values(new_id,target_room,request_id_value,request_input || jsonb_build_object('notes',notes)) returning * into revision;
  return to_jsonb(revision);
end $$;

create or replace function public.rr_revision_claim(token_hash text, new_lease text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare revision public.rr_revisions;
begin
  perform 1 from public.rr_worker_sessions where hash = token_hash and expires_at > now() for update;
  if not found then return jsonb_build_object('error','unauthorized'); end if;
  update public.rr_worker_sessions set last_seen_at = now() where hash = token_hash;
  select * into revision from public.rr_revisions
    where state in ('queued','approved') or (state in ('preparing','applying') and lease_expires_at <= now())
    order by created_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.rr_revisions set
    state = case when revision.state in ('queued','preparing') then 'preparing' else 'applying' end,
    lease_operation = case when revision.state in ('queued','preparing') then 'prepare' else 'apply' end,
    lease = new_lease, lease_session = token_hash, lease_expires_at = now() + interval '30 minutes',
    completion_hash = null, error = null, updated_at = now()
    where id = revision.id returning * into revision;
  return to_jsonb(revision);
end $$;

create or replace function public.rr_revision_finish(token_hash text, target_id text, expected_lease text, operation text, completion jsonb, completion_hash text, failure_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare revision public.rr_revisions;
begin
  perform 1 from public.rr_worker_sessions where hash = token_hash and expires_at > now() for update;
  if not found then return jsonb_build_object('error','unauthorized'); end if;
  select * into revision from public.rr_revisions where id = target_id for update;
  if found and operation = 'prepare' and failure_text is null
    and revision.state in ('proposed','approved','applying','ready')
    and revision.prepare_completion_lease = expected_lease
    and revision.prepare_completion_session = token_hash
    and revision.prepare_completion_hash = rr_revision_finish.completion_hash
    and revision.prepare_completion_hash is not null then return to_jsonb(revision); end if;
  if not found or revision.lease is distinct from expected_lease or revision.lease_session is distinct from token_hash or revision.lease_operation is distinct from operation then return null; end if;
  if failure_text is not null then
    if revision.state = 'failed' and revision.error = failure_text then return to_jsonb(revision); end if;
  elsif revision.state = (case operation when 'prepare' then 'proposed' else 'ready' end)
    and revision.completion_hash = rr_revision_finish.completion_hash and revision.completion_hash is not null then
    return to_jsonb(revision);
  end if;
  if revision.lease_expires_at <= now() or revision.state <> (case operation when 'prepare' then 'preparing' else 'applying' end) then return null; end if;
  if failure_text is not null then
    update public.rr_revisions set state = 'failed', error = left(failure_text,1000), updated_at = now() where id = target_id returning * into revision;
  elsif operation = 'prepare' then
    if completion is null or completion->>'baseHash' is distinct from revision.input->>'sourceHash' or completion->>'proposalHash' !~ '^[a-f0-9]{64}$' then return null; end if;
    update public.rr_revisions set state = 'proposed', proposal = completion, completion_hash = rr_revision_finish.completion_hash,
      prepare_completion_lease = expected_lease, prepare_completion_session = token_hash,
      prepare_completion_hash = rr_revision_finish.completion_hash, updated_at = now() where id = target_id returning * into revision;
  elsif operation = 'apply' then
    if completion is null or completion->>'html' is distinct from revision.proposal->>'html' then return null; end if;
    update public.rr_revisions set state = 'ready', result = completion, completion_hash = rr_revision_finish.completion_hash, updated_at = now() where id = target_id returning * into revision;
  else return null;
  end if;
  return to_jsonb(revision);
end $$;

create or replace function public.rr_revision_owner_action(target_id text, target_room text, action text, proposal_hash text, transcript_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare revision public.rr_revisions;
begin
  select * into revision from public.rr_revisions where id = target_id and room_id = target_room for update;
  if not found then return null; end if;
  if action = 'approve' then
    if revision.proposal->>'proposalHash' is distinct from proposal_hash then return null; end if;
    if revision.state in ('approved','applying','ready') then return to_jsonb(revision); end if;
    if revision.state <> 'proposed' then return null; end if;
    update public.rr_revisions set state = 'approved', lease = null, lease_session = null, lease_expires_at = null, completion_hash = null, updated_at = now() where id = target_id returning * into revision;
  elsif action = 'retry' or action = 'correct' then
    if action = 'retry' and (revision.state <> 'failed' or revision.lease_operation not in ('prepare','apply')) then return null; end if;
    if action = 'correct' and (revision.state <> 'proposed' or transcript_text is null or length(btrim(transcript_text)) = 0 or length(transcript_text) > 16000) then return null; end if;
    update public.rr_revisions set state = case when action = 'retry' and revision.lease_operation = 'apply' then 'approved' else 'queued' end,
      input = case when action = 'correct' then jsonb_set(input,'{transcriptOverride}',to_jsonb(transcript_text)) else input end,
      proposal = case when action = 'retry' and revision.lease_operation = 'apply' then proposal else null end,
      result = null, error = null, lease = null, lease_session = null, lease_expires_at = null,
      lease_operation = null, completion_hash = null, prepare_completion_lease = null,
      prepare_completion_session = null, prepare_completion_hash = null, updated_at = now() where id = target_id returning * into revision;
  else return null;
  end if;
  return to_jsonb(revision);
end $$;

revoke all on function public.rr_worker_session_create(text,timestamptz) from public, anon, authenticated;
revoke all on function public.rr_revision_create(text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.rr_revision_claim(text,text) from public, anon, authenticated;
revoke all on function public.rr_revision_finish(text,text,text,text,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.rr_revision_owner_action(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.rr_worker_session_create(text,timestamptz) to service_role;
grant execute on function public.rr_revision_create(text,text,text,jsonb) to service_role;
grant execute on function public.rr_revision_claim(text,text) to service_role;
grant execute on function public.rr_revision_finish(text,text,text,text,jsonb,text,text) to service_role;
grant execute on function public.rr_revision_owner_action(text,text,text,text,text) to service_role;
