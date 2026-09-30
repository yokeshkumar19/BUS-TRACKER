import * as React from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, Marker as MapLibreMarker, Popup as MapLibrePopup, Source, Layer, useMap } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { Capacitor, registerPlugin, PluginListenerHandle } from "@capacitor/core";
import { subscribeBusLocations, updateBusLocationSupabase } from "./services/supabaseLocation";
import { supabase } from "./services/supabaseLocation";

type BusLocationPlugin = {
  start(opts: { busId: string; projectId: string; apiKey: string; collection?: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: "location",
    listenerFunc: (data: { latitude: number; longitude: number; accuracy: number; time: number }) => void
  ): Promise<PluginListenerHandle>;
};

const BusLocation = registerPlugin<BusLocationPlugin>("BusLocation");

const FIREBASE_PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID as string;
const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY as string;

import { auth } from "./firebase";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "firebase/auth";

import ritLogo from "@/imports/Logo2.jpeg";
import {
  FireBus,
  FireRouteStop,
  FireStopRequest,
  getUserProfile,
  createUserProfile,
  createDriverAccount,
  subscribeDrivers,
  subscribeBuses,
  subscribeRouteStops,
  subscribeStopRequests,
  subscribeStopRequestsForDriver,
  addBus,
  updateBus,
  deleteBus,
  setRouteStops,
  setBusLive,
  addStopRequest,
  shareStudentLocation,
  stopSharingStudentLocation,
  decideStopRequest,
  updateUserProfile,
} from "./firestoreService";

type Screen =
  | "splash" | "login"
  | "student-home" | "live-map" | "bus-details" | "route-stops"
  | "find-bus" | "stop-here" | "make-stop" | "notifications" | "my-trips" | "profile"
  | "settings"
  | "driver-home" | "driver-start" | "driver-live"
  | "admin-home" | "admin-stops" | "admin-manage" | "admin-drivers"
  | "admin-add-bus" | "admin-edit-bus";

type Role = "student" | "driver" | "admin";
type TripDirection = "outbound" | "return";

function getTripDirection(bus?: FireBus): TripDirection {
  return (bus as any)?.direction === "return" ? "return" : "outbound";
}

function getDirectionalStops(stops: FireRouteStop[], bus?: FireBus): FireRouteStop[] {
  return getTripDirection(bus) === "return" ? [...stops].reverse() : stops;
}

function getDirectionalRouteName(routeName?: string, direction: TripDirection = "outbound") {
  if (!routeName || direction === "outbound") return routeName || "—";
  const arrowParts = routeName.split(/\s*(?:→|->)\s*/);
  if (arrowParts.length === 2) return `${arrowParts[1]} → ${arrowParts[0]}`;
  const toParts = routeName.split(/\s+to\s+/i);
  if (toParts.length === 2) return `${toParts[1]} → ${toParts[0]}`;
  return `${routeName} · Return`;
}
// Empty fallbacks — prevents fake demo data
const FALLBACK_BUSES: FireBus[] = [];

const FALLBACK_STOPS: FireRouteStop[] = [];
const EMPTY_BUS: FireBus = {
  id: "",
  n: "No bus",
  r: "—",
  routeName: "No bus data available",
  eta: 0,
  live: false,
  dist: "—",
  stops: 0,
};
type Language = "en" | "ta";
type Theme = "light" | "dark";
type Preferences = { theme: Theme; language: Language };
type UserProfile = { uid?: string; email: string; name: string; role: Role; assignedBusId?: string };

type Trip = { bus: string; from: string; to: string; date: string; status: string };
type Notification = { icon: string; title: string; time: string; dot: string; isNew: boolean };





// Shown only until the admin has added real buses/stops in Firestore, so the
// app never looks empty/broken during a first run or a live demo.



function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) as T : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function enableBrowserNotifications() {
  if (!("Notification" in window)) return "unsupported" as const;
  return Notification.requestPermission();
}

function nameFromEmail(email: string) {
  const localPart = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\d+/g, " ").trim();
  return localPart ? localPart.split(" ").filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ") : "RIT Student";
}

const copy = {
  en: { profile: "Profile", settings: "Settings", appearance: "Appearance", darkMode: "Dark mode", language: "Language", english: "English", tamil: "Tamil", save: "Saved", signOut: "Sign Out" },
  ta: { profile: "சுயவிவரம்", settings: "அமைப்புகள்", appearance: "தோற்றம்", darkMode: "இருண்ட பயன்முறை", language: "மொழி", english: "ஆங்கிலம்", tamil: "தமிழ்", save: "சேமிக்கப்பட்டது", signOut: "வெளியேறு" },
} as const;

function useGeolocation() {
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!navigator.geolocation) {
      setAvailable(false);
      return;
    }
    const watch = navigator.geolocation.watchPosition(setPosition, () => setAvailable(false), { enableHighAccuracy: true, maximumAge: 10000 });
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  return { position, available };
}
/**
 * Driver GPS tracking.
 * - Runs only while `active` is true (trip in progress), independent of which
 *   screen is showing, so pressing Back no longer kills tracking.
 * - Uploads to Firestore directly inside the GPS callback. It does NOT wait for
 *   a React render/effect, which Android throttles when the app is backgrounded.
 */
function useDriverBackgroundLocation(busId: string, active: boolean): GeolocationPosition | null {
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const busIdRef = useRef(busId);
  useEffect(() => { busIdRef.current = busId; }, [busId]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let browserWatchId: number | null = null;
    let listenerHandle: PluginListenerHandle | null = null;

    const push = async (lat: number, lng: number) => {

      const currentBusId = busIdRef.current;

      if (!currentBusId) {
        console.error("GPS: busId is missing");
        return;
      }

      console.log(
        "GPS → SUPABASE:",
        currentBusId,
        lat,
        lng
      );

      const { error } = await supabase
        .from("bus_locations")
        .upsert(
          {
            bus_id: currentBusId,
            lat: lat,
            lng: lng,
            accuracy: 5,
            updated_at: new Date().toISOString(),
            live: true,
          },
          {
            onConflict: "bus_id",
          }
        );

      if (error) {

        console.error(
          "SUPABASE GPS ERROR:",
          error
        );

      } else {

        console.log(
          "SUPABASE GPS SUCCESS:",
          currentBusId,
          lat,
          lng
        );
      }
    };

    if (Capacitor.isNativePlatform()) {
      BusLocation.addListener("location", (loc) => {

        console.log(
          "ANDROID GPS:",
          loc.latitude,
          loc.longitude
        );

        push(
          loc.latitude,
          loc.longitude
        );

        setPosition({
          coords: {
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,

            toJSON() {
              return this;
            },
          },

          timestamp: loc.time,

          toJSON() {
            return this;
          },
        } as GeolocationPosition);

      }).then(handle => {
        if (cancelled) {
          handle.remove().catch(console.error);
        } else {
          listenerHandle = handle;
        }
      });

      BusLocation.start({
        busId: busIdRef.current,
        projectId: FIREBASE_PROJECT_ID,
        apiKey: FIREBASE_API_KEY,
        collection: "buses",
      }).catch(error => console.error("Unable to start background GPS:", error));

    } else if (navigator.geolocation) {
      browserWatchId = navigator.geolocation.watchPosition(
        p => {
          push(p.coords.latitude, p.coords.longitude);
          setPosition(p);
        },
        error => console.error("Browser GPS error:", error),
        { enableHighAccuracy: true, maximumAge: 10000 }
      );
    } else {
      console.error("Geolocation is not supported");
    }

    return () => {
      cancelled = true;
      if (Capacitor.isNativePlatform()) {
        BusLocation.stop().catch(console.error);
        listenerHandle?.remove().catch(console.error);
      }
      if (browserWatchId !== null) navigator.geolocation.clearWatch(browserWatchId);
    };
  }, [active]);

  return active ? position : null;
}

