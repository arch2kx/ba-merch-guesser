alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges revoke execute on functions from public;

alter table public.leaderboard drop constraint if exists leaderboard_name_clean;
alter table public.leaderboard add constraint leaderboard_name_clean
  check (name = btrim(name) and name !~ '[[:cntrl:]]');

create index if not exists game_sessions_created_at_idx on public.game_sessions (created_at);
create index if not exists leaderboard_created_at_idx on public.leaderboard (created_at);

create or replace function public.game_sessions_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.created_at := now();
  new.updated_at := now();
  if (select count(*) from public.game_sessions where created_at > now() - interval '1 minute') >= 60 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.leaderboard_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.created_at := now();
  if (select count(*) from public.leaderboard where created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.game_sessions_before_insert() from public, anon, authenticated;
revoke all on function public.leaderboard_before_insert() from public, anon, authenticated;

drop trigger if exists game_sessions_before_insert on public.game_sessions;
create trigger game_sessions_before_insert
  before insert on public.game_sessions
  for each row execute function public.game_sessions_before_insert();

drop trigger if exists leaderboard_before_insert on public.leaderboard;
create trigger leaderboard_before_insert
  before insert on public.leaderboard
  for each row execute function public.leaderboard_before_insert();

revoke execute on function public.submit_score(uuid, text) from public, anon, authenticated;
grant execute on function public.submit_score(uuid, text) to service_role;
