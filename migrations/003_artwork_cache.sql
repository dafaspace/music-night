-- Cache the artwork and preview alongside the links, so a shared page pays the
-- lookup once rather than once per visitor.
--
-- Measured before this: a 35-track playlist made 34 sequential iTunes requests
-- that took 39 seconds to finish, with the covers arriving after that. These
-- values come from the platform rather than from a person, so unlike the direct
-- links they need no review - there is nobody to disagree with.
alter table track_links add column if not exists artwork_url text;
alter table track_links add column if not exists preview_url text;

-- The playlist dates were three hours out because these columns carry no zone:
-- Postgres returns a bare timestamp, JavaScript reads it as local, and a
-- playlist saved a moment ago reads as "3h ago" at UTC+3. The existing values
-- were written as UTC, so that is what they are declared to be.
alter table music_playlists
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column updated_at type timestamptz using updated_at at time zone 'UTC';
alter table playlist_tracks
  alter column created_at type timestamptz using created_at at time zone 'UTC';
alter table profiles
  alter column created_at type timestamptz using created_at at time zone 'UTC';

-- Remember a miss, not only a hit. Four tracks on a 35-track playlist are not
-- findable by search at all - "Dave Brubeck 40 Days" returns eight results
-- without 40 Days among them - and without this they were re-asked on every
-- visit, forever, for an answer that does not change. Re-checked after a month,
-- so a catalogue addition is still picked up.
alter table track_links add column if not exists enrich_missed_at timestamptz;
