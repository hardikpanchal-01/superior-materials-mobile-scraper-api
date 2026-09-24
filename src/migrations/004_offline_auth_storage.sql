-- Supporting schema for the self-hosted CNPG backend.
--
-- Adds the two things the tenant's previous hosted backend used to provide that
-- have no home in the tenant database: password-recovery tokens, and a bucket
-- for the objects that used to live in hosted object storage.
--
-- Note: `auth.users` is owned by another role, so the recovery token lives in
-- its own table in `public` rather than as extra columns on `auth.users`.
--
-- Safe to re-run.

-- ── auth: password recovery ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_recovery_tokens (
  user_id    uuid        PRIMARY KEY,
  email      text        NOT NULL,
  token      text        NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  consumed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_recovery_tokens_token
  ON public.auth_recovery_tokens (token);

CREATE INDEX IF NOT EXISTS idx_auth_recovery_tokens_email
  ON public.auth_recovery_tokens (lower(email));

-- ── storage ────────────────────────────────────────────────────────────────
-- Object storage. Objects are held in the database rather than on local disk so
-- that multiple API instances all see the same bytes.
CREATE TABLE IF NOT EXISTS public.storage_objects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket       text        NOT NULL,
  path         text        NOT NULL,
  content_type text,
  size_bytes   bigint,
  data         bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_objects_bucket_path_key UNIQUE (bucket, path)
);

CREATE INDEX IF NOT EXISTS idx_storage_objects_bucket_created
  ON public.storage_objects (bucket, created_at DESC);
