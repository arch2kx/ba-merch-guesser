alter table public.game_sessions add column if not exists round_started_at timestamptz default now();

create or replace function public.submit_guess(p_session_id uuid, p_round integer, p_guess numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.game_sessions;
  v_price numeric;
  v_off numeric;
  v_late boolean;
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

  if s.round_started_at is null then
    raise exception 'round_not_started';
  end if;

  v_late := p_guess is null or now() > s.round_started_at + interval '23 seconds';

  if not v_late and (p_guess = 'NaN'::numeric or p_guess <= 0 or p_guess >= 1000000000) then
    raise exception 'invalid_guess';
  end if;

  select i.price_usd into v_price from public.items i where i.id = s.current_item_id;

  if v_late then
    v_off := null;
    v_correct := false;
  else
    v_off := abs(p_guess - v_price) / v_price * 100;
    v_correct := v_off <= 20;
  end if;
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
    'timed_out', v_late,
    'percent_off', round(v_off, 4),
    'real_price', v_price,
    'score', v_score,
    'misses', v_misses,
    'game_over', v_over
  );

  update public.game_sessions
     set score = v_score,
         misses = v_misses,
         round = s.round + 1,
         deck = v_deck,
         deck_pos = v_pos,
         current_item_id = case when v_over then current_item_id else v_next end,
         round_started_at = null,
         last_result = v_result,
         finished_at = case when v_over then now() else null end,
         updated_at = now()
   where id = s.id;

  return v_result;
end;
$$;

create or replace function public.next_item(p_session_id uuid, p_round integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.game_sessions;
  v_started timestamptz;
begin
  select * into s from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'unknown_session';
  end if;

  if p_round is distinct from s.round then
    raise exception 'stale_round';
  end if;

  if s.finished_at is not null then
    raise exception 'game_over';
  end if;

  v_started := coalesce(s.round_started_at, now());
  if s.round_started_at is null then
    update public.game_sessions
       set round_started_at = v_started, updated_at = now()
     where id = s.id;
  end if;

  return jsonb_build_object(
    'round', s.round,
    'item', public.lb_item_json(s.current_item_id),
    'seconds_left', greatest(0, 20 - extract(epoch from now() - v_started))
  );
end;
$$;

revoke all on function public.submit_guess(uuid, integer, numeric) from public, anon, authenticated;
revoke all on function public.next_item(uuid, integer) from public, anon, authenticated;
grant execute on function public.submit_guess(uuid, integer, numeric) to anon, authenticated;
grant execute on function public.next_item(uuid, integer) to anon, authenticated;