function useRealEta(
  busPosition: { lat: number; lng: number } | null,
  stop?: FireRouteStop,
) {
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const stopKey = stop?.lat != null && stop.lng != null ? `${stop.lat},${stop.lng}` : "";
  const positionKey = busPosition ? `${busPosition.lat},${busPosition.lng}` : "";

  useEffect(() => {
    if (!busPosition || stop?.lat == null || stop.lng == null) {
      setEtaMinutes(null);
      return;
    }

    const controller = new AbortController();
    fetch(
      `https://router.project-osrm.org/route/v1/driving/${busPosition.lng},${busPosition.lat};${stop.lng},${stop.lat}?overview=false`,
      { signal: controller.signal },
    )
      .then(response => {
        if (!response.ok) throw new Error(`ETA request failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        const duration = data.routes?.[0]?.duration;
        setEtaMinutes(typeof duration === "number" ? Math.max(1, Math.round(duration / 60)) : null);
      })
      .catch(error => {
        if (error.name !== "AbortError") {
          console.error("Unable to calculate ETA", error);
          setEtaMinutes(null);
        }
      });

    return () => controller.abort();
  }, [positionKey, stopKey]);

  return etaMinutes;
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  navy: "var(--c-navy, #0D1B2A)",
  blue: "var(--c-blue, #1565C0)",
  blueMid: "var(--c-blue-mid, #1976D2)",
  sky: "var(--c-sky, #0288D1)",
  skyLight: "var(--c-sky-light, #E1F0FA)",
  skySubtle: "var(--c-sky-subtle, rgba(2, 136, 209, 0.12))",
  live: "var(--c-live, #1B8C3E)",
  liveBg: "var(--c-live-bg, #E8F5EE)",
  warn: "var(--c-warn, #C84B11)",
  warnBg: "var(--c-warn-bg, #FEF0E8)",
  border: "var(--c-border, #E4E9F0)",
  bg: "var(--c-bg, #F7F9FC)",
  surface: "var(--c-surface, #FFFFFF)",
  text: "var(--c-text, #0D1B2A)",
  sub: "var(--c-sub, #4A5568)",
  muted: "var(--c-muted, #8A96A3)",
  blueSubtle: "var(--c-blue-subtle, rgba(21, 101, 192, 0.08))",
  blueGlow: "var(--c-blue-glow, rgba(21, 101, 192, 0.22))",
  danger: "var(--c-danger, #C62828)",
  dangerBg: "var(--c-danger-bg, #FFEBEE)",
};

const ThemeContext = createContext<{
  theme: Theme;
  toggleTheme: () => void;
}>({
  theme: "light",
  toggleTheme: () => { },
});

function useTheme() {
  return useContext(ThemeContext);
}

const MAP_STYLE = {
  version: 8 as const,
  sources: {
    "openstreetmap-tiles": {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "openstreetmap-tiles",
      type: "raster" as const,
      source: "openstreetmap-tiles",
    },
  ],
};


// ── Tiny icon set ─────────────────────────────────────────────────────────────
const Ic = {
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  home: <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>,
  map: <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z" /></svg>,
  bus: <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z" /></svg>,
  bell: <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" /></svg>,
  person: <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></svg>,
  pin: <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" /></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M10 17l5-5-5-5v10z" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M20 6L9 17l-5-5" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></svg>,
  play: <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M8 5v14l11-7z" /></svg>,
  speed: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>,
  edit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>,
  driver: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="7" r="4" /><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" /></svg>,
  route: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" /><path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12" /></svg>,
  stop: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      ...
    </svg>
  ),

  report: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="20"
      height="20"
    >
      <path d="M4 20V4" />
      <path d="M4 5h11l-2 4 2 4H4" />
    </svg>
  ),
};


// ── Reusable primitives ───────────────────────────────────────────────────────
// NOTCH = 28px. StatusBar must start below it.
function StatusBar({ dark = false }) {
  return null;
}

function TopBar({ title, onBack, rightEl }: { title: string; onBack: () => void; rightEl?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px 12px" }}>
      <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, cursor: "pointer" }}>
        {Ic.back}
      </button>
      <span style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, color: C.text }}>{title}</span>
      <div style={{ width: 36 }}>{rightEl}</div>
    </div>
  );
}

function LiveBadge({ small }: { small?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: C.liveBg, color: C.live, borderRadius: 20, padding: small ? "2px 8px" : "3px 10px", fontSize: small ? 10 : 11, fontWeight: 700, letterSpacing: "0.3px" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.live, display: "inline-block", animation: "livePulse 1.4s ease-in-out infinite" }} />
      LIVE
    </span>
  );
}

function PrimaryBtn({ label, onClick, icon }: { label: string; onClick: () => void; icon?: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ width: "100%", height: 50, borderRadius: 12, background: C.blue, color: "#fff", border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "opacity 0.15s" }}
      onMouseDown={e => (e.currentTarget.style.opacity = "0.85")} onMouseUp={e => (e.currentTarget.style.opacity = "1")} onTouchStart={e => (e.currentTarget.style.opacity = "0.85")} onTouchEnd={e => (e.currentTarget.style.opacity = "1")}>
      {icon}{label}
    </button>
  );
}

function GhostBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: "100%", height: 50, borderRadius: 12, background: "transparent", color: C.blue, border: `1.5px solid ${C.blue}`, fontFamily: "Outfit,sans-serif", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>
      {label}
    </button>
  );
}

function InputField({ label, placeholder, type = "text", value, onChange, suffix }: { label: string; placeholder: string; type?: string; value: string; onChange: (v: string) => void; suffix?: React.ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6, letterSpacing: "0.2px" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", border: `1.5px solid ${focused ? C.blue : C.border}`, borderRadius: 10, height: 48, padding: "0 14px", background: C.surface, gap: 8, transition: "border-color 0.2s" }}>
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          style={{ flex: 1, border: "none", outline: "none", fontSize: 15, color: C.text, background: "transparent", fontFamily: "Inter,sans-serif" }} />
        {suffix}
      </div>
    </div>
  );
}

function BottomNav({ active, onNav }: { active: string; onNav: (s: Screen) => void }) {
  const tabs = [
    { id: "student-home", label: "Home", icon: Ic.home },
    { id: "live-map", label: "Map", icon: Ic.map },
    { id: "my-trips", label: "Trips", icon: Ic.bus },
    { id: "notifications", label: "Alerts", icon: Ic.bell },
    { id: "profile", label: "Profile", icon: Ic.person },
  ] as const;
  return (
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: C.surface, borderTop: `1px solid ${C.border}`, display: "flex", padding: "6px 0 20px" }}>
      {tabs.map(t => {
        const on = active === t.id;
        return (
          <button key={t.id} onClick={() => onNav(t.id as Screen)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, border: "none", background: "none", cursor: "pointer", color: on ? C.blue : C.muted, padding: "4px 0" }}>
            {t.icon}
            <span style={{ fontSize: 10, fontWeight: on ? 700 : 500, fontFamily: "Inter,sans-serif" }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function MockMapView({ animateBus = true, height = 280 }: { animateBus?: boolean; height?: number }) {
  const [t, setT] = useState(0.3);
  const { position, available } = useGeolocation();
  useEffect(() => {
    if (!animateBus) return;
    const id = setInterval(() => setT(p => (p + 0.002) % 1), 50);
    return () => clearInterval(id);
  }, [animateBus]);

  const pts: [number, number][] = [[30, 200], [80, 170], [140, 145], [200, 130], [255, 140], [310, 115], [360, 95]];
  const seg = Math.floor(t * (pts.length - 1));
  const frac = t * (pts.length - 1) - seg;
  const p1 = pts[Math.min(seg, pts.length - 1)];
  const p2 = pts[Math.min(seg + 1, pts.length - 1)];
  const bx = p1[0] + (p2[0] - p1[0]) * frac;
  const by = p1[1] + (p2[1] - p1[1]) * frac;
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");

  return (
    <svg width="100%" height={height} viewBox={`0 0 390 ${height}`} preserveAspectRatio="xMidYMid slice" style={{ display: "block" }}>
      <rect width="390" height={height} fill="#ECF0E8" />
      {/* Roads */}
      <rect x="0" y="85" width="390" height="22" fill="#D8DED4" />
      <rect x="0" y="155" width="390" height="16" fill="#D8DED4" />
      <rect x="75" y="0" width="18" height={height} fill="#D8DED4" />
      <rect x="195" y="0" width="14" height={height} fill="#D8DED4" />
      <rect x="305" y="0" width="12" height={height} fill="#D8DED4" />
      {/* Blocks */}
      {[[16, 20, 50, 58], [130, 20, 55, 45], [230, 25, 65, 48], [320, 110, 52, 38], [20, 185, 48, 60], [148, 192, 38, 50], [260, 175, 50, 45]].map(([x, y, w, h], i) =>
        <rect key={i} x={x} y={y} width={w} height={h} rx="3" fill="#C4CCBA" opacity="0.55" />)}
      {/* Green parks */}
      <rect x="100" y="105" width="72" height="40" rx="6" fill="#B8D4A8" opacity="0.7" />
      <rect x="218" y="172" width="55" height="55" rx="6" fill="#B8D4A8" opacity="0.7" />

      {/* Route line */}
      <path d={path} fill="none" stroke="#1565C0" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity="0.25" />
      <path d={path} fill="none" stroke="#1565C0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="10 6" />
      {/* Stops */}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p[0]} cy={p[1]} r="7" fill="#fff" stroke="#1565C0" strokeWidth="2" />
          <circle cx={p[0]} cy={p[1]} r="3" fill={i === 3 ? C.live : "#1565C0"} />
        </g>
      ))}

      {/* Student location is shown only after the browser provides a real position. */}
      {position && (
        <g aria-label="Your current location">
          <circle cx="200" cy="195" r="16" fill="rgba(21,101,192,0.18)" />
          <circle cx="200" cy="195" r="8" fill="#fff" stroke="#1565C0" strokeWidth="2" />
          <circle cx="200" cy="195" r="3.5" fill="#1565C0" />
        </g>
      )}

      {!position && !available && <text x="195" y="245" textAnchor="middle" fill="#4A5568" fontSize="10" fontFamily="Inter">Location unavailable</text>}
    </svg>
  );
}

function MapView({ height = 280 }: { animateBus?: boolean; height?: number }) {
  return (
    <iframe
      title="Google Map of Rajalakshmi Institute of Technology"
      src="https://www.google.com/maps?q=Rajalakshmi%20Institute%20of%20Technology%2C%20Chennai&output=embed&z=15"
      width="100%"
      height={height}
      style={{ display: "block", border: 0 }}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}

// Free, no-API-key map that plots real checkpoints (route stops) and the live
// bus position using MapLibre GL JS with OpenFreeMap vector tiles.
function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function bearingDegrees(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const λ1 = a.lng * Math.PI / 180, λ2 = b.lng * Math.PI / 180;
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function validCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const stopColor = (state: "done" | "current" | "upcoming") =>
  state === "current" ? "#2ECC71" : state === "done" ? "#9AA5AE" : "#1565C0";

function BusMarkerIcon({ heading }: { heading: number }) {
  return (
    <div
      title="Bus Location"
      style={{
        position: "relative",
        zIndex: 20,
        filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.35))",
      }}
    >
      <svg width="40" height="40" viewBox="0 0 40 40" style={{ display: "block" }}>
        {/* Soft pulse/glow outer ring */}
        <circle cx="20" cy="20" r="19" fill="#1565C0" fillOpacity="0.22" />
        {/* Main circular body */}
        <circle cx="20" cy="20" r="15.5" fill="#1565C0" stroke="#FFFFFF" strokeWidth="2.5" />
        {/* Centered Bus Icon */}
        <g transform="translate(10, 10) scale(0.8333)">
          <path
            d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"
            fill="#FFFFFF"
          />
        </g>
      </svg>
    </div>
  );
}

// Stop status is based on the bus crossing the ordered checkpoint.
// It is NOT based on the nearest stop and there is no arrival-radius shortcut.
// The route is treated as an ordered chain of checkpoints. The bus is projected
// onto that chain and a stop becomes "done" only after the projected position
// has moved beyond that checkpoint.
function getOrderedRouteProgress(
  stops: FireRouteStop[],
  busPosition: { lat: number; lng: number } | null,
): number | null {
  if (!busPosition) return null;

  const plotted = stops
    .map((stop, originalIndex) => ({ stop, originalIndex }))
    .filter(({ stop }) => validCoordinate(stop.lat) && validCoordinate(stop.lng));

  if (plotted.length < 2) return null;

  const latScale = 111320;
  const lngScale = 111320 * Math.cos(busPosition.lat * Math.PI / 180);

  // Build the route using real metre lengths, rather than treating every
  // stop-to-stop section as the same length.
  const cumulative: number[] = [0];
  for (let i = 1; i < plotted.length; i++) {
    const a = plotted[i - 1].stop;
    const b = plotted[i].stop;
    const dx = (b.lng! - a.lng!) * lngScale;
    const dy = (b.lat! - a.lat!) * latScale;
    cumulative[i] = cumulative[i - 1] + Math.hypot(dx, dy);
  }

  const totalLength = cumulative[cumulative.length - 1];
  if (totalLength <= 0) return 0;

  // Project the live GPS point onto the closest ordered route segment.
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRouteDistance = 0;

  for (let i = 0; i < plotted.length - 1; i++) {
    const a = plotted[i].stop;
    const b = plotted[i + 1].stop;

    const ax = (a.lng! - busPosition.lng) * lngScale;
    const ay = (a.lat! - busPosition.lat) * latScale;
    const bx = (b.lng! - busPosition.lng) * lngScale;
    const by = (b.lat! - busPosition.lat) * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
      : 0;

    const px = ax + dx * t;
    const py = ay + dy * t;
    const distanceFromRoute = Math.hypot(px, py);
    const segmentLength = Math.sqrt(len2);

    if (distanceFromRoute < bestDistance) {
      bestDistance = distanceFromRoute;
      bestRouteDistance = cumulative[i] + segmentLength * t;
    }
  }

  // If the bus is beyond the final checkpoint, complete the whole route.
  const last = plotted[plotted.length - 1].stop;
  const previous = plotted[plotted.length - 2].stop;
  const vx = (last.lng! - previous.lng!) * lngScale;
  const vy = (last.lat! - previous.lat!) * latScale;
  const wx = (busPosition.lng - previous.lng!) * lngScale;
  const wy = (busPosition.lat - previous.lat!) * latScale;
  const finalLen2 = vx * vx + vy * vy;

  if (finalLen2 > 0 && wx * vx + wy * vy >= finalLen2) {
    bestRouteDistance = totalLength;
  }

  return Math.max(0, Math.min(totalLength, bestRouteDistance));
}

function withLiveStopStates(
  stops: FireRouteStop[],
  busPosition: { lat: number; lng: number } | null,
): FireRouteStop[] {
  if (!busPosition) return stops;

  const plotted = stops
    .map((stop, originalIndex) => ({ stop, originalIndex }))
    .filter(({ stop }) => validCoordinate(stop.lat) && validCoordinate(stop.lng));

  // Without coordinates there is no safe way to decide whether a checkpoint
  // has actually been crossed. Keep the admin order instead of guessing.
  if (plotted.length < 2) return stops;

  const progressMeters = getOrderedRouteProgress(stops, busPosition);
  if (progressMeters == null) return stops;

  const cumulative: number[] = [0];
  for (let i = 1; i < plotted.length; i++) {
    cumulative[i] = cumulative[i - 1] + distanceMeters(
      { lat: plotted[i - 1].stop.lat!, lng: plotted[i - 1].stop.lng! },
      { lat: plotted[i].stop.lat!, lng: plotted[i].stop.lng! },
    );
  }

  // A checkpoint is considered passed only once the bus has crossed its
  // ordered route position. No 150 m "nearby" rule is used.
  const EPSILON_METERS = 0.5;
  const passedPlottedCount = cumulative.filter(
    checkpointDistance => progressMeters > checkpointDistance + EPSILON_METERS,
  ).length;

  const plottedIndexByOriginalIndex = new Map<number, number>();
  plotted.forEach(({ originalIndex }, index) => {
    plottedIndexByOriginalIndex.set(originalIndex, index);
  });

  let currentAssigned = false;

  return stops.map((stop, originalIndex) => {
    const plottedIndex = plottedIndexByOriginalIndex.get(originalIndex);

    if (plottedIndex == null) {
      return { ...stop, state: stop.state ?? "upcoming" };
    }

    if (plottedIndex < passedPlottedCount) {
      return { ...stop, state: "done" };
    }

    if (!currentAssigned) {
      currentAssigned = true;
      return { ...stop, state: "current" };
    }

    return { ...stop, state: "upcoming" };
  });
}


type SharedStudentLocation = {
  id: string;
  lat: number;
  lng: number;
  studentName?: string;
  studentEmail?: string;
};

function RouteOverlay({ path, remainingPath }: { path: [number, number][]; remainingPath: [number, number][] }) {
  const { current: map } = useMap();
  const [screenPoints, setScreenPoints] = useState("");

  useEffect(() => {
    if (!map || path.length < 2) {
      setScreenPoints("");
      return;
    }

    const update = () => {
      setScreenPoints(path.map(([lat, lng]) => {
        const point = map.project({ lat, lng });
        return `${point.x},${point.y}`;
      }).join(" "));
    };

    update();
    map.on("move", update);
    map.on("resize", update);
    return () => {
      map.off("move", update);
      map.off("resize", update);
    };
  }, [map, path]);

  const remainingScreenPoints = remainingPath.map(([lat, lng]) => {
    const point = map?.project({ lat, lng });
    return point ? `${point.x},${point.y}` : "";
  }).filter(Boolean).join(" ");

  if (!screenPoints) return null;
  return (
    <svg aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}>
      <polyline points={screenPoints} fill="none" stroke="#fff" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
      {remainingScreenPoints && <polyline points={remainingScreenPoints} fill="none" stroke="#1565C0" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function RouteMapView({
  stops,
  busPosition,
  studentLocations = [],
  height = 280,
}: {
  stops: FireRouteStop[];
  busPosition?: { lat: number; lng: number } | null;
  studentLocations?: SharedStudentLocation[];
  height?: number;
}) {
  const [mapError, setMapError] = useState(false);
  const plotted = stops.filter(s => validCoordinate(s.lat) && validCoordinate(s.lng));
  const routeKey = plotted.map(s => `${s.lat},${s.lng}`).join(";");
  const [routePath, setRoutePath] = useState<[number, number][]>([]);
  const prevPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const [heading, setHeading] = useState(0);

  useEffect(() => {
    if (busPosition && prevPositionRef.current) {
      const d = distanceMeters(prevPositionRef.current, busPosition);
      if (d > 3) setHeading(bearingDegrees(prevPositionRef.current, busPosition));
    }
    if (busPosition) prevPositionRef.current = busPosition;
  }, [busPosition?.lat, busPosition?.lng]);

  const midStop = plotted[Math.floor(plotted.length / 2)];
  const center = busPosition ?? (midStop ? { lat: midStop.lat!, lng: midStop.lng! } : { lat: 13.0072, lng: 79.6 });
  const displayRoutePath = routePath.length > 1
    ? routePath
    : plotted.map(stop => [stop.lat!, stop.lng!] as [number, number]);

  if (mapError) {
    return <MapView height={height} />;
  }

  let nearestRouteIndex = -1;
  if (busPosition && displayRoutePath.length) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    displayRoutePath.forEach(([lat, lng], index) => {
      const distance = distanceMeters(busPosition, { lat, lng });
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestRouteIndex = index;
      }
    });
  }
  const remainingRoute = busPosition
    ? (nearestRouteIndex >= 0 ? displayRoutePath.slice(nearestRouteIndex) : [])
    : displayRoutePath;

  useEffect(() => {
    if (plotted.length < 2) {
      setRoutePath([]);
      return;
    }

    const controller = new AbortController();
    const coordinates = plotted.map(s => `${s.lng},${s.lat}`).join(";");

    fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`, {
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error(`Routing request failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        const coordinates = data.routes?.[0]?.geometry?.coordinates;
        if (!Array.isArray(coordinates)) throw new Error("No road route returned");
        setRoutePath(coordinates.map(([lng, lat]: [number, number]) => [lat, lng]));
      })
      .catch(error => {
        if (error.name !== "AbortError") {
          console.error("Unable to load road route", error);
          setRoutePath([]);
        }
      });

    return () => controller.abort();
  }, [routeKey]);

  if (!plotted.length && !busPosition) {
    return (
      <div style={{ width: "100%", height, display: "flex", alignItems: "center", justifyContent: "center", background: "#ECF0E8", color: C.sub, fontFamily: "Inter,sans-serif", fontSize: 12 }}>
        No stop locations yet
      </div>
    );
  }

  const fullLineGeoJson = {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: displayRoutePath.map(([lat, lng]) => [lng, lat]) },
  };
  return (
    <MapLibreMap
      initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: 12 }}
      style={{ width: "100%", height }}
      mapStyle={MAP_STYLE}
      scrollZoom={false}
      onLoad={event => {
        const points = [
          ...plotted.map(stop => [stop.lng!, stop.lat!] as [number, number]),
          ...(busPosition ? [[busPosition.lng, busPosition.lat] as [number, number]] : []),
        ];
        if (points.length > 1) {
          const longitudes = points.map(([longitude]) => longitude);
          const latitudes = points.map(([, latitude]) => latitude);
          event.target.fitBounds(
            [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
            { padding: 90, maxZoom: 14, duration: 0 },
          );
        }
      }}
      onError={() => setMapError(true)}
    >
      <RouteOverlay path={displayRoutePath} remainingPath={remainingRoute} />
      {displayRoutePath.length > 1 && (
        <Source id="route-line" type="geojson" data={fullLineGeoJson}>
          <Layer
            id="route-line-casing"
            type="line"
            paint={{ "line-color": "#FFFFFF", "line-width": 13, "line-opacity": 0.95 }}
            layout={{ "line-cap": "round", "line-join": "round" }}
          />
          <Layer
            id="route-line-blue"
            type="line"
            paint={{ "line-color": "#1565C0", "line-width": 9, "line-opacity": 1 }}
            layout={{ "line-cap": "round", "line-join": "round" }}
          />
        </Source>
      )}
      {plotted.map((s, i) => (
        <MapLibreMarker key={i} longitude={s.lng!} latitude={s.lat!} style={{ zIndex: 10 }}>
          <div
            title={s.name}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              pointerEvents: "none",
            }}
          >
            <div style={{
              maxWidth: 150,
              padding: "5px 8px",
              borderRadius: 7,
              background: C.surface,
              border: `1px solid ${C.border}`,
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
              color: s.state === "done" ? C.muted : C.text,
              fontFamily: "Inter,sans-serif",
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1.15,
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              textDecoration: s.state === "done" ? "line-through" : "none",
            }}>
              {i + 1}. {s.name}
            </div>
            <div style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: stopColor(s.state),
              border: "2px solid #fff",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.25)",
            }} />
          </div>
        </MapLibreMarker>
      ))}
      {busPosition && (
        <MapLibreMarker longitude={busPosition.lng} latitude={busPosition.lat} style={{ zIndex: 20 }}>
          <BusMarkerIcon heading={heading} />
        </MapLibreMarker>
      )}
      {studentLocations.map(student => (
        <MapLibreMarker key={student.id} longitude={student.lng} latitude={student.lat}>
          <div
            title={student.studentName || "Student"}
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "#E53935",
              border: "3px solid #fff",
              boxShadow: "0 0 0 2px rgba(229,57,53,0.25)",
            }}
          />
        </MapLibreMarker>
      ))}
    </MapLibreMap>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SCREENS
// ══════════════════════════════════════════════════════════════════════════════

// 1 ─ Splash
function SplashScreen({ onDone }: { onDone: () => void }) {
  const [show, setShow] = useState(false);
  const [out, setOut] = useState(false);

  useEffect(() => {
    const t0 = setTimeout(() => setShow(true), 100);
    const t1 = setTimeout(() => setOut(true), 3000);
    const t2 = setTimeout(onDone, 3500);
    return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  return (
    <div style={{ position: "absolute", inset: 0, background: C.navy, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", opacity: out ? 0 : 1, transition: "opacity 0.5s ease" }}>
      {/* Subtle route lines in bg */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.07 }} preserveAspectRatio="none">
        <path d="M0 300 Q130 250 260 310 T390 280" stroke="#fff" strokeWidth="2" fill="none" strokeDasharray="12 8" />
        <path d="M0 500 Q160 440 290 510 T390 470" stroke="#fff" strokeWidth="1.5" fill="none" strokeDasharray="8 10" />
        <path d="M0 680 Q120 620 250 675 T390 640" stroke="#fff" strokeWidth="1" fill="none" strokeDasharray="6 12" />
      </svg>

      {/* Logo */}
      <div style={{ opacity: show ? 1 : 0, transform: show ? "scale(1)" : "scale(0.82)", transition: "opacity 0.6s ease, transform 0.6s cubic-bezier(0.34,1.56,0.64,1)" }}>
        <div style={{ background: "#fff", borderRadius: 14, padding: 0, lineHeight: 0, boxShadow: "0 8px 32px rgba(0,0,0,0.35)" }}>
          <img src={ritLogo} alt="RIT" style={{ width: 240, height: "auto", display: "block", borderRadius: 14 }} />
        </div>
      </div>

      {/* Text */}
      <div style={{ marginTop: 32, textAlign: "center", opacity: show ? 1 : 0, transform: show ? "translateY(0)" : "translateY(12px)", transition: "opacity 0.5s 0.25s ease, transform 0.5s 0.25s ease" }}>
        <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 26, color: "#fff", letterSpacing: "-0.3px" }}>RIT BusTrack</div>
        <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: "rgba(255,255,255,0.5)", marginTop: 6, letterSpacing: "0.8px" }}>TRACK • PLAN • REACH ON TIME</div>
      </div>

      {/* Loader */}
      <div style={{ position: "absolute", bottom: 52, display: "flex", gap: 6, opacity: show ? 1 : 0, transition: "opacity 0.4s 0.5s" }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: "rgba(255,255,255,0.5)", animation: `splashDot 0.9s ${i * 0.18}s ease-in-out infinite` }} />
        ))}
      </div>
    </div>
  );
}

// 2 ─ Login
function LoginScreen({
  authError,
  onClearAuthError,
}: {
  authError?: string;
  onClearAuthError?: () => void;
}) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(authError || "");
  const [resetMsg, setResetMsg] = useState("");

  useEffect(() => {
    if (authError) {
      setError(authError);
      setLoading(false);
    }
  }, [authError]);

  function switchMode(signUp: boolean) {
    setIsSignUp(signUp);
    setError("");
    setResetMsg("");
    onClearAuthError?.();
  }

  async function submit() {
    if (isSignUp) {
      if (!name.trim()) {
        setError("Please enter your full name.");
        return;
      }
      if (!email.trim() || !pw || !confirmPw) {
        setError("Please fill in all fields to register.");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError("Enter a valid college email address.");
        return;
      }
      if (pw.length < 6) {
        setError("Password must be at least 6 characters long.");
        return;
      }
      if (pw !== confirmPw) {
        setError("Passwords do not match.");
        return;
      }

      setError("");
      setResetMsg("");
      setLoading(true);
      onClearAuthError?.();

      try {
        const cleanEmail = email.trim().toLowerCase();
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, pw);
        try {
          await updateProfile(cred.user, { displayName: name.trim() });
        } catch { }
        await createUserProfile(cred.user.uid, {
          email: cleanEmail,
          name: name.trim(),
          role: "student",
        });
        // onAuthStateChanged in App will immediately detect this user and route to student-home
      } catch (err: any) {
        console.error("Firebase sign up error:", err);
        const code = err?.code || "";
        if (code === "auth/email-already-in-use") {
          setError("An account with this email already exists. Please sign in.");
        } else if (code === "auth/weak-password") {
          setError("Password must be at least 6 characters.");
        } else if (code === "auth/invalid-email") {
          setError("Enter a valid college email address.");
        } else if (code === "auth/network-request-failed") {
          setError("Network error. Please check your internet connection.");
        } else {
          setError(err?.message || "Registration failed. Please try again.");
        }
        setLoading(false);
      }
      return;
    }

    // Sign in mode
    if (!email.trim() || !pw) {
      setError("Enter your college email and password to continue.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid college email address.");
      return;
    }
    setError("");
    setResetMsg("");
    setLoading(true);
    onClearAuthError?.();

    try {
      await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), pw);
      // onAuthStateChanged in App will fetch verified profile from users/{uid} and route to dashboard
    } catch (err: any) {
      console.error("Firebase sign in error:", err);
      const code = err?.code || "";
      if (code === "auth/invalid-credential") {
        setError("Incorrect email or password. Please try again.");
      } else if (code === "auth/wrong-password") {
        setError("Incorrect password. Please try again.");
      } else if (code === "auth/user-not-found") {
        setError("No account found with this email.");
      } else if (code === "auth/invalid-email") {
        setError("Enter a valid college email address.");
      } else if (code === "auth/user-disabled") {
        setError("This account has been disabled. Please contact an administrator.");
      } else if (code === "auth/too-many-requests") {
        setError("Too many failed attempts. Please try again in a few minutes.");
      } else if (code === "auth/network-request-failed") {
        setError("Network error. Please check your internet connection.");
      } else {
        setError(err?.message || "Sign in failed. Please try again.");
      }
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter your registered college email above to receive a reset link.");
      return;
    }
    setError("");
    setResetMsg("");
    try {
      await sendPasswordResetEmail(auth, email.trim().toLowerCase());
      setResetMsg("Password reset link sent to your registered email.");
    } catch (err: any) {
      console.error("Password reset error:", err);
      const code = err?.code || "";
      if (code === "auth/user-not-found") {
        setError("No account found with this email.");
      } else if (code === "auth/invalid-email") {
        setError("Enter a valid college email address.");
      } else if (code === "auth/network-request-failed") {
        setError("Network error. Please check your internet connection.");
      } else {
        setError(err?.message || "Could not send password reset link.");
      }
    }
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: C.surface, display: "flex", flexDirection: "column" }}>
      <StatusBar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "24px 28px 32px", overflowY: "auto" }}>
        {/* Logo small & Segmented Tabs */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ background: "#fff", borderRadius: 10, lineHeight: 0, border: `1px solid ${C.border}`, alignSelf: "flex-start" }}>
            <img src={ritLogo} alt="RIT" style={{ width: 110, height: "auto", display: "block", borderRadius: 10 }} />
          </div>
          <div style={{ display: "flex", background: C.bg, borderRadius: 12, padding: 3, border: `1px solid ${C.border}` }}>
            <button
              type="button"
              onClick={() => switchMode(false)}
              style={{
                padding: "6px 14px",
                borderRadius: 9,
                border: "none",
                background: !isSignUp ? C.surface : "transparent",
                color: !isSignUp ? C.text : C.muted,
                fontFamily: "Outfit,sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
                boxShadow: !isSignUp ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                transition: "all 0.2s ease",
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => switchMode(true)}
              style={{
                padding: "6px 14px",
                borderRadius: 9,
                border: "none",
                background: isSignUp ? C.surface : "transparent",
                color: isSignUp ? C.text : C.muted,
                fontFamily: "Outfit,sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
                boxShadow: isSignUp ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                transition: "all 0.2s ease",
              }}
            >
              Sign Up
            </button>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", paddingTop: 10, paddingBottom: 16 }}>
          <h1 style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 28, color: C.text, margin: 0, letterSpacing: "-0.5px" }}>
            {isSignUp ? "Create Student Account" : "Welcome back"}
          </h1>
          <p style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: C.sub, margin: "6px 0 24px" }}>
            {isSignUp
              ? "Register with your college email to track college buses."
              : "Sign in to track your college bus in real time."}
          </p>

          {isSignUp && (
            <InputField
              label="Full name"
              placeholder="e.g. Yokesh Kumar"
              value={name}
              onChange={(v) => {
                setName(v);
                if (error) setError("");
              }}
            />
          )}

          <InputField
            label="College email"
            placeholder="name@ritchennai.edu.in"
            type="email"
            value={email}
            onChange={(v) => {
              setEmail(v);
              if (error) setError("");
              if (authError) onClearAuthError?.();
            }}
          />

          <InputField
            label="Password"
            placeholder={isSignUp ? "Create password (min 6 chars)" : "Enter your password"}
            type={showPw ? "text" : "password"}
            value={pw}
            onChange={(v) => {
              setPw(v);
              if (error) setError("");
              if (authError) onClearAuthError?.();
            }}
            suffix={
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, display: "flex" }}
              >
                {Ic.eye}
              </button>
            }
          />

          {isSignUp && (
            <InputField
              label="Confirm password"
              placeholder="Re-enter password"
              type={showPw ? "text" : "password"}
              value={confirmPw}
              onChange={(v) => {
                setConfirmPw(v);
                if (error) setError("");
              }}
            />
          )}

          <button
            onClick={submit}
            disabled={loading}
            style={{
              width: "100%",
              height: 50,
              borderRadius: 12,
              background: loading ? C.blueMid : C.blue,
              color: "#fff",
              border: "none",
              fontFamily: "Outfit,sans-serif",
              fontWeight: 700,
              fontSize: 16,
              cursor: loading ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              marginTop: 6,
              marginBottom: 16,
            }}
          >
            {loading ? (
              <div
                style={{
                  width: 18,
                  height: 18,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            ) : (
              isSignUp ? "Create Account" : "Sign In"
            )}
          </button>

          {error && (
            <div
              role="alert"
              style={{ color: "#C62828", fontSize: 13, marginBottom: 12, textAlign: "center" }}
            >
              {error}
            </div>
          )}
          {resetMsg && (
            <div
              style={{ color: C.live, fontSize: 13, marginBottom: 12, textAlign: "center", fontWeight: 500 }}
            >
              {resetMsg}
            </div>
          )}

          {!isSignUp ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  style={{
                    background: "none",
                    border: "none",
                    color: C.blue,
                    fontFamily: "Inter,sans-serif",
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: "pointer",
                    padding: "2px 0",
                  }}
                >
                  Forgot password?
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "2px 0" }}>
                <div style={{ flex: 1, height: 1, background: C.border }} />
                <span style={{ fontSize: 12, color: C.muted, fontFamily: "Inter,sans-serif", fontWeight: 500 }}>or</span>
                <div style={{ flex: 1, height: 1, background: C.border }} />
              </div>

              <button
                type="button"
                onClick={() => switchMode(true)}
                style={{
                  width: "100%",
                  height: 48,
                  borderRadius: 12,
                  background: "transparent",
                  border: `1.5px solid ${C.blue}`,
                  color: C.blue,
                  fontFamily: "Outfit,sans-serif",
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  transition: "all 0.2s ease",
                }}
              >
                New student? Sign up
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "2px 0" }}>
                <div style={{ flex: 1, height: 1, background: C.border }} />
                <span style={{ fontSize: 12, color: C.muted, fontFamily: "Inter,sans-serif", fontWeight: 500 }}>or</span>
                <div style={{ flex: 1, height: 1, background: C.border }} />
              </div>

              <button
                type="button"
                onClick={() => switchMode(false)}
                style={{
                  width: "100%",
                  height: 48,
                  borderRadius: 12,
                  background: "transparent",
                  border: `1.5px solid ${C.blue}`,
                  color: C.blue,
                  fontFamily: "Outfit,sans-serif",
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  transition: "all 0.2s ease",
                }}
              >
                Already have an account? Sign in
              </button>
            </div>
          )}
        </div>

        <div style={{ textAlign: "center", borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 13, color: C.sub }}>RIT BusTrack</div>
          <div style={{ fontFamily: "Inter,sans-serif", fontSize: 11, color: C.muted, marginTop: 2 }}>Rajalakshmi Institute of Technology</div>
        </div>
      </div>
    </div>
  );
}

// 3 ─ Student Home
// 3 - Student Home
function StudentHome({
  onNav,
  user,
  buses,
  stopsByRoute,
  onSelectBus,
}: {
  onNav: (s: Screen) => void;
  user: UserProfile;
  buses: FireBus[];
  stopsByRoute: Record<string, FireRouteStop[]>;
  onSelectBus: (id: string) => void;
}) {
  // Do not automatically select the first bus. Restore only a bus that the
  // student explicitly selected previously.
  const [selectedId, setSelectedId] = useState<string>(() => {
    try {
      return sessionStorage.getItem("selectedBusId") ?? "";
    } catch {
      return "";
    }
  });
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    // If the previously selected bus was deleted/unavailable, clear the
    // selection instead of silently selecting the first bus.
    if (selectedId && buses.length && !buses.some(b => b.id === selectedId)) {
      setSelectedId("");
      onSelectBus("");
      try { sessionStorage.removeItem("selectedBusId"); } catch { }
    }
  }, [buses, selectedId, onSelectBus]);

  const selectedBus = buses.find(b => b.id === selectedId);

  async function shareLocation() {
    if (!selectedBus) {
      window.alert("Please select a bus first.");
      return;
    }
    if (!navigator.geolocation) {
      window.alert("Location is not supported on this device/browser.");
      return;
    }

    setSharing(true);
    navigator.geolocation.getCurrentPosition(
      async position => {
        const request = {
          loc: "Student current location",
          route: selectedBus.r,
          count: 1,
          reason: "Student shared live pickup location with the assigned driver.",
          kind: "student-location",
          locationShared: true,
          studentEmail: user.email,
          studentName: user.name,
          targetDriverEmail: selectedBus.driverEmail ?? "",
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          createdAt: Date.now(),
        } as unknown as FireStopRequest;

        try {
          if (!selectedBus.driverEmail) {
            window.alert("This bus has no driver assigned yet. Ask the admin to assign the driver's email to this bus.");
            setSharing(false);
            return;
          }

          await addStopRequest(request);
          setShared(true);
          setTimeout(() => setShared(false), 4000);
        } catch (error) {
          console.error("Unable to share student location", error);
          window.alert("Could not share location. Please try again.");
        } finally {
          setSharing(false);
        }
      },
      error => {
        console.error(error);
        setSharing(false);
        window.alert("Please allow location access and try again.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }

  function openBus(bus: FireBus) {
    setSelectedId(bus.id);
    onSelectBus(bus.id);
    sessionStorage.setItem("selectedBusId", bus.id);
    onNav("bus-details");
  }

  const { theme, toggleTheme } = useTheme();

  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <div style={{ padding: "4px 20px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub, marginBottom: 5 }}>Good morning 👋</div>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 23, color: C.text }}>{user.name || "RIT Student"}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button aria-label="Toggle theme" title="Toggle dark mode" onClick={toggleTheme} style={{ width: 42, height: 42, borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              {theme === "dark" ? Ic.sun : Ic.moon}
            </button>
            <button onClick={() => onNav("notifications")} style={{ width: 42, height: 42, borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", position: "relative" }}>
              {Ic.bell}
              <span style={{ position: "absolute", top: 8, right: 8, width: 7, height: 7, borderRadius: "50%", background: "#E53935", border: "2px solid #fff" }} />
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 105px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: C.liveBg, color: C.live, borderRadius: 20, padding: "6px 12px", fontSize: 12, fontWeight: 700, marginBottom: 18 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.live, display: "inline-block", animation: "livePulse 1.4s ease-in-out infinite" }} />
          Transport service active
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: "0.9px" }}>YOUR BUSES</div>
          <div style={{ fontSize: 11, color: C.muted }}>{buses.length} available</div>
        </div>

        {buses.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, textAlign: "center", color: C.sub, marginBottom: 18 }}>
            No buses available right now.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {buses.map((bus, index) => {
              const isSelected = bus.id === selectedBus?.id;
              const stops = stopsByRoute[bus.r] ?? [];
              const nextStop = stops.find(s => s.state === "current") ?? stops.find(s => s.state === "upcoming");
              return (
                <button key={bus.id} onClick={() => openBus(bus)} style={{ width: "100%", background: isSelected ? C.blueSubtle : C.surface, border: `1.5px solid ${isSelected ? C.blue : C.border}`, borderRadius: 18, padding: 16, textAlign: "left", cursor: "pointer", boxShadow: "0 4px 14px rgba(13,27,42,0.05)", animation: `fadeUp 0.3s ${index * 0.05}s both` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 13, background: C.blue, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21 }}>🚌</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontFamily: "Outfit,sans-serif", fontSize: 17, fontWeight: 800, color: C.text }}>{bus.n || bus.r || "Bus"}</span>
                        {bus.live && <LiveBadge small />}
                      </div>
                      <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{bus.routeName || bus.r}</div>
                    </div>
                    <span style={{ fontSize: 25, color: C.muted }}>›</span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                    <div style={{ background: C.bg, borderRadius: 10, padding: "9px 11px" }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>NEXT STOP</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nextStop?.name ?? "Route available"}</div>
                    </div>
                    <div style={{ background: C.bg, borderRadius: 10, padding: "9px 11px" }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>ETA</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{bus.eta > 0 ? `${bus.eta} min` : "—"}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}


        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: "0.9px", marginBottom: 10 }}>QUICK ACTIONS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[
              { label: "Live Map", icon: "🗺️", to: "live-map" as Screen },
              { label: "Find My Bus", icon: "🔎", to: "find-bus" as Screen },
              { label: "Route Stops", icon: "🛣️", to: "route-stops" as Screen },
              { label: "My Trips", icon: "🎫", to: "my-trips" as Screen },
            ].map(action => (
              <button key={action.label} onClick={() => onNav(action.to)} style={{ minHeight: 76, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: "13px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left" }}>
                <span style={{ fontSize: 22 }}>{action.icon}</span>
                <span style={{ fontFamily: "Inter,sans-serif", fontWeight: 700, fontSize: 13, color: C.text }}>{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <BottomNav active="student-home" onNav={onNav} />
    </div>
  );
}

// 4 ─ Live Map (hero screen)
function LiveMapScreen({ onNav, buses, stopsByRoute, selectedBus }: { onNav: (s: Screen) => void; buses: FireBus[]; stopsByRoute: Record<string, FireRouteStop[]>; selectedBus?: FireBus }) {
  const bus = selectedBus ?? buses[0] ?? EMPTY_BUS;
  const busPosition = validCoordinate(bus.lat) && validCoordinate(bus.lng) ? { lat: bus.lat!, lng: bus.lng! } : null;
  const tripDirection = getTripDirection(bus);
  const stops = withLiveStopStates(getDirectionalStops(stopsByRoute[bus.r] ?? [], bus), busPosition);
  const nextStop = stops.find(s => s.state === "current") ?? stops.find(s => s.state === "upcoming") ?? stops[0];
  const etaMinutes = useRealEta(busPosition, nextStop);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: C.bg }}>
      {/* Floating top bar — starts at top:0, StatusBar handles notch clearance internally */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 1000, padding: "0 14px 0" }}>
        <StatusBar dark />
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button aria-label="Back to home" title="Back to home" onClick={() => onNav("student-home")} style={{ height: 40, padding: "0 12px", borderRadius: 10, background: C.surface, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 6, color: C.text, fontFamily: "Inter,sans-serif", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.18)" }}>
            {Ic.back}
            <span>Back</span>
          </button>
          <div style={{ flex: 1, height: 40, borderRadius: 10, background: C.surface, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
            <span style={{ color: C.muted }}>{Ic.search}</span>
            <span style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: C.muted }}>Search stops or routes</span>
          </div>
        </div>
      </div>

      {/* Map fills full phone height; bottom sheet overlays on top */}
      <div style={{ position: "absolute", inset: 0 }}>
        <RouteMapView stops={stops} busPosition={busPosition} height={window.innerHeight} />
      </div>

      {/* Map controls */}
      <div style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 6, zIndex: 10 }}>
        {["+", "−"].map(c => (
          <button key={c} style={{ width: 36, height: 36, borderRadius: 9, background: C.surface, border: `1px solid ${C.border}`, fontWeight: 700, fontSize: 18, color: C.text, cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>{c}</button>
        ))}
        <button style={{ width: 36, height: 36, borderRadius: 9, background: C.blue, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>{Ic.pin}</button>
      </div>

      {/* Bottom sheet */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1200, background: C.surface, borderRadius: "24px 24px 0 0", boxShadow: "0 -4px 24px rgba(0,0,0,0.10)", animation: "slideUp 0.3s ease" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: C.border, margin: "12px auto 0" }} />
        <div style={{ padding: "12px 20px 32px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 13 }}>{bus.r}</div>
                <div>
                  <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, color: C.text }}>{bus.r}</div>
                  <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub }}>
                    {getDirectionalRouteName(bus.routeName, tripDirection)}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {tripDirection === "return" && (
                <span style={{ fontSize: 10, fontWeight: 800, color: C.warn, background: C.warnBg, borderRadius: 20, padding: "3px 8px" }}>RETURN</span>
              )}
              {bus.live ? <LiveBadge /> : <span style={{ fontSize: 11, color: C.muted, fontFamily: "Inter,sans-serif" }}>Offline</span>}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
            {[{ l: "Next Stop", v: nextStop?.name ?? "—" }, { l: "ETA", v: etaMinutes != null ? `${etaMinutes} min` : "—" }, { l: "Distance", v: bus.dist }].map(s => (
              <div key={s.l} style={{ background: C.bg, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: C.muted, fontFamily: "Inter,sans-serif", marginBottom: 3 }}>{s.l}</div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.text }}>{s.v}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => onNav("route-stops")} style={{ flex: 1, height: 44, borderRadius: 10, border: `1.5px solid ${C.blue}`, background: "transparent", color: C.blue, fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>View Route</button>
            <button onClick={() => onNav("bus-details")} style={{ flex: 1, height: 44, borderRadius: 10, border: "none", background: C.blue, color: "#fff", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Bus Details</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 5 ─ Bus Details
function BusDetailsScreen({ onNav, selectedBus, stopsByRoute }: { onNav: (s: Screen) => void; selectedBus?: FireBus; stopsByRoute: Record<string, FireRouteStop[]> }) {
  const bus = selectedBus ?? EMPTY_BUS;
  const statusText = bus.live ? "LIVE" : "OFFLINE";
  const busPosition = bus.lat != null && bus.lng != null ? { lat: bus.lat, lng: bus.lng } : null;
  const routeStops = stopsByRoute[bus.r];
  const tripDirection = getTripDirection(bus);
  const stops = withLiveStopStates(
    getDirectionalStops(routeStops?.length ? routeStops : FALLBACK_STOPS, bus),
    busPosition
  );

  // Hide "Pickup Here" once the bus has already gone past the student's
  // current location, so students can't request a pickup that's no longer
  // possible. We find the stop nearest to the student's own GPS position
  // and check whether that stop's live state is already "done".
  const { position: myPosition } = useGeolocation();
  const myLoc = myPosition
    ? { lat: myPosition.coords.latitude, lng: myPosition.coords.longitude }
    : null;
  const busHasPassedMe = (() => {
    if (!myLoc) return false;
    const plotted = stops.filter(
      (s): s is FireRouteStop & { lat: number; lng: number } =>
        typeof s.lat === "number" && typeof s.lng === "number"
    );
    if (!plotted.length) return false;
    let nearest = plotted[0];
    let nearestDist = distanceMeters(myLoc, nearest);
    for (const s of plotted.slice(1)) {
      const d = distanceMeters(myLoc, s);
      if (d < nearestDist) { nearestDist = d; nearest = s; }
    }
    return nearest.state === "done";
  })();

  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <TopBar title="Bus Details" onBack={() => onNav("student-home")} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 18, padding: 20, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 50, height: 50, borderRadius: 13, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 20 }}>🚌</div>
              <div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 20, color: C.text }}>{bus.n || "Bus"}</div>
                <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginTop: 3 }}>
                  {getDirectionalRouteName(bus.routeName || bus.r, tripDirection)}
                </div>
              </div>
            </div>
            {bus.live ? <LiveBadge /> : <span style={{ fontSize: 11, fontWeight: 700, color: C.muted }}>{statusText}</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[{ l: "ETA", v: bus.eta > 0 ? `${bus.eta} min` : "—" }, { l: "Distance", v: bus.dist || "—" }, { l: "Stops", v: String(bus.stops ?? 0) }].map(s => (
              <div key={s.l} style={{ background: C.bg, borderRadius: 11, padding: "10px 11px" }}>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{s.l}</div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.text }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: "transparent", marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { l: "Route", v: bus.routeName || bus.r || "—" },
            { l: "Driver", v: bus.driverEmail || "Assigned driver" },
            { l: "Current location", v: bus.lat != null && bus.lng != null ? "GPS location available" : "GPS unavailable" },
          ].map((r, i, arr) => (
            <div key={r.l} style={{ display: "flex", justifyContent: "space-between", gap: 14, padding: "14px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ fontSize: 13, color: C.sub }}>{r.l}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text, textAlign: "right", maxWidth: "62%" }}>{r.v}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <GhostBtn label="View Full Route" onClick={() => onNav("route-stops")} />
          {busHasPassedMe ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, background: C.bg, border: `1px solid ${C.border}`, fontFamily: "Inter,sans-serif", fontSize: 12, color: C.muted, textAlign: "center", padding: "0 10px" }}>
              Bus has already passed your location
            </div>
          ) : (
            <PrimaryBtn label="📍 Pickup Here" onClick={() => onNav("stop-here")} />
          )}
        </div>
      </div>
    </div>
  );
}


/**
 * Uses the driver's live GPS position stored on the bus document.
 * It deliberately does NOT use the admin-entered stop `time` field.
 *
 * ETA is calculated from the current bus position to the remaining stops
 * using the road router, then converted into the actual arrival clock time.
 */
function formatArrivalTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function getRouteProgressPercent(
  stops: FireRouteStop[],
  busPosition: { lat: number; lng: number } | null,
) {
  const plotted = stops.filter(
    s => typeof s.lat === "number" && typeof s.lng === "number"
  );

  if (!busPosition || plotted.length < 2) return 0;

  // Find the closest point on any stop-to-stop segment.
  // This gives a smoother progress value than simply using the nearest stop.
  let bestSegment = 0;
  let bestT = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  const latScale = 111320;
  const lngScale = 111320 * Math.cos(busPosition.lat * Math.PI / 180);

  for (let i = 0; i < plotted.length - 1; i++) {
    const a = plotted[i];
    const b = plotted[i + 1];

    const ax = (a.lng! - busPosition.lng) * lngScale;
    const ay = (a.lat! - busPosition.lat) * latScale;
    const bx = (b.lng! - busPosition.lng) * lngScale;
    const by = (b.lat! - busPosition.lat) * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
      : 0;

    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.sqrt(px * px + py * py);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = i;
      bestT = t;
    }
  }

  return Math.max(
    0,
    Math.min(100, ((bestSegment + bestT) / (plotted.length - 1)) * 100)
  );
}

function useLiveStopArrivalTimes(
  stops: FireRouteStop[],
  busPosition: { lat: number; lng: number } | null,
) {
  const [arrivalTimes, setArrivalTimes] = useState<Record<number, number>>({});
  const [now, setNow] = useState(() => Date.now());

  const stopsKey = stops
    .map(s => `${s.name}:${s.lat ?? ""},${s.lng ?? ""}`)
    .join("|");

  const busKey = busPosition
    ? `${busPosition.lat},${busPosition.lng}`
    : "";

  // Keep the displayed clock genuinely current even when the bus GPS
  // does not change for a short period.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!busPosition || stops.length === 0) {
      setArrivalTimes({});
      return;
    }

    const liveStops = withLiveStopStates(stops, busPosition);
    const currentIndex = liveStops.findIndex(s => s.state === "current");
    const firstRemainingIndex =
      currentIndex >= 0
        ? currentIndex
        : liveStops.findIndex(s => s.state !== "done");

    if (firstRemainingIndex < 0) {
      setArrivalTimes({});
      return;
    }

    const remainingStops = liveStops.slice(firstRemainingIndex).filter(
      s => typeof s.lat === "number" && typeof s.lng === "number"
    );

    if (remainingStops.length === 0) {
      setArrivalTimes({});
      return;
    }

    const controller = new AbortController();
    const coordinates = [
      `${busPosition.lng},${busPosition.lat}`,
      ...remainingStops.map(s => `${s.lng},${s.lat}`),
    ].join(";");

    fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=false`,
      { signal: controller.signal }
    )
      .then(response => {
        if (!response.ok) throw new Error(`ETA request failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        const legs = Array.isArray(data.routes?.[0]?.legs)
          ? data.routes[0].legs
          : [];

        let cumulativeSeconds = 0;
        const next: Record<number, number> = {};

        remainingStops.forEach((stop, offset) => {
          const leg = legs[offset];
          if (typeof leg?.duration !== "number") return;

          cumulativeSeconds += leg.duration;
          const originalIndex = liveStops.indexOf(stop);
          if (originalIndex >= 0) {
            next[originalIndex] = cumulativeSeconds;
          }
        });

        setArrivalTimes(next);
      })
      .catch(error => {
        if (error.name !== "AbortError") {
          console.error("Unable to calculate live stop ETAs", error);
          setArrivalTimes({});
        }
      });

    return () => controller.abort();
  }, [stopsKey, busKey]);

  return { arrivalTimes, now };
}

// 6 ─ Route & Stops
function RouteStopsScreen({ onNav, buses, stopsByRoute, backTo = "bus-details", assignedBus, selectedBus }: { onNav: (s: Screen) => void; buses: FireBus[]; stopsByRoute: Record<string, FireRouteStop[]>; backTo?: Screen; assignedBus?: FireBus; selectedBus?: FireBus }) {
  const myBus = selectedBus ?? assignedBus ?? buses[0] ?? EMPTY_BUS;
  const rawStops = myBus ? (stopsByRoute[myBus.r] ?? []) : [];
  const tripDirection = getTripDirection(myBus);
  const orderedStops = getDirectionalStops(rawStops, myBus);
  const busPosition =
    myBus.lat != null && myBus.lng != null
      ? { lat: myBus.lat, lng: myBus.lng }
      : null;

  // Stop status and the blue progress line are both driven by the
  // driver's current GPS position.
  const stops = withLiveStopStates(orderedStops, busPosition);
  const { arrivalTimes, now } = useLiveStopArrivalTimes(stops, busPosition);
  const progressPercent = getRouteProgressPercent(stops, busPosition);

  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <TopBar title="Route & Stops" onBack={() => onNav(backTo)} />
        <div style={{ padding: "0 20px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 12 }}>{myBus.r}</div>
          <span style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub }}>
            {getDirectionalRouteName(myBus.routeName, tripDirection)} · {stops.length} stops
          </span>
          {tripDirection === "return" && (
            <span style={{ fontSize: 10, fontWeight: 800, color: C.warn, background: C.warnBg, borderRadius: 20, padding: "3px 8px" }}>RETURN</span>
          )}
          {myBus.live ? <LiveBadge small /> : (
            <span style={{ fontSize: 10, fontWeight: 700, color: C.muted }}>OFFLINE</span>
          )}
          <button
            onClick={() => onNav("live-map")}
            style={{
              position: "fixed",
              right: 24,
              bottom: 24,
              height: 48,
              padding: "0 20px",
              borderRadius: 24,
              border: "none",
              background: C.blue,
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
              zIndex: 100,
            }}
          >
            📍 Track Bus
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 32px" }}>
        {busPosition ? (
          <div style={{ fontSize: 11, color: C.live, fontWeight: 700, marginBottom: 12 }}>
            ● Live GPS · arrivals update from the bus's current location
          </div>
        ) : (
          <div style={{ fontSize: 11, color: C.warn, fontWeight: 700, marginBottom: 12 }}>
            Waiting for driver's live GPS location
          </div>
        )}

        <div style={{ position: "relative" }}>
          {/* Full track line */}
          <div style={{
            position: "absolute",
            left: 10,
            top: 10,
            bottom: 10,
            width: 2,
            background: C.border
          }} />

          {/* Blue section = actual bus progress along the route */}
          {stops.length > 1 && busPosition && progressPercent > 0 && (
            <div style={{
              position: "absolute",
              left: 10,
              top: 10,
              width: 2,
              height: `calc(${progressPercent}% - ${progressPercent * 0.2}px)`,
              background: C.blue,
              transition: "height 0.8s ease"
            }} />
          )}

          {stops.map((s, i) => {
            const seconds = arrivalTimes[i];
            const isPassed = s.state === "done";
            const arrivalLabel = isPassed
              ? "Passed"
              : typeof seconds === "number"
                ? seconds < 60
                  ? "Arriving now"
                  : formatArrivalTime(new Date(now + seconds * 1000))
                : busPosition
                  ? "Calculating…"
                  : "Waiting for GPS";

            return (
              <div key={`${s.name}-${i}`} style={{ display: "flex", gap: 20, marginBottom: i < stops.length - 1 ? 24 : 0, alignItems: "center", animation: `fadeUp 0.3s ${i * 0.07}s both` }}>
                {/* Dot */}
                <div style={{ flexShrink: 0, width: 22, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
                  {s.state === "done" ? (
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.muted }} />
                  ) : s.state === "current" ? (
                    <div style={{ width: 16, height: 16, borderRadius: "50%", background: C.blue, border: "2px solid #fff", boxShadow: `0 0 0 3px ${C.blueGlow}` }} />
                  ) : (
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.surface, border: `2px solid ${C.border}` }} />
                  )}
                </div>

                {/* Stop content — admin `s.time` is intentionally NOT used */}
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderRadius: 12, background: s.state === "current" ? C.blueSubtle : C.surface, border: `1px solid ${s.state === "current" ? C.blue : C.border}` }}>
                  <div>
                    <div style={{ fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 14, color: isPassed ? C.muted : C.text, textDecoration: isPassed ? "line-through" : "none" }}>{s.name}</div>
                    {s.state === "current" && (
                      <div style={{ fontSize: 11, color: C.blue, fontWeight: 700, marginTop: 2 }}>
                        ● Next Stop
                      </div>
                    )}
                  </div>
                  <div style={{ fontFamily: "Outfit,sans-serif", fontSize: 13, fontWeight: 700, color: isPassed ? C.muted : s.state === "current" ? C.blue : C.sub, textAlign: "right" }}>
                    {arrivalLabel}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 7 ─ Find My Bus
function FindBusScreen({ onNav, buses, onSelectBus }: { onNav: (s: Screen) => void; buses: FireBus[]; onSelectBus?: (id: string) => void }) {
  const [stop, setStop] = useState("");
  const source = buses.length ? buses : FALLBACK_BUSES;
  const results = source.filter(b => !stop.trim() || `${b.n} ${b.r}`.toLowerCase().includes(stop.toLowerCase()));
  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <TopBar title="Find My Bus" onBack={() => onNav("student-home")} />
        <div style={{ padding: "0 20px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 44, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "0 14px", background: C.bg }}>
            {Ic.search}
            <input value={stop} onChange={e => setStop(e.target.value)} placeholder="Enter your stop name" style={{ flex: 1, border: "none", outline: "none", fontSize: 14, fontFamily: "Inter,sans-serif", color: C.text, background: "transparent" }} />
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: "0.8px", marginBottom: 12 }}>BUSES TO RIT CAMPUS</div>
        {results.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, padding: 20, color: C.sub, fontSize: 14, textAlign: "center" }}>No active bus matches that search.</div>
        ) : results.map((b, i) => (
          <button key={b.n} onClick={() => onNav("bus-details")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "16px", marginBottom: 10, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.07}s both` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 14 }}>{b.n.replace("Bus ", "")}</div>
              <div style={{ textAlign: "left" }}>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text }}>{b.n}</div>
                <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginTop: 2 }}>{b.dist} away · {b.stops} stops</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 20, color: C.blue }}>{b.eta}<span style={{ fontSize: 12, fontWeight: 500, color: C.sub }}> min</span></div>
              <LiveBadge small />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// 8 ─ Request Pickup
function StopHereScreen({ onNav, selectedBus, user }: { onNav: (s: Screen) => void; selectedBus?: FireBus; user: UserProfile }) {
  const [step, setStep] = useState<"view" | "confirm" | "done">("view");
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");

  async function sendLocationRequest() {
    if (!selectedBus) {
      setError("Please select a bus first.");
      return;
    }
    if (!navigator.geolocation) {
      setError("Location is not supported on this device/browser.");
      return;
    }
    setSharing(true);
    setError("");
    navigator.geolocation.getCurrentPosition(async position => {
      try {
        await addStopRequest({
          loc: "Student current location",
          route: selectedBus.r,
          count: 1,
          reason: "Student requested pickup and shared current location.",
          kind: "student-location",
          locationShared: true,
          studentEmail: user.email,
          studentName: user.name,
          targetDriverEmail: selectedBus.driverEmail ?? "",
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          createdAt: Date.now(),
        } as unknown as FireStopRequest);
        setStep("done");
      } catch (e) {
        console.error(e);
        setError("Could not send the location. Please try again.");
      } finally {
        setSharing(false);
      }
    }, () => {
      setSharing(false);
      setError("Please allow location access and try again.");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
  }

  if (step === "done") return (
    <div style={{ position: "absolute", inset: 0, background: C.surface, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.liveBg, display: "flex", alignItems: "center", justifyContent: "center", color: C.live, marginBottom: 20 }}>{Ic.check}</div>
      <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 22, color: C.text, marginBottom: 8 }}>Location Shared</div>
      <div style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: C.sub, textAlign: "center", lineHeight: 1.6, marginBottom: 28 }}>The driver assigned to {selectedBus?.r ?? "this bus"} has been notified and your location is visible on their map.</div>
      <PrimaryBtn label="Track Bus" onClick={() => onNav("live-map")} />
    </div>
  );

  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}><StatusBar /><TopBar title="Share Pickup Location" onBack={() => onNav("bus-details")} /></div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
        <div style={{ borderRadius: 16, overflow: "hidden", border: `1px solid ${C.border}`, marginBottom: 16 }}><MapView animateBus={false} height={190} /></div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16, marginBottom: 12 }}>
          <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 17, color: C.text, marginBottom: 12 }}>Share your current location?</div>
          {[
            { l: "Bus", v: selectedBus?.n ?? "No bus selected" },
            { l: "Route", v: selectedBus?.routeName ?? selectedBus?.r ?? "—" },
            { l: "Driver", v: selectedBus?.driverEmail ?? "Not assigned" },
          ].map(r => <div key={r.l} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ fontSize: 13, color: C.sub }}>{r.l}</span><span style={{ fontSize: 13, fontWeight: 700, color: C.text, textAlign: "right" }}>{r.v}</span></div>)}
        </div>
        {error && <div style={{ background: "#FFEBEE", color: "#C62828", borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 13 }}>{error}</div>}
        {step === "view" && <PrimaryBtn label={sharing ? "Getting your location…" : "📍 Share Location & Notify Driver"} onClick={() => setStep("confirm")} />}
        {step === "confirm" && <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16 }}><div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Send your current location to the assigned driver?</div><div style={{ display: "flex", gap: 10 }}><GhostBtn label="Cancel" onClick={() => setStep("view")} /><PrimaryBtn label={sharing ? "Sending…" : "Confirm"} onClick={sendLocationRequest} /></div></div>}
      </div>
    </div>
  );
}

