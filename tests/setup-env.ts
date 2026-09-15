import { config } from "dotenv";

// Database/integration tests run against a local Supabase stack
// (`npm run db:start`) and read its connection details from .env.local,
// same as the app. Falls back silently if .env.local doesn't exist so
// unit tests that need no Supabase connection are unaffected.
config({ path: ".env.local" });
