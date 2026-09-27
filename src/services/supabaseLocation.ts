import { createClient } from "@supabase/supabase-js";

// Fill these from your Supabase project (Settings → API).
// The anon/publishable key is safe to ship in the client bundle —
// row-level security policies are what actually protect the data.
const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string) ||
  "https://ccmdnkwnouxltxmwgqob.supabase.co";

const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ||
  "sb_publishable_fbRjLvgclDyzO5JNb7ohRA_bXywpHyT";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export type BusLocationRow = {
  bus_id: string;
  lat: number;
  lng: number;
  accuracy?: number;
  updated_at?: string;
  live?: boolean;
};

/**
 * Used only by the browser (non-native) GPS fallback path — the Android
 * native BusLocationService writes to Supabase directly from Java and does
 * NOT go through this function.
 */
export async function updateBusLocationSupabase(
  busId: string,
  lat: number,
  lng: number
) {
  const { error } = await supabase.from("bus_locations").upsert(
    {
      bus_id: busId,
      lat,
      lng,
      live: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "bus_id" }
  );

  if (error) {
    throw error;
  }
}

/**
 * Subscribes to live bus_locations changes. Calls onUpdate(busId, lat, lng)
 * once immediately for every row that already exists, then again every time
 * a row is inserted or updated. Returns an unsubscribe function.
 */
export function subscribeBusLocations(
  onUpdate: (busId: string, lat: number, lng: number) => void
) {
  let cancelled = false;

  supabase
    .from("bus_locations")
    .select("bus_id,lat,lng")
    .then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        console.error("Supabase bus_locations initial fetch failed:", error);
        return;
      }
      (data || []).forEach((row: any) => {
        if (typeof row.lat === "number" && typeof row.lng === "number") {
          onUpdate(row.bus_id, row.lat, row.lng);
        }
      });
    });

  const channel = supabase
    .channel("bus_locations_realtime")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "bus_locations" },
      (payload: any) => {
        const row = payload.new ?? payload.old;
        if (row && typeof row.lat === "number" && typeof row.lng === "number") {
          onUpdate(row.bus_id, row.lat, row.lng);
        }
      }
    )
    .subscribe();

  return () => {
    cancelled = true;
    supabase.removeChannel(channel);
  };
}