// 9 ─ Suggest Stop
function MakeStopScreen({ onNav, selectedBus, user }: { onNav: (s: Screen) => void; selectedBus?: FireBus; user: UserProfile }) {
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);

  if (done) return (
    <div style={{ position: "absolute", inset: 0, background: C.surface, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, paddingTop: 68 }}>
      <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.skySubtle, display: "flex", alignItems: "center", justifyContent: "center", color: C.sky, marginBottom: 20, animation: "scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both", fontSize: 32 }}>🏗️</div>
      <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 22, color: C.text, marginBottom: 8 }}>Request Submitted</div>
      <div style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: C.sub, textAlign: "center", lineHeight: 1.6, marginBottom: 16 }}>Sent to Transport Admin for review.</div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.warnBg, color: C.warn, borderRadius: 20, padding: "6px 14px", fontSize: 13, fontWeight: 700, marginBottom: 32 }}>● Status: Pending</div>
      <PrimaryBtn label="Back to Home" onClick={() => onNav("student-home")} />
    </div>
  );

  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <TopBar title="Suggest New Stop" onBack={() => onNav("student-home")} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
        <div style={{ borderRadius: 14, overflow: "hidden", border: `1px solid ${C.border}`, marginBottom: 16 }}>
          <MapView animateBus={false} height={160} />
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>
          {[{ l: "Selected Location", v: "Arcot" }, { l: "Route", v: selectedBus?.r ?? "—" }, { l: "Requests so far", v: "1 student" }].map((r, i, arr) => (
            <div key={r.l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ fontSize: 13, color: C.sub, fontFamily: "Inter,sans-serif" }}>{r.l}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: "Inter,sans-serif" }}>{r.v}</span>
            </div>
          ))}
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 8 }}>REASON FOR STOP REQUEST</div>
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain why this stop is needed..." rows={4}
            style={{ width: "100%", border: "none", outline: "none", fontSize: 14, fontFamily: "Inter,sans-serif", color: C.text, resize: "none", background: "transparent" }} />
        </div>

        <PrimaryBtn label="Submit Request" onClick={() => {
          if (!reason.trim()) return;
          addStopRequest({
            loc: "Selected location",
            route: selectedBus?.r ?? "—",
            count: 1,
            reason: reason.trim(),
            studentEmail: user.email.toLowerCase(),
            studentName: user.name,
            targetDriverEmail: selectedBus?.driverEmail?.toLowerCase() ?? "",
            driverEmail: selectedBus?.driverEmail?.toLowerCase() ?? "",
            busId: selectedBus?.id ?? "",
            busNumber: selectedBus?.n ?? "",
          }).catch(console.error);
          setDone(true);
        }} />
      </div>
    </div>
  );
}

