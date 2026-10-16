create table public.items (
  id integer generated always as identity primary key,
  name text not null unique,
  image_url text not null,
  price_usd numeric(12, 4) not null check (price_usd > 0),
  safe boolean not null default false,
  active boolean not null default true
);

create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('safe', 'all')),
  score integer not null default 0,
  misses integer not null default 0,
  round integer not null default 0,
  deck integer[] not null default '{}',
  deck_pos integer not null default 1,
  current_item_id integer references public.items (id),
  last_result jsonb,
  finished_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index game_sessions_updated_at_idx on public.game_sessions (updated_at);

create table public.leaderboard (
  id bigint generated always as identity primary key,
  session_id uuid unique references public.game_sessions (id) on delete set null,
  name text not null check (char_length(name) between 1 and 20),
  mode text not null check (mode in ('safe', 'all')),
  score integer not null check (score > 0),
  created_at timestamptz not null default now()
);

create index leaderboard_rank_idx on public.leaderboard (mode, score desc, created_at, id);

alter table public.items enable row level security;
alter table public.game_sessions enable row level security;
alter table public.leaderboard enable row level security;

revoke all on table public.items, public.game_sessions, public.leaderboard from public, anon, authenticated;

create function public.lb_draw(p_mode text, inout p_deck integer[], inout p_pos integer, out p_item integer)
language plpgsql
set search_path = ''
as $$
begin
  if p_pos > coalesce(array_length(p_deck, 1), 0) then
    select coalesce(array_agg(i.id order by random()), '{}')
      into p_deck
      from public.items i
     where i.active and (p_mode = 'all' or i.safe);
    p_pos := 1;
    if coalesce(array_length(p_deck, 1), 0) = 0 then
      raise exception 'no_items';
    end if;
  end if;
  p_item := p_deck[p_pos];
  p_pos := p_pos + 1;
end;
$$;

create function public.lb_item_json(p_item integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', i.id, 'name', i.name, 'image_url', i.image_url)
    from public.items i
   where i.id = p_item;
$$;

create function public.lb_rank(p_entry bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select (count(*) + 1)::integer
    from public.leaderboard l
    join public.leaderboard me on me.id = p_entry
   where l.mode = me.mode
     and (l.score > me.score
          or (l.score = me.score and (l.created_at, l.id) < (me.created_at, me.id)));
$$;

create function public.start_game(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deck integer[];
  v_pos integer;
  v_item integer;
  v_id uuid;
begin
  if p_mode is null or p_mode not in ('safe', 'all') then
    raise exception 'invalid_mode';
  end if;

  delete from public.game_sessions where updated_at < now() - interval '1 day';

  select d.p_deck, d.p_pos, d.p_item
    into v_deck, v_pos, v_item
    from public.lb_draw(p_mode, '{}', 1) d;

  insert into public.game_sessions (mode, deck, deck_pos, current_item_id)
  values (p_mode, v_deck, v_pos, v_item)
  returning id into v_id;

  return jsonb_build_object(
    'session_id', v_id,
    'round', 0,
    'item', public.lb_item_json(v_item)
  );
end;
$$;

create function public.submit_guess(p_session_id uuid, p_round integer, p_guess numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.game_sessions;
  v_price numeric;
  v_off numeric;
  v_correct boolean;
  v_score integer;
  v_misses integer;
  v_over boolean;
  v_deck integer[];
  v_pos integer;
  v_next integer;
  v_result jsonb;
begin
  select * into s from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'unknown_session';
  end if;

  if p_round = s.round - 1 and s.last_result is not null then
    return s.last_result;
  end if;

  if p_round is distinct from s.round then
    raise exception 'stale_round';
  end if;

  if s.finished_at is not null then
    raise exception 'game_over';
  end if;

  if p_guess is null or p_guess = 'NaN'::numeric or p_guess <= 0 or p_guess >= 1000000000 then
    raise exception 'invalid_guess';
  end if;

  select i.price_usd into v_price from public.items i where i.id = s.current_item_id;

  v_off := abs(p_guess - v_price) / v_price * 100;
  v_correct := v_off <= 20;
  v_score := s.score + case when v_correct then 1 else 0 end;
  v_misses := s.misses + case when v_correct then 0 else 1 end;
  v_over := v_misses >= 5;
  v_deck := s.deck;
  v_pos := s.deck_pos;

  if not v_over then
    select d.p_deck, d.p_pos, d.p_item
      into v_deck, v_pos, v_next
      from public.lb_draw(s.mode, s.deck, s.deck_pos) d;
  end if;

  v_result := jsonb_build_object(
    'round', s.round + 1,
    'correct', v_correct,
    'percent_off', round(v_off, 4),
    'real_price', v_price,
    'score', v_score,
    'misses', v_misses,
    'game_over', v_over,
    'next_item', case when v_over then null else public.lb_item_json(v_next) end
  );

  update public.game_sessions
     set score = v_score,
         misses = v_misses,
         round = s.round + 1,
         deck = v_deck,
         deck_pos = v_pos,
         current_item_id = case when v_over then current_item_id else v_next end,
         last_result = v_result,
         finished_at = case when v_over then now() else null end,
         updated_at = now()
   where id = s.id;

  return v_result;
end;
$$;

create function public.submit_score(p_session_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.game_sessions;
  v_name text;
  v_id bigint;
begin
  select * into s from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'unknown_session';
  end if;

  if s.submitted_at is not null then
    select l.id into v_id from public.leaderboard l where l.session_id = s.id;
    return jsonb_build_object('id', v_id, 'rank', public.lb_rank(v_id));
  end if;

  if s.finished_at is null then
    raise exception 'game_not_over';
  end if;

  if s.score < 1 then
    raise exception 'score_too_low';
  end if;

  v_name := btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g'));
  if char_length(v_name) not between 1 and 20 then
    raise exception 'invalid_name';
  end if;

  insert into public.leaderboard (session_id, name, mode, score)
  values (s.id, v_name, s.mode, s.score)
  returning id into v_id;

  update public.game_sessions
     set submitted_at = now(), updated_at = now()
   where id = s.id;

  return jsonb_build_object('id', v_id, 'rank', public.lb_rank(v_id));
end;
$$;

create function public.get_leaderboard(p_mode text, p_limit integer default 10)
returns table (id bigint, name text, score integer, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.name, l.score, l.created_at
    from public.leaderboard l
   where l.mode = p_mode
   order by l.score desc, l.created_at, l.id
   limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

revoke all on function public.lb_draw(text, integer[], integer) from public, anon, authenticated;
revoke all on function public.lb_item_json(integer) from public, anon, authenticated;
revoke all on function public.lb_rank(bigint) from public, anon, authenticated;
revoke all on function public.start_game(text) from public, anon, authenticated;
revoke all on function public.submit_guess(uuid, integer, numeric) from public, anon, authenticated;
revoke all on function public.submit_score(uuid, text) from public, anon, authenticated;
revoke all on function public.get_leaderboard(text, integer) from public, anon, authenticated;

grant execute on function public.start_game(text) to anon, authenticated;
grant execute on function public.submit_guess(uuid, integer, numeric) to anon, authenticated;
grant execute on function public.submit_score(uuid, text) to anon, authenticated;
grant execute on function public.get_leaderboard(text, integer) to anon, authenticated;
