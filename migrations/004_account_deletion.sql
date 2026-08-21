-- Account deletion, required by App Store review rule 5.1.1(v): an app that
-- offers account creation must offer account deletion inside the app. A support
-- email or a page on the website does not satisfy it.
--
-- Deleting the auth user would currently fail: profiles.id and
-- music_playlists.user_id both reference auth.users with no cascade, so Postgres
-- refuses while those rows exist. Rather than deleting in sequence from the
-- client - which leaves half-deleted accounts whenever a step fails midway -
-- the database is told what "delete this person" means, once.

-- profiles.id -> auth.users(id)
alter table profiles
  drop constraint if exists profiles_id_fkey;
alter table profiles
  add constraint profiles_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- music_playlists.user_id -> auth.users(id)
-- playlist_tracks already cascades from music_playlists, so tracks follow.
alter table music_playlists
  drop constraint if exists music_playlists_user_id_fkey;
alter table music_playlists
  add constraint music_playlists_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- link_review keeps its rows but forgets who submitted them: the queue is an
-- audit trail, and losing the history of a decision because someone closed their
-- account would be worse than keeping an anonymous row. Already ON DELETE SET
-- NULL from migration 002; restated here so the intent is visible in one place.
--
-- track_links is deliberately untouched. It holds artwork, previews and verified
-- links for recordings, not personal data - nobody's account owns the fact that
-- a Deezer URL points at a particular song.
