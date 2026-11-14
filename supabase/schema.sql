-- UPJV SPORT · Classé foot à 5 : équipes, coéquipiers, propositions de match.
-- À coller UNE FOIS dans Supabase › SQL Editor › New query, puis « Run ».
-- Les tables ne sont jamais lues directement par le site : tout passe par les fonctions ci-dessous (sécurité).

create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 40),
  category text not null default 'Foot à 5',
  captain_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'validated', 'rejected')),
  welcome_sent boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists teams_name_uq on public.teams (lower(name));

create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (team_id, user_id)
);
-- un joueur ne peut appartenir qu'à une seule équipe
create unique index if not exists team_members_one_team on public.team_members (user_id);

create table if not exists public.match_requests (
  id uuid primary key default gen_random_uuid(),
  from_team uuid not null references public.teams(id) on delete cascade,
  to_team uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (from_team, to_team)
);

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.match_requests enable row level security;
-- aucune policy : le navigateur n'a aucun accès direct aux tables.

-- Inscription d'une équipe : le capitaine (utilisateur connecté) + 4 coéquipiers identifiés par l'e-mail de leur compte.
create or replace function public.register_team(p_name text, p_emails text[])
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  my_email text;
  emails text[];
  e text;
  missing text[] := '{}';
  busy text[] := '{}';
  ids uuid[] := '{}';
  mid uuid;
  tid uuid;
begin
  if uid is null then raise exception 'Connecte-toi pour inscrire ton équipe.'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) < 2 or char_length(p_name) > 40 then raise exception 'Le nom de l''équipe doit faire entre 2 et 40 caractères.'; end if;
  select lower(email) into my_email from auth.users where id = uid;
  select array_agg(distinct lower(btrim(x))) into emails from unnest(coalesce(p_emails, '{}')) x where btrim(x) <> '';
  emails := array_remove(coalesce(emails, '{}'), my_email);
  if coalesce(array_length(emails, 1), 0) <> 4 then
    raise exception 'Il faut 4 coéquipiers différents, en plus de toi (foot à 5). Vérifie les adresses saisies.';
  end if;
  if exists (select 1 from team_members where user_id = uid) then raise exception 'Tu fais déjà partie d''une équipe.'; end if;
  if exists (select 1 from teams where lower(name) = lower(p_name)) then raise exception 'Ce nom d''équipe est déjà pris : choisis-en un autre.'; end if;
  foreach e in array emails loop
    select id into mid from auth.users where lower(email) = e and email_confirmed_at is not null;
    if mid is null then missing := missing || e;
    elsif exists (select 1 from team_members where user_id = mid) then busy := busy || e;
    else ids := ids || mid; end if;
  end loop;
  if array_length(missing, 1) > 0 then
    raise exception 'Pas de compte confirmé pour : %. Chaque joueur doit d''abord créer son compte sur le site.', array_to_string(missing, ', ');
  end if;
  if array_length(busy, 1) > 0 then
    raise exception 'Déjà dans une autre équipe : %.', array_to_string(busy, ', ');
  end if;
  insert into teams (name, captain_id) values (p_name, uid) returning id into tid;
  insert into team_members (team_id, user_id) values (tid, uid);
  foreach mid in array ids loop insert into team_members (team_id, user_id) values (tid, mid); end loop;
  return json_build_object('team_id', tid);
end $$;

-- Mon équipe (ou null), avec les prénoms et noms des joueurs.
create or replace function public.my_team()
returns json
language sql
security definer
set search_path = public, auth
stable
as $$
  select json_build_object(
    'id', t.id, 'name', t.name, 'status', t.status, 'is_captain', t.captain_id = auth.uid(),
    'members', (select json_agg(json_build_object(
        'prenom', coalesce(u.raw_user_meta_data->>'prenom', ''),
        'nom', coalesce(u.raw_user_meta_data->>'nom', ''),
        'captain', u.id = t.captain_id) order by (u.id = t.captain_id) desc, u.created_at)
      from team_members m join auth.users u on u.id = m.user_id where m.team_id = t.id))
  from teams t join team_members me on me.team_id = t.id and me.user_id = auth.uid()
  limit 1;
$$;

-- Équipes validées contre lesquelles je peux jouer (la mienne exclue).
create or replace function public.opponents()
returns table (id uuid, name text, captain_prenom text, already_asked boolean)
language sql
security definer
set search_path = public, auth
stable
as $$
  with mine as (select m.team_id from team_members m where m.user_id = auth.uid())
  select t.id, t.name, coalesce(u.raw_user_meta_data->>'prenom', ''),
         exists (select 1 from match_requests r where r.from_team = (select team_id from mine) and r.to_team = t.id)
  from teams t join auth.users u on u.id = t.captain_id
  where t.status = 'validated' and auth.uid() is not null
    and t.id not in (select team_id from mine)
  order by t.name;
$$;

-- Équipes validées affichées dans le classement public (noms uniquement).
create or replace function public.public_teams()
returns table (name text, category text)
language sql
security definer
set search_path = public
stable
as $$ select name, category from teams where status = 'validated' order by name; $$;

revoke all on function public.register_team(text, text[]) from public, anon;
revoke all on function public.my_team() from public, anon;
revoke all on function public.opponents() from public, anon;
grant execute on function public.register_team(text, text[]) to authenticated;
grant execute on function public.my_team() to authenticated;
grant execute on function public.opponents() to authenticated;
grant execute on function public.public_teams() to anon, authenticated;

-- Valider une équipe (à faire à la main dans Table Editor › teams, colonne status : pending → validated)
-- ou en SQL :  update public.teams set status = 'validated' where lower(name) = lower('Nom de l''équipe');
