-- Movix : miroir des comptes et de l'historique, domaines des sources.
--
-- Deux tables, toutes deux réservées au serveur Movix :
--
--   user_files      copie de data/users/ (comptes, profils, historique,
--                   progression, favoris), un fichier JSON par ligne.
--                   Écrite par le processus maître de l'API
--                   (API/Mainapi/utils/supabaseMirror.js).
--   source_domains  domaines des sites sources. Une URL saisie ici remplace
--                   le défaut du code ; une variable du .env reste
--                   prioritaire. Vide = défaut du code.
--
-- Accès : RLS activée SANS aucune policy, et droits retirés aux rôles anon et
-- authenticated. Seule la clé secrète (rôle service_role, qui contourne la
-- RLS) lit ou écrit. La clé publique du projet ne donne accès à rien ici.

-- === user_files ==============================================================

create table public.user_files (
  -- Chemin relatif à data/users/, ex. bip39-<id>.json ou
  -- profiles/bip39/<id>/<profil>.json
  path text primary key
    check (
      char_length(path) <= 512
      and path ~ '^[A-Za-z0-9_][A-Za-z0-9._/-]*\.json$'
      and path !~ '\.\.'
      and path !~ '//'
    ),
  content jsonb,
  -- Date de modification du fichier, en millisecondes : sert de numéro de
  -- version. Une écriture plus ancienne que la ligne en place est ignorée.
  version bigint not null check (version > 0),
  -- Fichier supprimé côté serveur (profil supprimé…) : la ligne reste comme
  -- pierre tombale, pour qu'une copie plus ancienne ne le ressuscite pas.
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  check (deleted or content is not null)
);

comment on table public.user_files is
  'Miroir de data/users/ du serveur Movix (comptes, profils, historique). Écrit par le serveur uniquement.';

alter table public.user_files enable row level security;
revoke all on table public.user_files from anon, authenticated;

-- Écriture conditionnelle : n'écrase que si la version reçue est plus
-- récente. Renvoie true si la ligne a été écrite.
create function public.mirror_put(p_path text, p_content jsonb, p_version bigint)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with written as (
    insert into public.user_files as f (path, content, version, deleted, updated_at)
    values (p_path, p_content, p_version, false, now())
    on conflict (path) do update
      set content = excluded.content,
          version = excluded.version,
          deleted = false,
          updated_at = now()
      where f.version < excluded.version
    returning 1
  )
  select exists (select 1 from written);
$$;

create function public.mirror_delete(p_path text, p_version bigint)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with written as (
    update public.user_files
      set content = null,
          version = p_version,
          deleted = true,
          updated_at = now()
      where path = p_path and version < p_version
    returning 1
  )
  select exists (select 1 from written);
$$;

revoke all on function public.mirror_put(text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.mirror_delete(text, bigint) from public, anon, authenticated;
grant execute on function public.mirror_put(text, jsonb, bigint) to service_role;
grant execute on function public.mirror_delete(text, bigint) to service_role;

-- === source_domains ==========================================================

create table public.source_domains (
  -- Identifiant de API/Mainapi/config/sources.js
  id text primary key check (id ~ '^[A-Za-z]{1,40}$'),
  -- Vide = défaut du code. Sinon https://domaine (ou URL complète pour les
  -- entrées PurStream).
  url text check (url is null or (char_length(url) <= 300 and url ~ '^https?://[^\s]+$')),
  description text,
  updated_at timestamptz not null default now()
);

comment on table public.source_domains is
  'Domaines des sites sources de Movix. url vide = défaut du code ; une variable du .env reste prioritaire.';

alter table public.source_domains enable row level security;
revoke all on table public.source_domains from anon, authenticated;

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;

create trigger source_domains_updated_at
  before update on public.source_domains
  for each row execute function public.touch_updated_at();

insert into public.source_domains (id, description) values
  ('wiflix',          'Wiflix (séries) — WIFLIX_BASE_URL, défaut du code : https://flemmix.fast'),
  ('coflix',          'Coflix — COFLIX_BASE_URL, défaut du code : https://coflix.date'),
  ('cinestream',      'Cinestream (films) — CINESTREAM_BASE_URL, défaut du code : https://cinestream.info'),
  ('darkiworld',      'Darkiworld — DARKIWORLD_BASE_URL, défaut du code : https://darkiworld2026.com'),
  ('fstream',         'FStream — FSTREAM_BASE_URL, défaut du code : https://french-stream.one'),
  ('frenchstream',    'FrenchStream — FRENCHSTREAM_BASE_URL, défaut du code : https://frenchstream.food'),
  ('voirdrama',       'VoirDrama — VOIRDRAMA_BASE_URL, défaut du code : https://voirdrama.to'),
  ('animeSama',       'Anime-Sama — ANIME_SAMA_BASE_URL, défaut du code : https://anime-sama.to'),
  ('purstreamStatus', 'PurStream, page de statut (URL complète) — PURSTREAM_STATUS_URL, défaut : https://purstream.wiki/api/status'),
  ('purstreamApi',    'PurStream, API (URL complète) — PURSTREAM_API_BASE, défaut : https://api.purstream.id/api/v1');
