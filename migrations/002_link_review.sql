-- Tunemail: history on the shared cache, plus a human review queue.
--
-- Why: a hand-fixed link is the one asset here nobody else has, and the shared
-- cache is read by everyone. Machine checks reject what is malformed and confirm
-- what a platform can vouch for, but Bandcamp, Tidal and YouTube offer no free
-- lookup - and those are exactly where the obscure repertoire lives. Dropping
-- them wastes the correction; accepting them blind poisons the well. So they go
-- to a person.

-- ── 1. History on the shared cache ───────────────────────────────────────────
-- A bad shared value should be a rollback, not archaeology.
alter table track_links add column if not exists direct_urls_prev jsonb;
alter table track_links add column if not exists updated_by uuid references auth.users(id);

-- ── 2. Who may review ────────────────────────────────────────────────────────
-- One flag, so volunteers can be added later without touching any policy.
alter table profiles add column if not exists is_reviewer boolean not null default false;

-- The owner reviews by default. Replace the address if this is ever run by
-- someone else.
update profiles set is_reviewer = true
where id = (select id from auth.users where email = 'dafa4me@gmail.com');

-- ── 3. The queue ─────────────────────────────────────────────────────────────
create table if not exists link_review (
  id            uuid primary key default gen_random_uuid(),
  artist        text not null,
  track_name    text not null,
  platform      text not null,
  url           text not null,
  isrc          text,
  submitted_by  uuid references auth.users(id) on delete set null,
  submitted_at  timestamptz not null default now(),
  state         text not null default 'pending'
                check (state in ('pending', 'approved', 'rejected')),
  reviewed_by   uuid references auth.users(id) on delete set null,
  reviewed_at   timestamptz,
  note          text,
  -- the same suggestion twice is one row, so a queue cannot be flooded by
  -- resubmitting
  unique (artist, track_name, platform, url)
);

create index if not exists link_review_pending_idx
  on link_review (submitted_at) where state = 'pending';

alter table link_review enable row level security;

-- Submit: any signed-in user, but only in their own name and only as pending.
-- They cannot pre-approve their own suggestion.
drop policy if exists link_review_insert on link_review;
create policy link_review_insert on link_review
  for insert to authenticated
  with check (submitted_by = auth.uid() and state = 'pending');

-- Read: your own submissions, so you can see what became of them; reviewers see
-- everything.
drop policy if exists link_review_select on link_review;
create policy link_review_select on link_review
  for select to authenticated
  using (
    submitted_by = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_reviewer)
  );

-- Decide: reviewers only. Note this is a separate check from reading, so a
-- volunteer who loses the flag immediately loses the ability to decide.
drop policy if exists link_review_update on link_review;
create policy link_review_update on link_review
  for update to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_reviewer))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.is_reviewer));

-- ── 4. Rate limit, enforced in the database ──────────────────────────────────
-- An account is cheap to make, so a client-side limit is decoration. Twenty
-- pending suggestions at a time is generous for honest use and useless for
-- flooding.
create or replace function link_review_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from link_review
      where submitted_by = new.submitted_by and state = 'pending') >= 20 then
    raise exception 'Too many suggestions still waiting for review';
  end if;
  return new;
end;
$$;

drop trigger if exists link_review_rate_limit_trg on link_review;
create trigger link_review_rate_limit_trg
  before insert on link_review
  for each row execute function link_review_rate_limit();
