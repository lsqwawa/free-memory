DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'free_memory') THEN
    CREATE ROLE free_memory LOGIN PASSWORD 'FreeMemory@2026';
  END IF;
END
$$;

SELECT 'CREATE DATABASE "FreeMemory" OWNER free_memory'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'FreeMemory')\gexec
