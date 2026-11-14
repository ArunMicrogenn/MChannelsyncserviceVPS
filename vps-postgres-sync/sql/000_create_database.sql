-- Step 1: Run as postgres superuser on your VPS:
--   sudo -u postgres psql -f sql/000_create_database.sql
--
-- Be sure to replace 'change_me_strong_password' below AND set the same password in .env (PGPASSWORD=...).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'mchannel_sync') THEN
    CREATE ROLE mchannel_sync WITH LOGIN PASSWORD 'change_me_strong_password';
  END IF;
END
$$;

SELECT 'CREATE DATABASE mchannel_pms_sync OWNER mchannel_sync'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mchannel_pms_sync')\gexec

GRANT ALL PRIVILEGES ON DATABASE mchannel_pms_sync TO mchannel_sync;

\connect mchannel_pms_sync
GRANT ALL ON SCHEMA public TO mchannel_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO mchannel_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO mchannel_sync;
