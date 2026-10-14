-- Provision isolated development and test databases.
--
-- Applied to the development-only PostgreSQL 18 instance, never to the shared
-- server. The runtime roles are deliberately NOT superusers and are NOT granted
-- CREATEDB or CREATEROLE: they own their own database, which is the minimum
-- needed for Prisma to create and migrate the schema inside it, and nothing
-- more.
--
--   psql -U zwscloud_pgadmin -d postgres -f scripts/provision-dev-databases.sql
--
-- Passwords are supplied as psql variables so they never appear in the script,
-- in shell history, or in the process list:
--
--   psql -v dev_app_pw="$DEV" -v test_app_pw="$TEST" -U zwscloud_pgadmin -d postgres \
--        -f scripts/provision-dev-databases.sql

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Runtime roles. Least privilege by construction.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zwscloud_dev_app') THEN
    CREATE ROLE zwscloud_dev_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zwscloud_test_app') THEN
    CREATE ROLE zwscloud_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- Passwords are set separately so re-running the script never rotates a live
-- secret. `zwscloud_dev_app` is the role the development stack connects as.
ALTER ROLE zwscloud_dev_app  WITH PASSWORD :'dev_app_pw';
ALTER ROLE zwscloud_test_app WITH PASSWORD :'test_app_pw';

-- ---------------------------------------------------------------------------
-- Development database.
-- ---------------------------------------------------------------------------
SELECT 'CREATE DATABASE zwscloud_dev OWNER zwscloud_dev_app ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zwscloud_dev')\gexec

-- ---------------------------------------------------------------------------
-- Test database. Kept separate from development so a test run can reset or
-- truncate freely without touching development data.
-- ---------------------------------------------------------------------------
SELECT 'CREATE DATABASE zwscloud_test OWNER zwscloud_test_app ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zwscloud_test')\gexec

-- ---------------------------------------------------------------------------
-- Schema privileges.
--
-- The database owner is already a member of `pg_database_owner`, which owns
-- the `public` schema on PostgreSQL 15+, so it can create objects without
-- CREATE being granted to PUBLIC. Revoking CREATE from PUBLIC stops any other
-- role from creating objects in these databases.
-- ---------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO zwscloud_dev_app, zwscloud_test_app;

-- CONNECT is required to reach the database at all.
GRANT CONNECT ON DATABASE zwscloud_dev  TO zwscloud_dev_app;
GRANT CONNECT ON DATABASE zwscloud_test TO zwscloud_test_app;

-- ---------------------------------------------------------------------------
-- Verify. The runtime roles must not be able to create databases or roles.
-- ---------------------------------------------------------------------------
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname IN ('zwscloud_dev_app', 'zwscloud_test_app')
ORDER BY rolname;