// 10 ─ Notifications
function NotificationsScreen({ onNav }: { onNav: (s: Screen) => void }) {
  const [items, setItems] = useState<Notification[]>([]);




  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <div style={{ padding: "4px 20px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 20, color: C.text }}>Notifications</div>
          <button onClick={() => setItems(i => i.map(x => ({ ...x, isNew: false })))} style={{ fontSize: 13, color: C.blue, fontFamily: "Inter,sans-serif", fontWeight: 500, border: "none", background: "none", cursor: "pointer" }}>Mark all read</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px 88px" }}>

        {items.map((n, i) => (
          <div key={i} style={{ display: "flex", gap: 12, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 8, borderLeft: `3px solid ${n.isNew ? n.dot : C.border}`, animation: `slideInRight 0.3s ${i * 0.05}s both` }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{n.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 14, color: C.text, marginBottom: 3 }}>{n.title}</div>
              <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.muted }}>{n.time}</div>
            </div>
            {n.isNew && <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.blue, flexShrink: 0, marginTop: 4 }} />}
          </div>
        ))}
      </div>
      <BottomNav active="notifications" onNav={onNav} />
    </div>
  );
}

// 11 ─ My Trips
function MyTripsScreen({ onNav }: { onNav: (s: Screen) => void }) {
  const [trips] = useStoredState<Trip[]>("rit-trips-r24", []);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <div style={{ padding: "4px 20px 14px" }}>
          <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 20, color: C.text }}>My Trips</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 100px" }}>
        {trips.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, padding: 20, color: C.sub, fontSize: 14, textAlign: "center" }}>Your completed trips will appear here.</div>
        ) : trips.map((t, i) => (
          <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 10, display: "flex", alignItems: "center", gap: 14, animation: `fadeUp 0.3s ${i * 0.07}s both` }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14 }}>{t.bus}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 14, color: C.text }}>{t.from} → {t.to}</div>
              <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.muted, marginTop: 2 }}>{t.date}</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.live, background: C.liveBg, padding: "3px 10px", borderRadius: 20 }}>{t.status}</span>
          </div>
        ))}
      </div>
      <BottomNav active="my-trips" onNav={onNav} />
    </div>
  );
}

// 12 ─ Settings
function SettingsScreen({ onNav, preferences, setPreferences }: { onNav: (s: Screen) => void; preferences: Preferences; setPreferences: React.Dispatch<React.SetStateAction<Preferences>> }) {
  const text = copy[preferences.language];
  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <TopBar title={text.settings} onBack={() => onNav("profile")} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 32px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: "0.8px", marginBottom: 10 }}>{text.appearance.toUpperCase()}</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: `1px solid ${C.border}` }}>
            <div>
              <div style={{ fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 14, color: C.text }}>{text.darkMode}</div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 3 }}>{preferences.theme === "dark" ? "On" : "Off"}</div>
            </div>
            <button aria-label={text.darkMode} onClick={() => setPreferences(value => ({ ...value, theme: value.theme === "dark" ? "light" : "dark" }))} style={{ width: 50, height: 30, padding: 3, border: "none", borderRadius: 20, background: preferences.theme === "dark" ? C.blue : C.border, cursor: "pointer", textAlign: preferences.theme === "dark" ? "right" : "left" }}>
              <span style={{ display: "inline-block", width: 24, height: 24, borderRadius: "50%", background: "#FFFFFF", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
            </button>
          </div>
          <div style={{ padding: "16px 18px" }}>
            <div style={{ fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 14, color: C.text, marginBottom: 10 }}>{text.language}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {([["en", text.english], ["ta", text.tamil]] as [Language, string][]).map(([value, label]) => (
                <button key={value} onClick={() => setPreferences(current => ({ ...current, language: value }))} style={{ height: 42, borderRadius: 10, border: `1.5px solid ${preferences.language === value ? C.blue : C.border}`, background: preferences.language === value ? C.skyLight : C.surface, color: preferences.language === value ? C.blue : C.sub, fontWeight: 700, cursor: "pointer" }}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ color: C.live, fontSize: 13, fontWeight: 600, textAlign: "center" }}>{text.save}</div>
      </div>
    </div>
  );
}

// 13 ─ Profile
function ProfileScreen({ onNav, onLogout, user, language }: { onNav: (s: Screen) => void; onLogout: () => void; user: UserProfile; language: Language }) {
  const text = copy[language];
  const initials = user.name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <div style={{ padding: "4px 20px 14px" }}>
          <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 20, color: C.text }}>{text.profile}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 88px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 20, color: "#fff" }}>{initials}</div>
          <div>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 17, color: C.text }}>{user.name}</div>
            <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub, marginTop: 1 }}>{user.email}</div>
          </div>
        </div>
        <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {([
            ["My Bus Pass", "my-trips"],
            ["Stop Requests", "make-stop"],
            ["Trip History", "my-trips"],
            ["Notifications", "notifications"],
            [text.settings, "settings"],
          ] as [string, Screen | null][]).map(([item, dest], i, arr) => (
            <button key={item} onClick={() => dest && onNav(dest)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: "0 2px 8px rgba(13,27,42,0.04)", cursor: dest ? "pointer" : "default" }}>
              <span style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: C.text }}>{item}</span>
              {Ic.chevron}
            </button>
          ))}
        </div>
        <button onClick={onLogout} style={{ width: "100%", height: 48, borderRadius: 12, background: "transparent", border: "1.5px solid #E53935", color: "#E53935", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>{text.signOut}</button>
      </div>
      <BottomNav active="profile" onNav={onNav} />
    </div>
  );
}

// 13 ─ Driver Home
function DriverHome({ onNav, onLogout, user, assignedBus }: { onNav: (s: Screen) => void; onLogout: () => void; user: UserProfile; assignedBus?: FireBus }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <div style={{ padding: "4px 20px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub }}>Good morning</div>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 22, color: C.text }}>{user.name}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button aria-label="Toggle theme" title="Toggle dark mode" onClick={toggleTheme} style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              {theme === "dark" ? Ic.sun : Ic.moon}
            </button>
            <button onClick={onLogout} style={{ height: 36, padding: "0 12px", borderRadius: 10, background: "transparent", border: `1.5px solid #E53935`, color: "#E53935", fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Sign Out</button>
            <div style={{ background: "#fff", borderRadius: 10, lineHeight: 0, border: `1px solid ${C.border}` }}>
              <img src={ritLogo} alt="RIT" style={{ width: 72, height: "auto", display: "block", borderRadius: 10 }} />
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
        {/* Bus assignment */}
        {assignedBus ? (
          <div style={{ background: C.blue, borderRadius: 16, padding: 20, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.6)", letterSpacing: "0.8px", marginBottom: 12 }}>ASSIGNED BUS</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 32, color: "#fff", letterSpacing: "-1px" }}>{assignedBus.r}</div>
                <div style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>{assignedBus.routeName}</div>
              </div>
              <div style={{ fontSize: 40 }}>🚌</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[{ l: "Stops", v: String(assignedBus.stops) }, { l: "Distance", v: assignedBus.dist }, { l: "ETA", v: `${assignedBus.eta} min` }].map(s => (
                <div key={s.l} style={{ background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, color: "#fff" }}>{s.v}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 16, padding: 20, marginBottom: 12, textAlign: "center" }}>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 6 }}>No bus assigned yet</div>
            <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub }}>Ask your Transport Admin to assign a bus to {user.email || "your account"} in Manage Buses.</div>
          </div>
        )}

        {/* Schedule */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.text }}>Today's Schedule</div>
          {[{ t: "08:30 AM", label: "Morning Trip" }, { t: "01:00 PM", label: "Afternoon Return" }, { t: "05:30 PM", label: "Evening Trip" }].map((s, i, arr) => (
            <div key={s.t} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.blue, flexShrink: 0 }} />
              <div style={{ flex: 1, fontFamily: "Inter,sans-serif", fontSize: 14, color: C.text }}>{s.label}</div>
              <div style={{ fontFamily: "Outfit,sans-serif", fontSize: 13, fontWeight: 600, color: C.sub }}>{s.t}</div>
            </div>
          ))}
        </div>

        <button onClick={() => assignedBus && onNav("driver-start")} disabled={!assignedBus} style={{ width: "100%", height: 54, borderRadius: 14, background: assignedBus ? C.live : C.muted, color: "#fff", border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 18, cursor: assignedBus ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 10 }}>
          {Ic.play} START TRIP
        </button>
      </div>
    </div>
  );
}

// 14 ─ Start Trip
function DriverStartTrip({ onNav, assignedBus, onTripStart }: { onNav: (s: Screen) => void; assignedBus?: FireBus; onTripStart: () => void }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function start() {

    setLoading(true);
    setTimeout(() => { setDone(true); setTimeout(() => onNav("driver-live"), 1000); }, 1400);
    const trip: Trip = { bus: assignedBus?.r ?? "—", from: assignedBus?.routeName?.split("→")[0]?.trim() ?? "—", to: assignedBus?.routeName?.split("→")[1]?.trim() ?? "—", date: `Today, ${nowLabel()}`, status: "In progress" };
    localStorage.setItem("rit-active-trip", JSON.stringify(trip));
    if (assignedBus?.id) setBusLive(assignedBus.id, true).catch(err => console.error("Unable to mark bus live", err));
    onTripStart(); // starts background GPS tracking (owned by App)
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: C.navy, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <StatusBar dark />
      {done ? (
        <div style={{ textAlign: "center", animation: "scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both" }}>
          <div style={{ width: 80, height: 80, borderRadius: "50%", background: C.liveBg, display: "flex", alignItems: "center", justifyContent: "center", color: C.live, margin: "0 auto 20px" }}>{Ic.check}</div>
          <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 24, color: "#fff" }}>Trip Started!</div>
        </div>
      ) : (
        <>
          <div style={{ textAlign: "center", marginBottom: 40, animation: "fadeUp 0.4s ease both" }}>
            <div style={{ fontFamily: "Inter,sans-serif", fontSize: 14, color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>Ready to start</div>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 34, color: "#fff", letterSpacing: "-0.5px" }}>{assignedBus?.r ?? "No bus"}?</div>
          </div>
          <div style={{ width: "100%", border: `1px solid rgba(255,255,255,0.12)`, borderRadius: 16, overflow: "hidden", marginBottom: 32 }}>
            {[{ l: "Route", v: assignedBus?.routeName ?? "—" }, { l: "Total Stops", v: String(assignedBus?.stops ?? "—") }, { l: "Scheduled", v: "5:20 AM" }].map((r, i, arr) => (
              <div key={r.l} style={{ display: "flex", justifyContent: "space-between", padding: "14px 20px", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
                <span style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: "rgba(255,255,255,0.5)" }}>{r.l}</span>
                <span style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 13, color: "#fff" }}>{r.v}</span>
              </div>
            ))}
          </div>
          <button onClick={start} style={{ width: "100%", height: 54, borderRadius: 14, background: C.live, color: "#fff", border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 800, fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 14 }}>
            {loading ? <div style={{ width: 22, height: 22, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> : <>{Ic.play} Start Trip</>}
          </button>
          <button onClick={() => onNav("driver-home")} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontFamily: "Inter,sans-serif", fontSize: 14, cursor: "pointer" }}>Cancel</button>
        </>
      )}
    </div>
  );
}

