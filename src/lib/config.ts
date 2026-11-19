// Verbinding met de Supabase-server voor groepsritten (alleen Realtime: posities
// en berichten worden doorgestuurd, niets wordt opgeslagen).
// De publishable key is bedoeld om openbaar in een app te staan.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? '';

export const groupRidesAvailable = () => !!SUPABASE_URL && !!SUPABASE_KEY;