// 15 ─ Driver Live Map
function DriverLiveScreen({ onNav, busId, stopsByRoute, assignedBus, requests = [], position, onTripEnd }: { onNav: (s: Screen) => void; busId: string; stopsByRoute: Record<string, FireRouteStop[]>; assignedBus?: FireBus; requests?: FireStopRequest[]; position: GeolocationPosition | null; onTripEnd: () => void }) {
  const [req, setReq] = useState(true);
  const [endingTrip, setEndingTrip] = useState(false);
  // Return-trip direction is stored on the bus document, so every student's
  // screen receives the same direction through the live bus subscription.
  const [isReturnTrip, setIsReturnTrip] = useState<TripDirection>(
    getTripDirection(assignedBus)
  );

  useEffect(() => {
    setIsReturnTrip(getTripDirection(assignedBus));
  }, [(assignedBus as any)?.direction]);

  const rawStops = assignedBus
    ? (stopsByRoute[assignedBus.r] ?? [])
    : [];
  const orderedStops = getDirectionalStops(rawStops, assignedBus);

  async function toggleTripDirection() {
    if (!busId) return;
    const nextDirection: TripDirection =
      isReturnTrip === "return" ? "outbound" : "return";

    setIsReturnTrip(nextDirection);

    try {
      await updateBus(busId, { direction: nextDirection } as any);
    } catch (error) {
      console.error("Unable to update trip direction", error);
      setIsReturnTrip(getTripDirection(assignedBus));
    }
  }

  const busPosition = position ? { lat: position.coords.latitude, lng: position.coords.longitude } : null;
  // Compute done/current/upcoming from the driver's live GPS so passed
  // checkpoints show as struck-through on the map, same as the student view.
  const stops = withLiveStopStates(orderedStops, busPosition);
  const nextStop = stops.find(s => s.state === "current") ?? stops.find(s => s.state === "upcoming") ?? stops[0];
  const remaining = stops.reduce((count, stop) => count + (stop.state === "done" ? 0 : 1), 0);
  const speedKmh = position?.coords.speed != null && position.coords.speed >= 0 ? Math.round(position.coords.speed * 3.6) : null;
  const sharedStudents: SharedStudentLocation[] = requests
    .filter(r => {
      const data = r as any;
      const sameRoute = data.route === assignedBus?.r;
      const sameDriver = !data.targetDriverEmail || !assignedBus?.driverEmail
        ? true
        : String(data.targetDriverEmail).toLowerCase() === String(assignedBus.driverEmail).toLowerCase();
      return data.kind === "student-location" && data.locationShared === true && sameRoute && sameDriver && data.lat != null && data.lng != null;
    })
    .map(r => {
      const data = r as any;
      return {
        id: String(data.id),
        lat: Number(data.lat),
        lng: Number(data.lng),
        studentName: data.studentName,
        studentEmail: data.studentEmail,
      };
    });
  const etaMinutes = useRealEta(busPosition, nextStop);

  function endTrip() {
    if (endingTrip) return;
    setEndingTrip(true);

    try {
      const active = localStorage.getItem("rit-active-trip");
      const trips = JSON.parse(localStorage.getItem("rit-trips-r24") || "[]") as Trip[];
      if (active) {
        const trip = JSON.parse(active) as Trip;
        localStorage.setItem("rit-trips-r24", JSON.stringify([{ ...trip, status: "Completed" }, ...trips]));
        localStorage.removeItem("rit-active-trip");
      }
    } catch (error) {
      console.error("Unable to save completed trip", error);
      localStorage.removeItem("rit-active-trip");
    }

    if (busId) {
      setBusLive(busId, false).catch(error => console.error("Unable to end trip in Firestore", error));
    }
    onTripEnd(); // stops background GPS tracking (owned by App)
    onNav("driver-home");
  }

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, zIndex: 0 }}><RouteMapView
        stops={stops}
        busPosition={busPosition}
        studentLocations={sharedStudents}
        height={window.innerHeight}
      /></div>

      {/* Top overlay */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 1000, padding: "0 14px 0" }}>
        <StatusBar dark />
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button aria-label="Back to driver home" title="Back to driver home" onClick={() => onNav("driver-home")} style={{ height: 44, padding: "0 12px", borderRadius: 12, background: "rgba(13,27,42,0.94)", border: "1px solid rgba(255,255,255,0.18)", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontFamily: "Inter,sans-serif", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.24)" }}>
            {Ic.back}
            <span>Back</span>
          </button>
          <button
            aria-label="Toggle return trip direction"
            title="Flip stop order for the return trip"
            onClick={toggleTripDirection}
            style={{
              height: 44,
              padding: "0 14px",
              borderRadius: 12,
              background: isReturnTrip === "return" ? "#C84B11" : "rgba(13,27,42,0.94)",
              border: "1px solid rgba(255,255,255,0.18)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "#fff",
              fontFamily: "Inter,sans-serif",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.24)",
            }}
          >
            <span>{isReturnTrip === "return" ? "↩ Returning" : "↪ Return"}</span>
          </button>
          <div style={{ flex: 1, background: "rgba(13,27,42,0.88)", backdropFilter: "blur(8px)", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontFamily: "Inter,sans-serif", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Active Trip · {assignedBus?.r ?? "—"}</div>
              <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: "#fff" }}>
                {getDirectionalRouteName(assignedBus?.routeName, isReturnTrip)}
              </div>
            </div>
            <LiveBadge />
          </div>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(13,27,42,0.88)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, lineHeight: 1 }}>{speedKmh ?? "—"}</div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>km/h</div>
          </div>
        </div>
      </div>

      {/* Pickup request card */}
      {req && sharedStudents.length > 0 && (
        <div style={{ position: "absolute", left: 14, right: 14, top: 130, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.2)", zIndex: 20 }}>
          <div style={{ background: C.warnBg, borderBottom: `1px solid ${C.border}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>📍</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.warn }}>Student Location Shared</div>
              <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub }}>{sharedStudents[0].studentName || "Student"} is visible on your map.</div>
            </div>
            <button onClick={() => setReq(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted }}>{Ic.close}</button>
          </div>
          <div style={{ display: "flex", gap: 10, padding: "12px 16px" }}>
            <button onClick={() => setReq(false)} style={{ flex: 1, height: 40, borderRadius: 10, background: C.live, color: "#fff", border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Seen</button>
          </div>
        </div>
      )}

      {/* Bottom sheet */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1100, background: "rgba(13,27,42,0.94)", backdropFilter: "blur(10px)", borderRadius: "20px 20px 0 0" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "10px auto 0" }} />
        <div style={{ padding: "12px 20px 32px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
            {[{ l: "Next Stop", v: nextStop?.name ?? "—" }, { l: "ETA", v: etaMinutes != null ? `${etaMinutes} min` : "—" }, { l: "Remaining", v: `${remaining} stops` }].map(s => (
              <div key={s.l} style={{ background: "rgba(255,255,255,0.07)", borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: "#fff" }}>{s.v}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{s.l}</div>
              </div>
            ))}
          </div>
          <button onClick={endTrip} disabled={endingTrip} style={{ width: "100%", height: 48, borderRadius: 12, background: endingTrip ? C.muted : "#E53935", color: "#fff", border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, cursor: endingTrip ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {Ic.stop} {endingTrip ? "Ending…" : "End Trip"}
          </button>
        </div>
      </div>
    </div>
  );
}



// 16 ─ Admin Dashboard
function AdminDashboard({
  onNav,
  onLogout,
  buses,
  onEditBus,
}: {
  onNav: (s: Screen) => void;
  onLogout: () => void;
  buses: FireBus[];
  onEditBus?: (b: FireBus) => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const [drivers, setDrivers] = useState<UserProfile[]>([]);

  useEffect(() => {
    const unsub = subscribeDrivers(setDrivers);
    return () => unsub();
  }, []);

  const activeBusCount = buses.filter(bus => bus.live).length;
  const activeDriverCount = new Set(
    buses
      .filter(bus => bus.live && bus.driverEmail)
      .map(bus => bus.driverEmail!.toLowerCase())
  ).size;

  const stats = [
    {
      l: "Active Buses",
      v: String(activeBusCount),
      sub: `of ${buses.length} total`,
      dot: C.live,
    },
    {
      l: "Total Buses",
      v: String(buses.length),
      sub: "fleet size",
      dot: C.blue,
    },
    {
      l: "Active Drivers",
      v: String(activeDriverCount),
      sub: "on duty",
      dot: C.sky,
    },
    {
      l: "Today's Trips",
      v: String(activeBusCount),
      sub: "live trips",
      dot: C.blue,
    },
  ];

  const sections: {
    l: string;
    badge: string | null;
    target: Screen;
    icon: React.ReactNode;
    color: string;
  }[] = [
      {
        l: "Add Bus",
        badge: null,
        target: "admin-add-bus",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        ),
        color: C.blue,
      },
      {
        l: "Edit Buses",
        badge: `${buses.length} buses`,
        target: "admin-edit-bus",
        icon: Ic.edit,
        color: "#0288D1",
      },
      {
        l: "Stop Requests",
        badge: "5 new",
        target: "admin-stops",
        icon: Ic.bell,
        color: "#E85D75",
      },
    ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: C.bg,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Animation styles */}
      <style>{`
        @keyframes adminFadeUp {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes iconPop {
          from {
            transform: scale(0.85);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }

        .admin-section-row {
          transition:
            transform 0.2s ease,
            background 0.2s ease,
            box-shadow 0.2s ease;
        }

        .admin-section-row:hover {
          transform: translateY(-2px);
          background: rgba(78, 147, 80, 0.04) !important;
          box-shadow: 0 5px 18px rgba(0,0,0,0.05);
        }

        .admin-section-row:active {
          transform: scale(0.985);
        }

        .admin-section-icon {
          transition:
            transform 0.2s ease,
            border-radius 0.2s ease;
        }

        .admin-section-row:hover .admin-section-icon {
          transform: scale(1.08) rotate(-2deg);
          border-radius: 14px;
        }

        @media (max-width: 600px) {
          .admin-section-row {
            padding: 16px 14px !important;
          }
        }

        @media (min-width: 900px) {
          .admin-section-row {
            padding: 18px 22px !important;
          }
        }
      `}</style>

      {/* Header */}
      <div
        style={{
          background: C.surface,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <StatusBar />

        <div
          style={{
            padding: "4px 20px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "Inter,sans-serif",
                fontSize: 12,
                color: C.sub,
                letterSpacing: "0.5px",
              }}
            >
              TRANSPORT ADMIN
            </div>

            <div
              style={{
                fontFamily: "Outfit,sans-serif",
                fontWeight: 800,
                fontSize: 20,
                color: C.text,
              }}
            >
              Dashboard
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button aria-label="Toggle theme" title="Toggle dark mode" onClick={toggleTheme} style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              {theme === "dark" ? Ic.sun : Ic.moon}
            </button>
            <button onClick={onLogout} style={{ height: 36, padding: "0 12px", borderRadius: 10, background: "transparent", border: "1.5px solid #E53935", color: "#E53935", fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Sign Out</button>
            <div
              style={{
                background: "#fff",
                borderRadius: 9,
                lineHeight: 0,
                border: `1px solid ${C.border}`,
              }}
            >
              <img
                src={ritLogo}
                alt="RIT"
                style={{
                  width: 64,
                  height: "auto",
                  display: "block",
                  borderRadius: 9,
                }}
              />
            </div>
          </div>
        </div>
      </div>

        {/* Main content */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px 32px",
          }}
        >
          {/* Stats */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 12,
              marginBottom: 20,
            }}
          >
            {stats.map((s, i) => (
              <div
                key={s.l}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 16,
                  padding: "18px",
                  animation: `adminFadeUp 0.35s ease ${i * 0.07}s both`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    marginBottom: 9,
                  }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: s.dot,
                    }}
                  />

                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: C.muted,
                    }}
                  >
                    {s.l}
                  </div>
                </div>

                <div
                  style={{
                    fontFamily: "Outfit,sans-serif",
                    fontWeight: 800,
                    fontSize: 30,
                    color: C.text,
                    lineHeight: 1,
                  }}
                >
                  {s.v}
                </div>

                <div
                  style={{
                    fontSize: 11,
                    color: C.muted,
                    marginTop: 5,
                  }}
                >
                  {s.sub}
                </div>
              </div>
            ))}
          </div>

          {/* Live Fleet Monitor */}
          <div
            style={{
              borderRadius: 16,
              overflow: "hidden",
              border: `1px solid ${C.border}`,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                background: C.surface,
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <span
                style={{
                  fontFamily: "Outfit,sans-serif",
                  fontWeight: 700,
                  fontSize: 14,
                  color: C.text,
                }}
              >
                Live Fleet Monitor
              </span>

              <LiveBadge small />
            </div>

            <MapView animateBus height={180} />
          </div>

          {/* Management Sections */}
          <div
            style={{
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 16,
              overflow: "hidden",
            }}
          >
            {sections.map((s, i) => (
              <button
                key={s.l}
                onClick={() => onNav(s.target)}
                className="admin-section-row"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "18px 20px",
                  background: C.surface,
                  border: "none",
                  borderBottom:
                    i < sections.length - 1
                      ? `1px solid ${C.border}`
                      : "none",
                  cursor: "pointer",
                  textAlign: "left",
                  animation: `adminFadeUp 0.4s ease ${0.15 + i * 0.08
                    }s both`,
                }}
              >
                {/* Left side */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    minWidth: 0,
                  }}
                >
                  {/* Icon */}
                  <div
                    className="admin-section-icon"
                    style={{
                      width: 46,
                      height: 46,
                      minWidth: 46,
                      borderRadius: 12,
                      background: `${s.color}15`,
                      color: s.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      animation: `iconPop 0.4s ease ${0.2 + i * 0.08
                        }s both`,
                    }}
                  >
                    {s.icon}
                  </div>

                  {/* Text */}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "Outfit,sans-serif",
                        fontSize: 16,
                        fontWeight: 700,
                        color: C.text,
                      }}
                    >
                      {s.l}
                    </div>

                    <div
                      style={{
                        fontFamily: "Inter,sans-serif",
                        fontSize: 11,
                        color: C.muted,
                        marginTop: 3,
                      }}
                    >
                      Manage {s.l.toLowerCase()}
                    </div>
                  </div>
                </div>

                {/* Right side */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginLeft: 12,
                  }}
                >
                  {s.badge && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: C.blue,
                        background: C.skyLight,
                        padding: "4px 9px",
                        borderRadius: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.badge}
                    </span>
                  )}

                  <span
                    style={{
                      color: C.muted,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    {Ic.chevron}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
      );
}

      // 16b ─ Admin: Add Bus Screen
      function AdminAddBusScreen({
        onNav,
        buses,
        stopsByRoute,
        onBack,
}: {
        onNav: (s: Screen) => void;
      buses: FireBus[];
      stopsByRoute: Record<string, FireRouteStop[]>;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<"buses" | "stops">("buses");

      // 1. Driver Details
      const [driverName, setDriverName] = useState("");
      const [driverEmail, setDriverEmail] = useState("");
      const [driverPassword, setDriverPassword] = useState("");
      const [showDriverPw, setShowDriverPw] = useState(false);
      const [driverPhone, setDriverPhone] = useState("");

      // 2. Bus Details
      const [r, setR] = useState("");
      const [n, setN] = useState("");
      const [lat, setLat] = useState("");
      const [lng, setLng] = useState("");

      // 3. Route Details
      const [routeName, setRouteName] = useState("");

      // Stops tab state
      const [routeCode, setRouteCode] = useState("");
      const [editableStops, setEditableStops] = useState<FireRouteStop[]>([]);
      const [stopsSaving, setStopsSaving] = useState(false);
      const [geocodingIndex, setGeocodingIndex] = useState<number | null>(null);

      // Splash & success celebration
      const [showSplash, setShowSplash] = useState(false);
      const [splashData, setSplashData] = useState<any>(null);

        function handleContinueToRouteStops() {
    if (!driverName.trim()) {
          window.alert("Please enter Driver Name.");
        return;
    }
        if (!driverEmail.trim()) {
          window.alert("Please enter Driver Email.");
        return;
    }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(driverEmail.trim())) {
          window.alert("Please enter a valid Driver Email (e.g. driver@rit.ac.in).");
        return;
    }
        if (!driverPassword.trim()) {
          window.alert("Please enter Email Password.");
        return;
    }
        if (driverPassword.trim().length < 6) {
          window.alert("Email Password must be at least 6 characters.");
        return;
    }
        if (!driverPhone.trim()) {
          window.alert("Please enter Phone Number.");
        return;
    }
        if (!r.trim()) {
          window.alert("Please enter Bus Number / Identifier (e.g. R24).");
        return;
    }
        if (!n.trim()) {
          window.alert("Please enter Bus Display Name (e.g. Bus R24).");
        return;
    }
        if (!routeName.trim()) {
          window.alert("Please enter Route Path (e.g. Arcot Bus Stand → RIT Campus).");
        return;
    }

        const code = r.trim();
        setRouteCode(code);

        const existingStops = stopsByRoute[code];
    if (existingStops && existingStops.length > 0) {
          setEditableStops(existingStops);
    } else if (editableStops.length === 0) {
      const parts = routeName.split(/\s*(?:→|->)\s*/);
        const originName = parts[0]?.trim() || "Start Stop";
        const destName = parts[1]?.trim() || "RIT Campus";
        setEditableStops([
        {
          name: originName,
        time: "7:00 AM",
        state: "upcoming",
        order: 0,
        lat: lat.trim() ? Number(lat) : undefined,
        lng: lng.trim() ? Number(lng) : undefined,
        },
        {
          name: destName,
        time: "8:15 AM",
        state: "upcoming",
        order: 1,
        lat: 12.9716,
        lng: 79.6083,
        },
        ]);
    }
        setTab("stops");
  }

        async function geocodeStop(i: number) {
    const query = editableStops[i]?.name?.trim();
        if (!query) return;
        setGeocodingIndex(i);
        try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ", Tamil Nadu, India")}`
        );
        const results = await res.json();
        if (results[0]) {
        const stopLat = Number(results[0].lat);
        const stopLng = Number(results[0].lon);
        setEditableStops((list) => list.map((s, idx) => (idx === i ? {...s, lat: stopLat, lng: stopLng } : s)));
      } else {
          window.alert(`Couldn't find "${query}" on the map. Try a more specific name, or enter coordinates manually.`);
      }
    } catch {
          window.alert("Couldn't reach the location lookup service right now — enter coordinates manually instead.");
    } finally {
          setGeocodingIndex(null);
    }
  }

        function updateStop(i: number, field: "name" | "time" | "lat" | "lng", value: string) {
          setEditableStops((list) =>
            list.map((s, idx) => {
              if (idx !== i) return s;
              if (field === "lat" || field === "lng") {
                return { ...s, [field]: value.trim() === "" ? undefined : Number(value) };
              }
              return { ...s, [field]: value };
            })
          );
  }

        function addEmptyStop() {
          setEditableStops((list) => [...list, { name: "", time: "", state: "upcoming", order: list.length }]);
  }

        async function handleSaveRouteStopsAndCreateBus() {
    const cleanStops = editableStops.filter((s) => s.name.trim());
        if (!cleanStops.length) {
          window.alert("Please add at least one route stop before creating the bus.");
        return;
    }

        setStopsSaving(true);
        try {
          // 1. Save route stops to Firestore
          await setRouteStops(routeCode.trim(), cleanStops);

        // 2. Create driver account credentials
        try {
          await createDriverAccount({
            name: driverName.trim(),
            email: driverEmail.trim().toLowerCase(),
            password: driverPassword.trim(),
          });
      } catch (drvErr: any) {
          console.warn("Driver creation note:", drvErr);
      }

        // 3. Create Bus in Firestore
        const firstStop = cleanStops[0];
        await addBus({
          n: n.trim(),
        r: r.trim(),
        routeName: routeName.trim(),
        stops: cleanStops.length,
        driverEmail: driverEmail.trim().toLowerCase(),
        lat: lat.trim() ? Number(lat) : firstStop?.lat,
        lng: lng.trim() ? Number(lng) : firstStop?.lng,
        eta: 15,
        live: false,
        dist: "—",
      });

        // 4. Trigger GPay splash celebration
        setSplashData({
          busName: n.trim(),
        routeCode: r.trim(),
        routeName: routeName.trim(),
        driverName: driverName.trim(),
        driverEmail: driverEmail.trim().toLowerCase(),
        stopsCount: cleanStops.length,
      });
        setShowSplash(true);
    } catch (err: any) {
          console.error("Failed to add bus:", err);
        window.alert("Failed to create bus: " + (err?.message || "Please check connection."));
    } finally {
          setStopsSaving(false);
    }
  }

        if (showSplash && splashData) {
    return (
        <GPaySuccessSplash
          busData={splashData}
          onDone={() => {
            setShowSplash(false);
            onBack();
          }}
        />
        );
  }

        return (
        <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
          <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
            <StatusBar />
            <TopBar
              title={tab === "stops" ? "Route Stops" : "Add Bus"}
              onBack={onBack}
            />
            {/* Only 2 tabs: Buses and Route Stops. DRIVERS page is removed as requested */}
            <div style={{ display: "flex", gap: 8, padding: "0 20px 14px" }}>
              {(["buses", "stops"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    if (t === "stops") {
                      handleContinueToRouteStops();
                    } else {
                      setTab("buses");
                    }
                  }}
                  style={{
                    flex: 1,
                    height: 38,
                    borderRadius: 10,
                    border: `1.5px solid ${tab === t ? C.blue : C.border}`,
                    background: tab === t ? C.skyLight : C.surface,
                    color: tab === t ? C.blue : C.sub,
                    fontFamily: "Outfit,sans-serif",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {t === "buses" ? "Buses" : "Route Stops"}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
            {tab === "buses" ? (
              <>
                {/* 1. Driver Details */}
                <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15, color: C.text, fontFamily: "Outfit,sans-serif", marginBottom: 12 }}>
                    <span>👨‍✈️</span> 1. Driver Details
                  </div>
                  <InputField label="Driver Name" placeholder="e.g. Ramesh Kumar" value={driverName} onChange={setDriverName} />
                  <InputField label="Driver Email" placeholder="driver@rit.ac.in" type="email" value={driverEmail} onChange={setDriverEmail} />
                  <InputField
                    label="Email Password"
                    placeholder="Min. 6 characters"
                    type={showDriverPw ? "text" : "password"}
                    value={driverPassword}
                    onChange={setDriverPassword}
                    suffix={
                      <button
                        type="button"
                        onClick={() => setShowDriverPw(!showDriverPw)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: C.sub, display: "flex", alignItems: "center" }}
                      >
                        {Ic.eye}
                      </button>
                    }
                  />
                  <InputField label="Phone Number" placeholder="+91 98765 43210" type="tel" value={driverPhone} onChange={setDriverPhone} />
                </div>

                {/* 2. Bus Details */}
                <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15, color: C.text, fontFamily: "Outfit,sans-serif", marginBottom: 12 }}>
                    <span>🚌</span> 2. Bus Details
                  </div>
                  <InputField label="Bus Number / Identifier" placeholder="e.g. R24" value={r} onChange={setR} />
                  <InputField label="Bus Display Name" placeholder="e.g. Bus R24" value={n} onChange={setN} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}><InputField label="Latitude" placeholder="e.g. 12.9716" type="number" value={lat} onChange={setLat} /></div>
                    <div style={{ flex: 1 }}><InputField label="Longitude" placeholder="e.g. 79.6083" type="number" value={lng} onChange={setLng} /></div>
                  </div>
                </div>

                {/* 3. Route Details */}
                <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15, color: C.text, fontFamily: "Outfit,sans-serif", marginBottom: 12 }}>
                    <span>🗺️</span> 3. Route Details
                  </div>
                  <InputField label="Route Path" placeholder="e.g. Arcot Bus Stand → RIT Campus" value={routeName} onChange={setRouteName} />
                </div>

                <PrimaryBtn label="Continue to Route Stops" onClick={handleContinueToRouteStops} />
              </>
            ) : (
              <>
                <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub, marginBottom: 6 }}>
                  Configuring stops for route <strong>{routeCode || r}</strong>:
                </div>
                <div style={{ fontSize: 11, color: C.muted, fontFamily: "Inter,sans-serif", marginBottom: 14 }}>
                  Enter each stop name and time. Tap "Find" to auto-lookup coordinates.
                </div>

                {editableStops.map((s, i) => (
                  <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <input
                        value={s.name}
                        onChange={(e) => updateStop(i, "name", e.target.value)}
                        placeholder="Stop name"
                        style={{ flex: 2, height: 40, borderRadius: 8, border: `1.5px solid ${C.border}`, padding: "0 10px", fontSize: 13, fontFamily: "Inter,sans-serif" }}
                      />
                      <input
                        value={s.time}
                        onChange={(e) => updateStop(i, "time", e.target.value)}
                        placeholder="7:10 AM"
                        style={{ flex: 1, height: 40, borderRadius: 8, border: `1.5px solid ${C.border}`, padding: "0 10px", fontSize: 13, fontFamily: "Inter,sans-serif" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        value={s.lat ?? ""}
                        onChange={(e) => updateStop(i, "lat", e.target.value)}
                        placeholder="Latitude"
                        type="number"
                        style={{ flex: 1, height: 38, borderRadius: 8, border: `1.5px solid ${C.border}`, padding: "0 10px", fontSize: 12, fontFamily: "Inter,sans-serif" }}
                      />
                      <input
                        value={s.lng ?? ""}
                        onChange={(e) => updateStop(i, "lng", e.target.value)}
                        placeholder="Longitude"
                        type="number"
                        style={{ flex: 1, height: 38, borderRadius: 8, border: `1.5px solid ${C.border}`, padding: "0 10px", fontSize: 12, fontFamily: "Inter,sans-serif" }}
                      />
                      <button
                        onClick={() => geocodeStop(i)}
                        disabled={!s.name.trim() || geocodingIndex === i}
                        style={{ flexShrink: 0, height: 38, padding: "0 12px", borderRadius: 8, border: "none", background: geocodingIndex === i ? C.muted : C.blue, color: "#fff", fontFamily: "Inter,sans-serif", fontWeight: 600, fontSize: 12, cursor: s.name.trim() ? "pointer" : "not-allowed" }}
                      >
                        {geocodingIndex === i ? "Finding…" : "📍 Find"}
                      </button>
                    </div>
                  </div>
                ))}

                <button
                  onClick={addEmptyStop}
                  style={{ width: "100%", height: 42, borderRadius: 10, border: `1.5px dashed ${C.border}`, background: "none", color: C.sub, fontFamily: "Inter,sans-serif", fontSize: 13, cursor: "pointer", marginBottom: 16 }}
                >
                  + Add Stop
                </button>

                <PrimaryBtn
                  label={stopsSaving ? "Saving…" : "Save Route Stops"}
                  onClick={handleSaveRouteStopsAndCreateBus}
                />
              </>
            )}
          </div>
        </div>
        );
}

        // 16c ─ Admin Drivers Screen
        function AdminDriversScreen({
          onNav,
          buses,
          onBack,
}: {
          onNav: (s: Screen) => void;
        buses: FireBus[];
  onBack: () => void;
}) {
  const [drivers, setDrivers] = useState<UserProfile[]>([]);
        const [newDriverName, setNewDriverName] = useState("");
        const [newDriverEmail, setNewDriverEmail] = useState("");
        const [newDriverPassword, setNewDriverPassword] = useState("");
        const [showDriverPw, setShowDriverPw] = useState(false);
        const [assignedBusForNewDriver, setAssignedBusForNewDriver] = useState("");
        const [driverSaving, setDriverSaving] = useState(false);
        const [driverError, setDriverError] = useState("");
        const [driverSuccess, setDriverSuccess] = useState("");

  useEffect(() => {
    const unsub = subscribeDrivers(setDrivers);
    return () => unsub();
  }, []);

        async function handleCreateDriver() {
    if (!newDriverName.trim() || !newDriverEmail.trim() || !newDriverPassword.trim()) {
          setDriverError("Please fill in Driver Name, College Email, and Password.");
        return;
    }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newDriverEmail.trim())) {
          setDriverError("Please enter a valid college email address.");
        return;
    }
        if (newDriverPassword.length < 6) {
          setDriverError("Password must be at least 6 characters.");
        return;
    }

        setDriverError("");
        setDriverSuccess("");
        setDriverSaving(true);

        try {
          await createDriverAccount({
            name: newDriverName.trim(),
            email: newDriverEmail.trim().toLowerCase(),
            password: newDriverPassword,
            busId: assignedBusForNewDriver || undefined,
          });

        setDriverSuccess(`Driver "${newDriverName.trim()}" created successfully!`);
        setNewDriverName("");
        setNewDriverEmail("");
        setNewDriverPassword("");
        setAssignedBusForNewDriver("");
    } catch (err: any) {
          console.error("Failed to create driver account:", err);
        setDriverError(err?.message || "Failed to create driver account.");
    } finally {
          setDriverSaving(false);
    }
  }

        return (
        <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
          <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
            <StatusBar />
            <TopBar title="Manage Drivers" onBack={onBack} />
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 4 }}>
                Register New Driver
              </div>
              <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginBottom: 14 }}>
                Create driver login credentials for the Driver App.
              </div>

              <InputField label="Driver Full Name" placeholder="e.g. Ramesh Kumar" value={newDriverName} onChange={setNewDriverName} />
              <InputField label="Driver College Email" placeholder="driver@rit.ac.in" type="email" value={newDriverEmail} onChange={setNewDriverEmail} />
              <InputField
                label="Driver Password"
                placeholder="Min. 6 characters"
                type={showDriverPw ? "text" : "password"}
                value={newDriverPassword}
                onChange={setNewDriverPassword}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowDriverPw(!showDriverPw)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.sub, display: "flex", alignItems: "center" }}
                  >
                    {Ic.eye}
                  </button>
                }
              />

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6 }}>
                  Assign to Fleet Bus (Optional)
                </div>
                <select
                  value={assignedBusForNewDriver}
                  onChange={(e) => setAssignedBusForNewDriver(e.target.value)}
                  style={{
                    width: "100%",
                    height: 48,
                    borderRadius: 10,
                    border: `1.5px solid ${C.border}`,
                    background: C.surface,
                    padding: "0 14px",
                    fontSize: 13,
                    fontFamily: "Inter,sans-serif",
                    color: C.text,
                    outline: "none",
                  }}
                >
                  <option value="">No bus assigned (can assign later)</option>
                  {buses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.n} ({b.r}) — {b.routeName}
                    </option>
                  ))}
                </select>
              </div>

              {driverError && (
                <div style={{ background: "#FFEBEE", color: "#C62828", padding: "10px 14px", borderRadius: 10, fontSize: 12, fontFamily: "Inter,sans-serif", marginBottom: 14, fontWeight: 500 }}>
                  ✕ {driverError}
                </div>
              )}

              {driverSuccess && (
                <div style={{ background: C.liveBg, color: C.live, padding: "10px 14px", borderRadius: 10, fontSize: 12, fontFamily: "Inter,sans-serif", marginBottom: 14, fontWeight: 500 }}>
                  ✓ {driverSuccess}
                </div>
              )}

              <PrimaryBtn
                label={driverSaving ? "Creating Driver Account…" : "Register Driver"}
                onClick={handleCreateDriver}
              />
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: "0.8px", marginBottom: 10 }}>
              REGISTERED DRIVERS ({drivers.length})
            </div>

            {drivers.length === 0 ? (
              <div style={{ color: C.sub, fontSize: 13, fontFamily: "Inter,sans-serif", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, textAlign: "center" }}>
                No driver accounts registered yet.
              </div>
            ) : (
              drivers.map((drv) => {
                const assignedBus = buses.find(
                  (b) => b.id === drv.assignedBusId || (b.driverEmail && b.driverEmail.toLowerCase() === drv.email.toLowerCase())
                );
                return (
                  <div key={drv.uid} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                      <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                        <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.text }}>
                          {drv.name || "Driver"}
                        </div>
                        <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginTop: 2, wordBreak: "break-all" }}>
                          ✉ {drv.email}
                        </div>
                        <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, marginTop: 4, color: assignedBus ? C.blue : C.muted, fontWeight: assignedBus ? 600 : 400 }}>
                          {assignedBus ? `🚌 ${assignedBus.n} (${assignedBus.r}) — ${assignedBus.routeName}` : "⚪ No bus assigned"}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 12, background: "#8E44AD18", color: "#8E44AD", flexShrink: 0 }}>
                        Driver
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        );
}

        // 17 ─ Admin Stop Requests
        function AdminStopRequests({onNav, requests}: {onNav: (s: Screen) => void; requests: FireStopRequest[] }) {
  const reqs = requests;

        function decide(id: string, s: "approved"|"rejected") {
          decideStopRequest(id, s).catch(console.error);
  }

        return (
        <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
          <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
            <StatusBar />
            <TopBar title="Stop Requests" onBack={() => onNav("admin-home")} />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
            {reqs.map((r, i) => (
              <div key={r.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden", marginBottom: 14, animation: `fadeUp 0.3s ${i * 0.08}s both` }}>
                <div style={{ height: 120, overflow: "hidden" }}>
                  <MapView animateBus={false} height={120} />
                </div>
                <div style={{ padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: "Inter,sans-serif", fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 3 }}>{r.loc}</div>
                      <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub }}>{r.route}</div>
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, marginLeft: 8, flexShrink: 0,
                      background: r.status === "approved" ? C.liveBg : r.status === "rejected" ? C.dangerBg : C.warnBg,
                      color: r.status === "approved" ? C.live : r.status === "rejected" ? C.danger : C.warn
                    }}>
                      {r.status === "approved" ? "✓ Approved" : r.status === "rejected" ? "✗ Rejected" : "● Pending"}
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <div style={{ background: C.skyLight, color: C.blue, borderRadius: 10, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>
                      {r.count} students
                    </div>
                  </div>

                  <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 12 }}>{r.reason}</div>

                  {r.status === "pending" ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => decide(r.id, "approved")} style={{ flex: 1, height: 40, borderRadius: 10, background: C.live, color: "#fff", border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Approve</button>
                      <button onClick={() => decide(r.id, "rejected")} style={{ flex: 1, height: 40, borderRadius: 10, background: C.dangerBg, color: C.danger, border: "none", fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Reject</button>
                    </div>
                  ) : (
                    <div style={{
                      textAlign: "center", padding: "10px", borderRadius: 10, fontWeight: 700, fontSize: 13,
                      background: r.status === "approved" ? C.liveBg : C.dangerBg,
                      color: r.status === "approved" ? C.live : C.danger
                    }}>
                      {r.status === "approved" ? "✓ Stop added to official route" : "✗ Request declined"}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        );
}

        // 18 ─ Google Pay Success Chime & Splash Screen
        function playGPaySuccessChime() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;

        // First note (pleasant D5 tone)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(587.33, now);
        gain1.gain.setValueAtTime(0.2, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.32);

        // Second higher note (triumphant A5 tone)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(880, now + 0.12);
        gain2.gain.setValueAtTime(0.26, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.68);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.68);
  } catch {
          // Autoplay policy or unsupported audio
        }
}

        function GPaySuccessSplash({
          title = "Datas Entered Successfully!",
          subtitle = "Fleet & driver details synchronized to live database",
          busData,
          onDone,
}: {
          title ?: string;
        subtitle?: string;
        busData: {
          busName: string;
        routeCode: string;
        routeName: string;
        driverName: string;
        driverEmail: string;
        stopsCount: number;
  };
  onDone: () => void;
}) {
          useEffect(() => {
            playGPaySuccessChime();
            const timer = setTimeout(() => {
              onDone();
            }, 4500);
            return () => clearTimeout(timer);
          }, [onDone]);

        return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "linear-gradient(180deg, #0b8043 0%, #076433 45%, #02381a 100%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "48px 24px 36px",
            overflowY: "auto",
            animation: "gpayFadeIn 0.3s ease-out both",
          }}
        >
          <style>{`
        @keyframes gpayFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes gpayScaleUp {
          0% { transform: scale(0.35); opacity: 0; }
          60% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes gpayRipple {
          0% { transform: scale(0.7); opacity: 0.85; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes gpayCheckDraw {
          0% { stroke-dashoffset: 48; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes gpayCardSlideUp {
          from { transform: translateY(32px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes gpaySparkle {
          0% { transform: translateY(0) scale(0.5); opacity: 0; }
          50% { opacity: 1; transform: translateY(-20px) scale(1.2); }
          100% { transform: translateY(-40px) scale(0.3); opacity: 0; }
        }
      `}</style>

          {/* Top Security & Verification Pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(255, 255, 255, 0.16)",
              backdropFilter: "blur(10px)",
              padding: "7px 16px",
              borderRadius: 22,
              color: "#ffffff",
              fontSize: 12,
              fontFamily: "Outfit, sans-serif",
              fontWeight: 700,
              letterSpacing: "0.5px",
            }}
          >
            <span>✓</span>
            <span>RIT FLEET VERIFIED</span>
          </div>

          {/* Center Animated Google Pay Style Celebration */}
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              margin: "24px 0 20px",
            }}
          >
            {/* Expanding Pulsing Waves */}
            <div
              style={{
                position: "absolute",
                width: 108,
                height: 108,
                borderRadius: "50%",
                background: "rgba(255, 255, 255, 0.28)",
                animation: "gpayRipple 2s cubic-bezier(0.1, 0.8, 0.3, 1) infinite",
              }}
            />
            <div
              style={{
                position: "absolute",
                width: 108,
                height: 108,
                borderRadius: "50%",
                background: "rgba(255, 255, 255, 0.18)",
                animation: "gpayRipple 2s cubic-bezier(0.1, 0.8, 0.3, 1) 0.65s infinite",
              }}
            />

            {/* Floating Sparkles & Confetti */}
            <div style={{ position: "absolute", top: -15, left: -28, color: "#FDE047", fontSize: 18, animation: "gpaySparkle 1.8s ease-in-out infinite" }}>✦</div>
            <div style={{ position: "absolute", top: -10, right: -28, color: "#67E8F9", fontSize: 16, animation: "gpaySparkle 1.8s ease-in-out 0.4s infinite" }}>★</div>
            <div style={{ position: "absolute", bottom: -8, left: -22, color: "#86EFAC", fontSize: 14, animation: "gpaySparkle 1.8s ease-in-out 0.8s infinite" }}>✦</div>
            <div style={{ position: "absolute", bottom: -12, right: -24, color: "#FFFFFF", fontSize: 16, animation: "gpaySparkle 1.8s ease-in-out 1.2s infinite" }}>★</div>

            {/* Central White Badge */}
            <div
              style={{
                width: 104,
                height: 104,
                borderRadius: "50%",
                background: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 14px 40px rgba(0, 0, 0, 0.35)",
                animation: "gpayScaleUp 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both",
                zIndex: 2,
              }}
            >
              {/* Animated SVG Checkmark */}
              <svg viewBox="0 0 48 48" width="58" height="58" fill="none">
                <circle cx="24" cy="24" r="22" fill="#0B8043" opacity="0.12" />
                <path
                  d="M14 24.5L21 31.5L34 17.5"
                  stroke="#0B8043"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    strokeDasharray: 48,
                    strokeDashoffset: 0,
                    animation: "gpayCheckDraw 0.55s 0.25s cubic-bezier(0.65, 0, 0.35, 1) both",
                  }}
                />
              </svg>
            </div>

            {/* Title & Subtitle */}
            <div
              style={{
                marginTop: 22,
                textAlign: "center",
                color: "#ffffff",
                animation: "gpayCardSlideUp 0.4s 0.3s ease both",
              }}
            >
              <div
                style={{
                  fontFamily: "Outfit, sans-serif",
                  fontWeight: 800,
                  fontSize: 24,
                  letterSpacing: "-0.4px",
                  textShadow: "0 2px 8px rgba(0,0,0,0.2)",
                }}
              >
                {title}
              </div>
              <div
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 13,
                  color: "rgba(255, 255, 255, 0.88)",
                  marginTop: 4,
                }}
              >
                {subtitle}
              </div>
            </div>
          </div>

          {/* GPay Style Receipt / Summary Card */}
          <div
            style={{
              width: "100%",
              maxWidth: 380,
              background: "rgba(255, 255, 255, 0.98)",
              borderRadius: 20,
              padding: "20px 22px",
              boxShadow: "0 16px 42px rgba(0, 0, 0, 0.28)",
              color: "#0D1B2A",
              animation: "gpayCardSlideUp 0.45s 0.35s ease both",
              marginBottom: 18,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px dashed #D1D5DB",
                paddingBottom: 12,
                marginBottom: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 11, fontFamily: "Outfit, sans-serif", fontWeight: 700, color: "#6B7280", letterSpacing: "0.8px" }}>
                  FLEET RECORD UPDATED
                </div>
                <div style={{ fontSize: 16, fontFamily: "Outfit, sans-serif", fontWeight: 800, color: "#0B8043" }}>
                  Bus & Route Synchronized
                </div>
              </div>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: "#E8F5E9",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                }}
              >
                🚌
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 13, fontFamily: "Inter, sans-serif" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#6B7280" }}>Bus Details</span>
                <span style={{ fontWeight: 700, color: "#111827", fontFamily: "Outfit, sans-serif" }}>
                  {busData.busName} ({busData.routeCode})
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#6B7280" }}>Driver Details</span>
                <span style={{ fontWeight: 600, color: "#111827", textAlign: "right", maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {busData.driverName ? `${busData.driverName}` : busData.driverEmail ? busData.driverEmail : "Unassigned"}
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#6B7280" }}>Route Details</span>
                <span style={{ fontWeight: 600, color: "#111827", textAlign: "right", maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {busData.routeName}
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#6B7280" }}>Total Stops</span>
                <span style={{ fontWeight: 600, color: "#111827" }}>
                  {busData.stopsCount} stops
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #F3F4F6", paddingTop: 9, marginTop: 2 }}>
                <span style={{ color: "#9CA3AF", fontSize: 11 }}>Status</span>
                <span style={{ color: "#0B8043", fontWeight: 700, fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                  ● Live in Cloud Firestore
                </span>
              </div>
            </div>
          </div>

          {/* Done Button */}
          <div style={{ width: "100%", maxWidth: 380, animation: "gpayCardSlideUp 0.5s 0.45s ease both" }}>
            <button
              onClick={onDone}
              style={{
                width: "100%",
                height: 52,
                borderRadius: 26,
                background: "#ffffff",
                color: "#0B8043",
                border: "none",
                fontFamily: "Outfit, sans-serif",
                fontWeight: 800,
                fontSize: 16,
                cursor: "pointer",
                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
                transition: "all 0.2s ease",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
              onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
              onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            >
              <span>Done</span>
              <span style={{ fontSize: 14 }}>➔</span>
            </button>
          </div>
        </div>
        );
}

// 19 ─ Dedicated Edit Bus Screen (Show available buses, click to edit)
function AdminEditBusScreen({
  buses,
  initialBus,
  stopsByRoute,
  onBack,
  onNav,
}: {
  buses: FireBus[];
  initialBus?: FireBus | null;
  stopsByRoute: Record<string, FireRouteStop[]>;
  onBack: () => void;
  onNav?: (s: Screen) => void;
}) {
  const [selectedBus, setSelectedBus] = useState<FireBus | null>(initialBus ?? null);

  useEffect(() => {
    if (initialBus) setSelectedBus(initialBus);
  }, [initialBus]);

  // If no bus selected yet, SHOW ALL THE AVAILABLE BUSES!
  if (!selectedBus) {
    return (
      <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          <StatusBar />
          <TopBar title="Edit Buses" onBack={onBack} />
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, color: C.text }}>
              Available Buses ({buses.length})
            </div>
            <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginTop: 4 }}>
              Click on the bus you want to edit its driver, bus details, or route information.
            </div>
          </div>

          {buses.length === 0 ? (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24, textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🚌</div>
              <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, color: C.text }}>
                No Buses Found
              </div>
              <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: C.sub, marginTop: 4, marginBottom: 16 }}>
                You have not added any buses yet. Add a bus first.
              </div>
              {onNav && (
                <button
                  onClick={() => onNav("admin-add-bus")}
                  style={{
                    padding: "10px 20px",
                    borderRadius: 10,
                    background: C.blue,
                    color: "#fff",
                    border: "none",
                    fontFamily: "Outfit,sans-serif",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  + Add Bus
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {buses.map((b) => (
                <div
                  key={b.id}
                  onClick={() => setSelectedBus(b)}
                  style={{
                    background: C.surface,
                    border: `1.5px solid ${C.border}`,
                    borderRadius: 14,
                    padding: 16,
                    cursor: "pointer",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          fontFamily: "Outfit,sans-serif",
                          fontWeight: 800,
                          fontSize: 13,
                          color: C.blue,
                          background: C.skyLight,
                          padding: "3px 8px",
                          borderRadius: 6,
                        }}
                      >
                        {b.r}
                      </span>
                      <span style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text }}>
                        {b.n}
                      </span>
                    </div>
                    {b.live ? <LiveBadge small /> : <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>OFFLINE</span>}
                  </div>

                  <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, color: C.sub, marginBottom: 4 }}>
                    📍 {b.routeName}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                    <div style={{ fontFamily: "Inter,sans-serif", fontSize: 12, color: b.driverEmail ? C.text : C.muted }}>
                      👨‍✈️ {b.driverEmail || "No driver assigned"}
                    </div>
                    <span style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 12, color: C.blue, display: "flex", alignItems: "center", gap: 4 }}>
                      Edit Bus ✏️
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <AdminEditBusForm
      bus={selectedBus}
      stopsByRoute={stopsByRoute}
      onBack={() => setSelectedBus(null)}
      onSaved={() => setSelectedBus(null)}
    />
  );
}

function AdminEditBusForm({
  bus,
  stopsByRoute,
  onBack,
  onSaved,
}: {
  bus: FireBus;
  stopsByRoute: Record<string, FireRouteStop[]>;
  onBack: () => void;
  onSaved: (bus: FireBus) => void;
}) {
  const [tab, setTab] = useState<"bus" | "stops">("bus");
  const [drivers, setDrivers] = useState<UserProfile[]>([]);

  useEffect(() => {
    const unsub = subscribeDrivers(setDrivers);
    return () => unsub();
  }, []);

  // 1. Driver Details State
  const [driverEmail, setDriverEmail] = useState(bus.driverEmail || "");
  const [driverName, setDriverName] = useState("");
  const [driverPassword, setDriverPassword] = useState("");
  const [showDriverPw, setShowDriverPw] = useState(false);
  const [driverPhone, setDriverPhone] = useState("");

  // Sync driver display name if driver is in registered list
  useEffect(() => {
    if (!driverEmail.trim()) {
      setDriverName("");
      return;
    }
    const matched = drivers.find(
      (d) => d.email && d.email.toLowerCase() === driverEmail.trim().toLowerCase()
    );
    if (matched?.name && !driverName) {
      setDriverName(matched.name);
    }
  }, [driverEmail, drivers]);

  // 2. Bus Details State
  const [r, setR] = useState(bus.r || "");
  const [n, setN] = useState(bus.n || "");
  const [stops, setStops] = useState(String(bus.stops ?? stopsByRoute[bus.r]?.length ?? 0));
  const [lat, setLat] = useState(bus.lat != null ? String(bus.lat) : "");
  const [lng, setLng] = useState(bus.lng != null ? String(bus.lng) : "");
  const [direction, setDirection] = useState<TripDirection>(getTripDirection(bus));

  // 3. Route Details State
  const [routeName, setRouteName] = useState(bus.routeName || "");
  const [origin, setOrigin] = useState(() => {
    const parts = (bus.routeName || "").split(/\s*(?:→|->)\s*/);
    return parts[0] || stopsByRoute[bus.r]?.[0]?.name || "";
  });
  const [destination, setDestination] = useState(() => {
    const parts = (bus.routeName || "").split(/\s*(?:→|->)\s*/);
    return parts[1] || "RIT Campus";
  });
  const [eta, setEta] = useState(String(bus.eta ?? 15));

  // 4. Route Stops State
  const [editableStops, setEditableStops] = useState<FireRouteStop[]>(() => {
    const fromProps = stopsByRoute[bus.r];
    if (fromProps && fromProps.length > 0) {
      return fromProps.map((s, idx) => ({ ...s, order: s.order ?? idx }));
    }
    const parts = (bus.routeName || "").split(/\s*(?:→|->)\s*/);
    const originName = parts[0]?.trim() || "Start Stop";
    const destName = parts[1]?.trim() || "RIT Campus";
    return [
      {
        name: originName,
        time: "7:00 AM",
        state: "upcoming" as const,
        order: 0,
        lat: bus.lat,
        lng: bus.lng,
      },
      {
        name: destName,
        time: "8:15 AM",
        state: "upcoming" as const,
        order: 1,
        lat: 12.9716,
        lng: 79.6083,
      },
    ];
  });
  const [stopsSaving, setStopsSaving] = useState(false);
  const [stopsSuccessMsg, setStopsSuccessMsg] = useState("");
  const [geocodingIndex, setGeocodingIndex] = useState<number | null>(null);

  // Splash & saving state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showSplash, setShowSplash] = useState(false);
  const [splashData, setSplashData] = useState<any>(null);

  function handleOriginDestChange(newOrigin: string, newDest: string) {
    setOrigin(newOrigin);
    setDestination(newDest);
    if (newOrigin.trim() && newDest.trim()) {
      setRouteName(`${newOrigin.trim()} → ${newDest.trim()}`);
    }
  }

  function updateStop(i: number, field: "name" | "time" | "lat" | "lng", value: string) {
    setEditableStops((list) =>
      list.map((s, idx) => {
        if (idx !== i) return s;
        if (field === "lat" || field === "lng") {
          return { ...s, [field]: value.trim() === "" ? undefined : Number(value) };
        }
        return { ...s, [field]: value };
      })
    );
  }

  function addEmptyStop() {
    setEditableStops((list) => [
      ...list,
      { name: "", time: "", state: "upcoming", order: list.length },
    ]);
  }

  function removeStop(i: number) {
    setEditableStops((list) => list.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, order: idx })));
  }

  function moveStop(i: number, dir: "up" | "down") {
    setEditableStops((list) => {
      const targetIdx = dir === "up" ? i - 1 : i + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return list;
      const copy = [...list];
      const temp = copy[i];
      copy[i] = copy[targetIdx];
      copy[targetIdx] = temp;
      return copy.map((s, idx) => ({ ...s, order: idx }));
    });
  }

  async function geocodeStop(i: number) {
    const query = editableStops[i]?.name?.trim();
    if (!query) return;
    setGeocodingIndex(i);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ", Tamil Nadu, India")}`
      );
      const results = await res.json();
      if (results[0]) {
        const stopLat = Number(results[0].lat);
        const stopLng = Number(results[0].lon);
        setEditableStops((list) => list.map((s, idx) => (idx === i ? { ...s, lat: stopLat, lng: stopLng } : s)));
      } else {
        window.alert(`Couldn't find "${query}" on the map. Try a more specific name, or enter coordinates manually.`);
      }
    } catch {
      window.alert("Couldn't reach the location lookup service right now — enter coordinates manually instead.");
    } finally {
      setGeocodingIndex(null);
    }
  }

  async function handleSaveRouteStops() {
    const cleanStops = editableStops.filter((s) => s.name.trim());
    if (!cleanStops.length) {
      window.alert("Please provide at least one route stop name.");
      return;
    }
    const routeCode = r.trim() || bus.r;
    setStopsSaving(true);
    setStopsSuccessMsg("");
    try {
      await setRouteStops(routeCode, cleanStops);
      await updateBus(bus.id, { stops: cleanStops.length });
      setStops(String(cleanStops.length));
      setStopsSuccessMsg("Route stops saved successfully!");
      setTimeout(() => setStopsSuccessMsg(""), 3500);
    } catch (err: any) {
      console.error("Failed to save route stops:", err);
      window.alert("Failed to save stops: " + (err?.message || "Please check connection."));
    } finally {
      setStopsSaving(false);
    }
  }

  async function handleSave() {
    if (!n.trim() || !r.trim()) {
      setError("Please provide Bus Number and Bus Display Name.");
      return;
    }
    if (!routeName.trim()) {
      setError("Please enter a Route Name.");
      return;
    }
    if (driverEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(driverEmail.trim())) {
      setError("Please enter a valid driver email address.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const cleanEmail = driverEmail.trim().toLowerCase() || "";
      const cleanStops = editableStops.filter((s) => s.name.trim());
      const routeStopsCount = cleanStops.length > 0 ? cleanStops.length : (Number(stops) || stopsByRoute[r.trim()]?.length || 0);

      const payload: any = {
        n: n.trim(),
        r: r.trim(),
        routeName: routeName.trim(),
        stops: routeStopsCount,
        driverEmail: cleanEmail,
        direction,
        eta: Number(eta) || 10,
      };

      if (lat.trim()) payload.lat = Number(lat);
      if (lng.trim()) payload.lng = Number(lng);

      await updateBus(bus.id, payload);

      if (cleanStops.length > 0) {
        await setRouteStops(r.trim(), cleanStops).catch(console.warn);
      }

      // Link driver profile to this bus if driver exists
      if (cleanEmail) {
        const matched = drivers.find((d) => d.email.toLowerCase() === cleanEmail.toLowerCase());
        if (matched && matched.uid) {
          await updateUserProfile(matched.uid, { assignedBusId: bus.id }).catch(console.warn);
        }
      }

      setSplashData({
        busName: n.trim(),
        routeCode: r.trim(),
        routeName: routeName.trim(),
        driverName: driverName.trim(),
        driverEmail: cleanEmail,
        stopsCount: routeStopsCount,
      });

      setShowSplash(true);
    } catch (err: any) {
      console.error("Failed to update bus:", err);
      setError(err?.message || "Failed to update bus data. Please check connection.");
      setSaving(false);
    }
  }

  if (showSplash && splashData) {
    return (
      <GPaySuccessSplash
        busData={splashData}
        onDone={() => {
          setShowSplash(false);
          const cleanStops = editableStops.filter((s) => s.name.trim());
          onSaved({
            ...bus,
            n: n.trim(),
            r: r.trim(),
            routeName: routeName.trim(),
            driverEmail: driverEmail.trim().toLowerCase() || "",
            stops: cleanStops.length > 0 ? cleanStops.length : Number(stops) || 0,
          });
        }}
      />
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
      {/* Top Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <StatusBar />
        <TopBar title={tab === "stops" ? `Edit Route Stops` : "Edit Bus & Route"} onBack={onBack} />
        <div style={{ padding: "0 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: "Outfit,sans-serif",
                fontWeight: 800,
                fontSize: 13,
                color: C.blue,
                background: C.skyLight,
                padding: "3px 8px",
                borderRadius: 6,
              }}
            >
              {r || bus.r}
            </span>
            <span style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.text }}>
              {n || bus.n}
            </span>
          </div>
          {bus.live ? <LiveBadge small /> : <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>OFFLINE</span>}
        </div>

        {/* Tab switch */}
        <div style={{ display: "flex", gap: 8, padding: "0 20px 14px" }}>
          {(["bus", "stops"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                height: 38,
                borderRadius: 10,
                border: `1.5px solid ${tab === t ? C.blue : C.border}`,
                background: tab === t ? C.skyLight : C.surface,
                color: tab === t ? C.blue : C.sub,
                fontFamily: "Outfit,sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                transition: "all 0.15s ease",
              }}
            >
              {t === "bus" ? "🚌 Bus Details" : `📍 Route Stops (${editableStops.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Main Form Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 36px" }}>
        {tab === "bus" ? (
          <>
            {error && (
              <div
                style={{
                  background: C.dangerBg,
                  color: C.danger,
                  padding: "12px 14px",
                  borderRadius: 12,
                  fontSize: 13,
                  fontFamily: "Inter,sans-serif",
                  marginBottom: 16,
                  fontWeight: 500,
                }}
              >
                ✕ {error}
              </div>
            )}

            {/* ── 1. DRIVER DETAILS ── */}
            <div
              style={{
                background: C.surface,
                border: `1.5px solid ${C.border}`,
                borderRadius: 16,
                padding: 16,
                marginBottom: 16,
                boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "#8E44AD18",
                    color: "#8E44AD",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                  }}
                >
                  👨‍✈️
                </div>
                <div>
                  <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text }}>
                    1. Driver Details
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, fontFamily: "Inter,sans-serif" }}>
                    Select an enrolled driver or enter their college credentials.
                  </div>
                </div>
              </div>

              <InputField
                label="Driver Name"
                placeholder="e.g. Ramesh Kumar"
                value={driverName}
                onChange={setDriverName}
              />

              <InputField
                label="Driver Email"
                placeholder="driver@rit.ac.in"
                type="email"
                value={driverEmail}
                onChange={setDriverEmail}
              />

              <InputField
                label="Email Password"
                placeholder="Leave blank to keep existing password"
                type={showDriverPw ? "text" : "password"}
                value={driverPassword}
                onChange={setDriverPassword}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowDriverPw(!showDriverPw)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.sub, display: "flex", alignItems: "center" }}
                  >
                    {Ic.eye}
                  </button>
                }
              />

              <InputField
                label="Phone Number"
                placeholder="+91 98765 43210"
                type="tel"
                value={driverPhone}
                onChange={setDriverPhone}
              />
            </div>

            {/* ── 2. BUS DETAILS ── */}
            <div
              style={{
                background: C.surface,
                border: `1.5px solid ${C.border}`,
                borderRadius: 16,
                padding: 16,
                marginBottom: 16,
                boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: `${C.blue}18`,
                    color: C.blue,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                  }}
                >
                  🚌
                </div>
                <div>
                  <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text }}>
                    2. Bus Details
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, fontFamily: "Inter,sans-serif" }}>
                    Fleet identifier, display labels, and starting GPS position.
                  </div>
                </div>
              </div>

              <div style={{ height: 12 }} />

              <InputField
                label="Bus Identifier / Route Code"
                placeholder="e.g. R24"
                value={r}
                onChange={setR}
              />

              <InputField
                label="Bus Display Name"
                placeholder="e.g. Bus R24"
                value={n}
                onChange={setN}
              />

              <InputField
                label="Total Stops Count"
                placeholder="8"
                type="number"
                value={stops}
                onChange={setStops}
              />

              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <InputField
                    label="Latitude"
                    placeholder="12.9716"
                    type="number"
                    value={lat}
                    onChange={setLat}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <InputField
                    label="Longitude"
                    placeholder="79.6083"
                    type="number"
                    value={lng}
                    onChange={setLng}
                  />
                </div>
              </div>

              {/* Direction Selector */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6 }}>
                  Default Trip Direction
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setDirection("outbound")}
                    style={{
                      flex: 1,
                      height: 40,
                      borderRadius: 8,
                      border: `1.5px solid ${direction === "outbound" ? C.blue : C.border}`,
                      background: direction === "outbound" ? C.skyLight : C.surface,
                      color: direction === "outbound" ? C.blue : C.sub,
                      fontFamily: "Outfit,sans-serif",
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    Towards College (Outbound)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDirection("return")}
                    style={{
                      flex: 1,
                      height: 40,
                      borderRadius: 8,
                      border: `1.5px solid ${direction === "return" ? C.blue : C.border}`,
                      background: direction === "return" ? C.skyLight : C.surface,
                      color: direction === "return" ? C.blue : C.sub,
                      fontFamily: "Outfit,sans-serif",
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    From College (Return)
                  </button>
                </div>
              </div>
            </div>

            {/* ── 3. ROUTE DETAILS ── */}
            <div
              style={{
                background: C.surface,
                border: `1.5px solid ${C.border}`,
                borderRadius: 16,
                padding: 16,
                marginBottom: 16,
                boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "#16A08518",
                    color: "#16A085",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                  }}
                >
                  🗺️
                </div>
                <div>
                  <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text }}>
                    3. Route Details
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, fontFamily: "Inter,sans-serif" }}>
                    Route naming, origin, destination, and travel timings.
                  </div>
                </div>
              </div>

              <div style={{ height: 12 }} />

              <InputField
                label="Full Route Name"
                placeholder="e.g. Arcot Bus Stand → RIT Campus"
                value={routeName}
                onChange={setRouteName}
              />

              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <InputField
                    label="Origin Stop / Landmark"
                    placeholder="Arcot Bus Stand"
                    value={origin}
                    onChange={(val) => handleOriginDestChange(val, destination)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <InputField
                    label="Destination Stop"
                    placeholder="RIT Campus"
                    value={destination}
                    onChange={(val) => handleOriginDestChange(origin, val)}
                  />
                </div>
              </div>

              <InputField
                label="Estimated Trip Duration (minutes)"
                placeholder="15"
                type="number"
                value={eta}
                onChange={setEta}
              />
            </div>

            {/* Route Stops Banner & Quick Access */}
            <div
              style={{
                padding: "14px 16px",
                borderRadius: 14,
                background: C.surface,
                border: `1.5px solid ${C.border}`,
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 14, color: C.text }}>
                  📍 Route Stops ({editableStops.length} Checkpoints)
                </div>
                <div style={{ fontSize: 12, color: C.muted, fontFamily: "Inter,sans-serif", marginTop: 2 }}>
                  Edit stop checkpoints, timings, and GPS locations.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTab("stops")}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: C.skyLight,
                  color: C.blue,
                  border: `1.5px solid ${C.blue}`,
                  fontFamily: "Outfit,sans-serif",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Edit Stops ➔
              </button>
            </div>

            {/* Action Buttons */}
            <PrimaryBtn
              label={saving ? "Saving Changes…" : "Save Fleet Changes"}
              onClick={handleSave}
              icon={Ic.check}
            />

            <div style={{ height: 10 }} />

            <GhostBtn label="Cancel" onClick={onBack} />
          </>
        ) : (
          <>
            {stopsSuccessMsg && (
              <div
                style={{
                  background: C.liveBg,
                  color: C.live,
                  padding: "12px 14px",
                  borderRadius: 12,
                  fontSize: 13,
                  fontFamily: "Inter,sans-serif",
                  marginBottom: 16,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>✓</span> {stopsSuccessMsg}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 16, color: C.text }}>
                  Checkpoints for Route {r || bus.r}
                </div>
                <div style={{ fontSize: 11, color: C.muted, fontFamily: "Inter,sans-serif", marginTop: 2 }}>
                  Arrange stops in order. Tap "📍 Find" to auto-lookup coordinates.
                </div>
              </div>
              <button
                type="button"
                onClick={addEmptyStop}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: C.blue,
                  color: "#fff",
                  border: "none",
                  fontFamily: "Outfit,sans-serif",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                + Add Stop
              </button>
            </div>

            {editableStops.length === 0 ? (
              <div style={{ background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 12, padding: 24, textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📍</div>
                <div style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 15, color: C.text }}>No Route Stops Configured</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4, marginBottom: 14 }}>Add the first stop for this route.</div>
                <button
                  type="button"
                  onClick={addEmptyStop}
                  style={{ padding: "8px 16px", borderRadius: 8, background: C.blue, color: "#fff", border: "none", fontWeight: 600, fontSize: 12, cursor: "pointer" }}
                >
                  + Add First Stop
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
                {editableStops.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      background: C.surface,
                      border: `1.5px solid ${C.border}`,
                      borderRadius: 14,
                      padding: 14,
                      boxShadow: "0 2px 6px rgba(0,0,0,0.02)",
                    }}
                  >
                    {/* Stop Header Row */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: "50%",
                            background: i === 0 ? C.blue : i === editableStops.length - 1 ? C.live : C.skyLight,
                            color: i === 0 || i === editableStops.length - 1 ? "#fff" : C.blue,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: "Outfit,sans-serif",
                            fontWeight: 800,
                            fontSize: 12,
                          }}
                        >
                          {i + 1}
                        </span>
                        <span style={{ fontFamily: "Outfit,sans-serif", fontWeight: 700, fontSize: 13, color: C.text }}>
                          {i === 0 ? "Origin Stop" : i === editableStops.length - 1 ? "Final Destination" : `Checkpoint ${i + 1}`}
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          type="button"
                          title="Move Stop Up"
                          disabled={i === 0}
                          onClick={() => moveStop(i, "up")}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: `1px solid ${C.border}`,
                            background: C.surface,
                            color: i === 0 ? C.border : C.sub,
                            cursor: i === 0 ? "default" : "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                          }}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          title="Move Stop Down"
                          disabled={i === editableStops.length - 1}
                          onClick={() => moveStop(i, "down")}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: `1px solid ${C.border}`,
                            background: C.surface,
                            color: i === editableStops.length - 1 ? C.border : C.sub,
                            cursor: i === editableStops.length - 1 ? "default" : "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                          }}
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          title="Delete Stop"
                          onClick={() => removeStop(i)}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: "1px solid #FFCDD2",
                            background: "#FFEBEE",
                            color: "#D32F2F",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 13,
                            marginLeft: 4,
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {/* Stop Inputs */}
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <div style={{ flex: 2 }}>
                        <input
                          value={s.name}
                          onChange={(e) => updateStop(i, "name", e.target.value)}
                          placeholder="Stop name (e.g. Arcot Stand)"
                          style={{
                            width: "100%",
                            height: 40,
                            borderRadius: 8,
                            border: `1.5px solid ${C.border}`,
                            padding: "0 10px",
                            fontSize: 13,
                            fontFamily: "Inter,sans-serif",
                            color: C.text,
                            background: C.bg,
                          }}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <input
                          value={s.time}
                          onChange={(e) => updateStop(i, "time", e.target.value)}
                          placeholder="7:15 AM"
                          style={{
                            width: "100%",
                            height: 40,
                            borderRadius: 8,
                            border: `1.5px solid ${C.border}`,
                            padding: "0 10px",
                            fontSize: 13,
                            fontFamily: "Inter,sans-serif",
                            color: C.text,
                            background: C.bg,
                          }}
                        />
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        value={s.lat ?? ""}
                        onChange={(e) => updateStop(i, "lat", e.target.value)}
                        placeholder="Latitude (e.g. 12.90)"
                        type="number"
                        step="any"
                        style={{
                          flex: 1,
                          height: 36,
                          borderRadius: 8,
                          border: `1.5px solid ${C.border}`,
                          padding: "0 10px",
                          fontSize: 12,
                          fontFamily: "Inter,sans-serif",
                          color: C.text,
                          background: C.bg,
                        }}
                      />
                      <input
                        value={s.lng ?? ""}
                        onChange={(e) => updateStop(i, "lng", e.target.value)}
                        placeholder="Longitude (e.g. 79.33)"
                        type="number"
                        step="any"
                        style={{
                          flex: 1,
                          height: 36,
                          borderRadius: 8,
                          border: `1.5px solid ${C.border}`,
                          padding: "0 10px",
                          fontSize: 12,
                          fontFamily: "Inter,sans-serif",
                          color: C.text,
                          background: C.bg,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => geocodeStop(i)}
                        disabled={!s.name.trim() || geocodingIndex === i}
                        style={{
                          flexShrink: 0,
                          height: 36,
                          padding: "0 12px",
                          borderRadius: 8,
                          border: "none",
                          background: geocodingIndex === i ? C.muted : C.blue,
                          color: "#fff",
                          fontFamily: "Inter,sans-serif",
                          fontWeight: 600,
                          fontSize: 12,
                          cursor: s.name.trim() ? "pointer" : "not-allowed",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {geocodingIndex === i ? "Finding…" : "📍 Find"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={addEmptyStop}
              style={{
                width: "100%",
                height: 42,
                borderRadius: 10,
                border: `1.5px dashed ${C.blue}`,
                background: C.skyLight,
                color: C.blue,
                fontFamily: "Outfit,sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              + Add Another Stop
            </button>

            <PrimaryBtn
              label={stopsSaving ? "Saving Route Stops…" : `Save Route Stops (${editableStops.length})`}
              onClick={handleSaveRouteStops}
              icon={Ic.check}
            />

            <div style={{ height: 10 }} />

            <GhostBtn label="Switch Back to Bus Details" onClick={() => setTab("bus")} />
          </>
        )}
      </div>
    </div>
  );
}

            // ══════════════════════════════════════════════════════════════════════════════
            // APP SHELL
            // ══════════════════════════════════════════════════════════════════════════════
            export default function App() {
  const [screen, setScreen] = useState<Screen>("splash");
              const [role, setRole] = useState<Role>("student");
                const [key, setKey] = useState(0);
                const [selectedBusId, setSelectedBusId] = useState<string | null>(null);
                const [editingBus, setEditingBus] = useState<FireBus | null>(null);

                const [preferences, setPreferences] =
                useStoredState<Preferences>(
                  "rit-preferences",
                  {theme: "light", language: "en" }
                  );

  useEffect(() => {
    if (preferences.theme === "dark") {
                    document.documentElement.classList.add("theme-dark");
                  document.documentElement.setAttribute("data-theme", "dark");
    } else {
                    document.documentElement.classList.remove("theme-dark");
                  document.documentElement.setAttribute("data-theme", "light");
    }
  }, [preferences.theme]);

  const toggleTheme = () => {
                    setPreferences(p => ({ ...p, theme: p.theme === "dark" ? "light" : "dark" }));
  };

                  const [user, setUser] = useState<UserProfile>({
                    email: "",
                    name: "RIT Student",
                    role: "student",
  });
                    const [authError, setAuthError] = useState<string>("");

                      // Live Firestore data — subscribed only after user is authenticated.
                      const [busesRaw, setBusesRaw] = useState<FireBus[]>([]);
                      const [busLocations, setBusLocations] = useState<Record<string, { lat: number; lng: number }>>({ });
  // `buses` combines Firestore metadata (route, eta, driverEmail, live flag, ...)
  // with the live lat/lng coming from Supabase's bus_locations table. Every
  // other part of the app keeps using `buses` exactly as before.
  const buses = useMemo(() => {
    return busesRaw.map(bus => {
      const loc = busLocations[bus.id];
                        return loc ? {...bus, lat: loc.lat, lng: loc.lng } : bus;
    });
  }, [busesRaw, busLocations]);
                        const [stopsByRoute, setStopsByRoute] = useState<Record<string, FireRouteStop[]>>({ });
                          const [stopRequests, setStopRequests] = useState<FireStopRequest[]>([]);
                          const routeSubs = useRef<Record<string, () => void>>({ });
                            const previousBuses = useRef<FireBus[] | null>(null);
                            const previousStopRequests = useRef<FireStopRequest[] | null>(null);
                            const {position: myPosition } = useGeolocation();

  // Authentication state is exclusively driven by onAuthStateChanged
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
                              setUser({
                                email: "",
                                name: "RIT Student",
                                role: "student",
                              });
                            setRole("student");
        setScreen((curr) => (curr === "splash" ? "splash" : "login"));
                            return;
      }

                            try {
        const profile = await getUserProfile(firebaseUser.uid);
                            if (!profile) {
                              console.warn("No user profile found in users/{uid} for UID:", firebaseUser.uid);
                            await signOut(auth);
                            setAuthError("No user profile found for this account. Please contact an administrator.");
                            setUser({email: "", name: "RIT Student", role: "student" });
                            setRole("student");
                            setScreen("login");
                            return;
        }

                            if (!["student", "driver", "admin"].includes(profile.role)) {
                              console.warn("Invalid role in users/{uid}:", (profile as any).role);
                            await signOut(auth);
                            setAuthError(`Invalid account role "${(profile as any).role}". Please contact an administrator.`);
                            setUser({email: "", name: "RIT Student", role: "student" });
                            setRole("student");
                            setScreen("login");
                            return;
        }

                            const verifiedUser: UserProfile = {
                              uid: firebaseUser.uid,
                            email: firebaseUser.email || profile.email || "",
                            name: profile.name || firebaseUser.displayName || nameFromEmail(firebaseUser.email || ""),
                            role: profile.role,
                            assignedBusId: profile.assignedBusId,
        };

                            setAuthError("");
                            setUser(verifiedUser);
                            setRole(profile.role);

        setScreen((curr) => {
          if (curr === "splash") {
            return "splash";
          }
                            const storedScreen = localStorage.getItem("rit-screen") as Screen | null;
                            const target = (curr !== "login" ? curr : storedScreen) || "";

                            if (profile.role === "driver") {
            const driverScreens: Screen[] = ["driver-home", "driver-start", "driver-live", "profile", "settings"];
                            return driverScreens.includes(target as Screen) ? (target as Screen) : "driver-home";
          } else if (profile.role === "admin") {
            const adminScreens: Screen[] = ["admin-home", "admin-stops", "admin-manage", "admin-drivers", "admin-add-bus", "admin-edit-bus", "profile", "settings"];
            return adminScreens.includes(target as Screen) ? (target as Screen) : "admin-home";
          } else {
            const studentScreens: Screen[] = [
                            "student-home", "live-map", "bus-details", "route-stops",
                            "find-bus", "stop-here", "make-stop", "notifications",
                            "my-trips", "profile", "settings"
                            ];
                            return studentScreens.includes(target as Screen) ? (target as Screen) : "student-home";
          }
        });
      } catch (err: any) {
                              console.error("Error loading user profile:", err);
                            await signOut(auth);
                            setAuthError("Failed to load user profile. Please check your network connection.");
                            setUser({email: "", name: "RIT Student", role: "student" });
                            setRole("student");
                            setScreen("login");
      }
    });

    return () => unsubscribe();
  }, []);

  const busesWithDistance = useMemo(() => {
    // Student distance is always calculated from the student's live GPS
    // position directly to the live bus position. It does NOT use the nearest
    // route stop, stop time, or admin-entered stop distance.
    if (!myPosition) return buses;
                            const studentPosition = {lat: myPosition.coords.latitude, lng: myPosition.coords.longitude };

    return buses.map(bus => {
      if (!validCoordinate(bus.lat) || !validCoordinate(bus.lng)) return bus;
                            const meters = distanceMeters(studentPosition, {lat: bus.lat, lng: bus.lng });
                            return {...bus, dist: formatDistance(meters) };
    });
  }, [buses, myPosition]);

  // Subscribe to buses and Supabase locations only when authenticated
  useEffect(() => {
    if (!user.email) {
                              setBusesRaw([]);
                            return;
    }
                            const unsubBuses = subscribeBuses(setBusesRaw);
    const unsubLocations = subscribeBusLocations((busId, lat, lng) => {
                              setBusLocations(prev => ({ ...prev, [busId]: { lat, lng } }));
    });
    return () => {
                              unsubBuses();
                            unsubLocations();
      Object.values(routeSubs.current).forEach((unsub) => unsub());
                            routeSubs.current = { };
    };
  }, [user.email]);

  // Subscribe to stopRequests with role-appropriate scoping to obey Firestore rules
  useEffect(() => {
    if (!user.email) {
                              setStopRequests([]);
                            return;
    }
                            if (role === "admin") {
      return subscribeStopRequests(setStopRequests);
    } else if (role === "driver") {
      return subscribeStopRequestsForDriver(user.email, setStopRequests);
    } else {
                              setStopRequests([]);
    }
  }, [user.email, role]);

  useEffect(() => {
    const previous = previousBuses.current;
                            previousBuses.current = buses;
                            if (!previous || !("Notification" in window) || Notification.permission !== "granted") return;

    buses.forEach(bus => {
      const oldBus = previous.find(item => item.id === bus.id);
                            if (!oldBus || oldBus.live === bus.live) return;
                            try {
                              new Notification(bus.live ? `${bus.r} trip started` : `${bus.r} trip ended`, {
                                body: bus.live ? `${bus.routeName} is now live.` : `${bus.routeName} is no longer live.`,
                                icon: ritLogo,
                              });
      } catch (err) {
                              console.warn("Notification unsupported on this browser", err);
      }
    });
  }, [buses]);

                            // Which bus (if any) the currently logged-in driver is assigned to.
                            const assignedBus = buses.find(
    (b) => b.driverEmail && user.email && b.driverEmail.toLowerCase() === user.email.toLowerCase()
                            );

                            // Trip/tracking state lives here (not inside a screen) so GPS keeps running
                            // while the driver navigates between screens or the app is in the background.
                            const [tripActive, setTripActive] = useState<boolean>(() => {
    try { return !!localStorage.getItem("rit-active-trip"); } catch { return false; }
  });
                              const driverPosition = useDriverBackgroundLocation(
                              assignedBus?.id ?? "",
                              role === "driver" && tripActive && !!assignedBus
                              );

  // Notify the currently logged-in driver when a student shares a location.
  useEffect(() => {
    const previous = previousStopRequests.current;
                              previousStopRequests.current = stopRequests;
                              if (!previous || role !== "driver" || !assignedBus) return;

    const oldIds = new Set(previous.map(r => String((r as any).id ?? "")));
    stopRequests.forEach(request => {
      const data = request as any;
                              const isLocationShare = data.kind === "student-location" && data.locationShared === true;
                              const matchesDriver = data.targetDriverEmail && assignedBus.driverEmail && data.targetDriverEmail.toLowerCase() === assignedBus.driverEmail.toLowerCase();
                              const matchesRoute = data.route === assignedBus.r;
                              if (isLocationShare && matchesDriver && matchesRoute && !oldIds.has(String(data.id ?? "")) && "Notification" in window && Notification.permission === "granted") {
        try {
                                new Notification("Student location shared", {
                                  body: `${data.studentName || "A student"} shared a pickup location for ${assignedBus.r}.`,
                                  icon: ritLogo,
                                });
        } catch (err) {
                                console.warn("Notification unsupported on this browser", err);
        }
      }
    });
  }, [stopRequests, role, assignedBus]);

  // Every route currently in use gets its own live stop-list subscription —
  // added when a bus first uses that route, removed if no bus uses it anymore.
  useEffect(() => {
    const routeCodes = Array.from(new Set(buses.map((b) => b.r).filter(Boolean)));

    routeCodes.forEach((code) => {
      if (!routeSubs.current[code]) {
                                routeSubs.current[code] = subscribeRouteStops(code, (stops) => {
                                  setStopsByRoute((prev) => ({ ...prev, [code]: stops }));
                                });
      }
    });

    Object.keys(routeSubs.current).forEach((code) => {
      if (!routeCodes.includes(code)) {
                                routeSubs.current[code]();
                              delete routeSubs.current[code];
        setStopsByRoute((prev) => {
          const next = {...prev};
                              delete next[code];
                              return next;
        });
      }
    });
  }, [buses]);

  const selectedBus = busesWithDistance.find((bus) => bus.id === selectedBusId);

  // Restore only the bus explicitly selected by the student. Never default
  // to buses[0], because that makes the first bus look permanently selected.
  useEffect(() => {
    if (!selectedBusId) {
      try {
        const stored = sessionStorage.getItem("selectedBusId");
        if (stored && buses.some(b => b.id === stored)) {
                                setSelectedBusId(stored);
        }
      } catch { }
                              return;
    }

    if (buses.length && !buses.some(b => b.id === selectedBusId)) {
                                setSelectedBusId(null);
                              try {sessionStorage.removeItem("selectedBusId"); } catch { }
    }
  }, [buses, selectedBusId]);

                              function nav(to: Screen) {
                                setKey((k) => k + 1);
                              setScreen(to);
                              localStorage.setItem("rit-screen", to);
  }

                              async function logout() {
    if (assignedBus?.id && tripActive) {
                                await setBusLive(assignedBus.id, false).catch(console.error);
    }
                              setTripActive(false);
                              try {localStorage.removeItem("rit-active-trip"); } catch { }
                              try {localStorage.removeItem("rit-screen"); } catch { }
                              try {localStorage.removeItem("rit-user"); } catch { }
                              try {
                                await signOut(auth);
    } catch (err) {
                                console.error("Error signing out:", err);
    }
                              setUser({
                                email: "",
                              name: "RIT Student",
                              role: "student",
    });
                              setRole("student");
                              nav("login");
  }

                              return (
                              <ThemeContext.Provider value={{ theme: preferences.theme, toggleTheme }}>
                                <div
                                  className={
                                    preferences.theme === "dark"
                                      ? "theme-dark"
                                      : ""
                                  }
                                  style={{
                                    position: "fixed",
                                    inset: 0,
                                    background: C.bg,
                                    overflow: "hidden"
                                  }}
                                >
                                  <div
                                    key={key}
                                    style={{
                                      position: "absolute",
                                      inset: 0,
                                      animation:
                                        "screenEnter 0.28s cubic-bezier(0.4,0,0.2,1) both"
                                    }}
                                  >
                                    {screen === "splash" && (
                                      <SplashScreen
                                        onDone={() => {
                                          if (user.email) {
                                            const home: Screen = role === "driver" ? "driver-home" : role === "admin" ? "admin-home" : "student-home";
                                            nav(home);
                                          } else {
                                            nav("login");
                                          }
                                        }}
                                      />
                                    )}

                                    {screen === "login" && (
                                      <LoginScreen
                                        authError={authError}
                                        onClearAuthError={() => setAuthError("")}
                                      />
                                    )}

                                    {screen === "student-home" && (
                                      <StudentHome
                                        onNav={nav}
                                        user={user}
                                        buses={busesWithDistance}
                                        stopsByRoute={stopsByRoute}
                                        onSelectBus={setSelectedBusId}
                                      />
                                    )}

                                    {screen === "live-map" && (
                                      <LiveMapScreen onNav={nav} buses={buses} stopsByRoute={stopsByRoute} selectedBus={selectedBus} />
                                    )}

                                    {screen === "bus-details" && (
                                      <BusDetailsScreen onNav={nav} selectedBus={selectedBus} stopsByRoute={stopsByRoute} />
                                    )}


                                    {screen === "route-stops" && (
                                      <RouteStopsScreen
                                        onNav={nav}
                                        buses={busesWithDistance}
                                        stopsByRoute={stopsByRoute}
                                        assignedBus={assignedBus}
                                        selectedBus={selectedBus}
                                        backTo={role === "driver" ? "driver-home" : "student-home"}
                                      />
                                    )}


                                    {screen === "find-bus" && (
                                      <FindBusScreen onNav={nav} buses={busesWithDistance} onSelectBus={setSelectedBusId} />
                                    )}

                                    {screen === "stop-here" && (
                                      <StopHereScreen onNav={nav} selectedBus={selectedBus} user={user} />
                                    )}

                                    {screen === "make-stop" && (
                                      <MakeStopScreen onNav={nav} selectedBus={selectedBus} user={user} />
                                    )}

                                    {screen === "notifications" && (
                                      <NotificationsScreen onNav={nav} />
                                    )}

                                    {screen === "my-trips" && (
                                      <MyTripsScreen onNav={nav} />
                                    )}

                                    {screen === "profile" && (
                                      <ProfileScreen
                                        onNav={nav}
                                        onLogout={logout}
                                        user={user}
                                        language={preferences.language}
                                      />
                                    )}

                                    {screen === "settings" && (
                                      <SettingsScreen
                                        onNav={nav}
                                        preferences={preferences}
                                        setPreferences={setPreferences}
                                      />
                                    )}

                                    {screen === "driver-home" && (
                                      <DriverHome onNav={nav} onLogout={logout} user={user} assignedBus={assignedBus} />
                                    )}

                                    {screen === "driver-start" && (
                                      <DriverStartTrip onNav={nav} assignedBus={assignedBus} onTripStart={() => setTripActive(true)} />
                                    )}

                                    {screen === "driver-live" && (
                                      <DriverLiveScreen onNav={nav} busId={assignedBus?.id ?? ""} stopsByRoute={stopsByRoute} assignedBus={assignedBus} requests={stopRequests} position={driverPosition} onTripEnd={() => setTripActive(false)} />
                                    )}

                                    {screen === "admin-home" && (
                                      <AdminDashboard
                                        onNav={nav}
                                        onLogout={logout}
                                        buses={buses}
                                        onEditBus={(bus) => {
                                          setEditingBus(bus);
                                          nav("admin-edit-bus");
                                        }}
                                      />
                                    )}

        {(screen === "admin-add-bus" || screen === "admin-manage") && (
          <AdminAddBusScreen
            onNav={nav}
            buses={buses}
            stopsByRoute={stopsByRoute}
            onBack={() => nav("admin-home")}
          />
        )}

        {screen === "admin-drivers" && (
          <AdminDriversScreen
            onNav={nav}
            buses={buses}
            onBack={() => nav("admin-home")}
          />
        )}

        {screen === "admin-stops" && (
          <AdminStopRequests onNav={nav} requests={stopRequests} />
        )}

        {screen === "admin-edit-bus" && (
          <AdminEditBusScreen
            buses={buses}
            initialBus={editingBus}
            stopsByRoute={stopsByRoute}
            onBack={() => {
              setEditingBus(null);
              nav("admin-home");
            }}
            onNav={nav}
          />
        )}
      </div>
    </div>
  </ThemeContext.Provider>
                              );
}