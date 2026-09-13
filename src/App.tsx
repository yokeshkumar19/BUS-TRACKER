import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import ritLogo from "@/imports/Logo2.jpeg";
import {
  FireBus,
  FireRouteStop,
  FireStopRequest,
  subscribeBuses,
  subscribeRouteStops,
  subscribeStopRequests,
  addBus,
  updateBus,
  deleteBus,
  setRouteStops,
  updateBusLocation,
  setBusLive,
  addStopRequest,
  shareStudentLocation,
  stopSharingStudentLocation,
  decideStopRequest,
} from "./firestoreService";

type Screen =
  | "splash" | "login"
  | "student-home" | "live-map" | "bus-details" | "route-stops"
  | "find-bus" | "stop-here" | "make-stop" | "notifications" | "my-trips" | "profile"
  | "settings"
  | "driver-home" | "driver-start" | "driver-live"
  | "admin-home" | "admin-stops" | "admin-manage";

type Role = "student" | "driver" | "admin";
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
type UserProfile = { email: string; name: string; role: Role };

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
  navy:    "#0D1B2A",
  blue:    "#1565C0",
  blueMid: "#1976D2",
  sky:     "#0288D1",
  skyLight:"#E1F0FA",
  live:    "#1B8C3E",
  liveBg:  "#E8F5EE",
  warn:    "#C84B11",
  warnBg:  "#FEF0E8",
  border:  "#E4E9F0",
  bg:      "#F7F9FC",
  surface: "#FFFFFF",
  text:    "#0D1B2A",
  sub:     "#4A5568",
  muted:   "#8A96A3",
};

// ── Tiny icon set ─────────────────────────────────────────────────────────────
const Ic = {
  home:    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>,
  map:     <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg>,
  bus:     <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>,
  bell:    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>,
  person:  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>,
  search:  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>,
  pin:     <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>,
  back:    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M10 17l5-5-5-5v10z"/></svg>,
  check:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M20 6L9 17l-5-5"/></svg>,
  eye:     <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>,
  play:    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M8 5v14l11-7z"/></svg>,
  speed:   <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/></svg>,
  close:   <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>,
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
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 16px 12px" }}>
      <button onClick={onBack} style={{ width:36, height:36, borderRadius:10, border:`1px solid ${C.border}`, background:C.surface, display:"flex", alignItems:"center", justifyContent:"center", color:C.text, cursor:"pointer" }}>
        {Ic.back}
      </button>
      <span style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:16, color:C.text }}>{title}</span>
      <div style={{ width:36 }}>{rightEl}</div>
    </div>
  );
}

function LiveBadge({ small }: { small?: boolean }) {
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, background:C.liveBg, color:C.live, borderRadius:20, padding: small ? "2px 8px" : "3px 10px", fontSize: small ? 10 : 11, fontWeight:700, letterSpacing:"0.3px" }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:C.live, display:"inline-block", animation:"livePulse 1.4s ease-in-out infinite" }}/>
      LIVE
    </span>
  );
}

function PrimaryBtn({ label, onClick, icon }: { label: string; onClick: () => void; icon?: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ width:"100%", height:50, borderRadius:12, background:C.blue, color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"opacity 0.15s" }}
      onMouseDown={e => (e.currentTarget.style.opacity="0.85")} onMouseUp={e => (e.currentTarget.style.opacity="1")} onTouchStart={e => (e.currentTarget.style.opacity="0.85")} onTouchEnd={e => (e.currentTarget.style.opacity="1")}>
      {icon}{label}
    </button>
  );
}

function GhostBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width:"100%", height:50, borderRadius:12, background:"transparent", color:C.blue, border:`1.5px solid ${C.blue}`, fontFamily:"Outfit,sans-serif", fontWeight:600, fontSize:15, cursor:"pointer" }}>
      {label}
    </button>
  );
}

function InputField({ label, placeholder, type="text", value, onChange, suffix }: { label: string; placeholder: string; type?: string; value: string; onChange: (v: string) => void; suffix?: React.ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom:16 }}>
      <div style={{ fontSize:12, fontWeight:600, color:C.sub, marginBottom:6, letterSpacing:"0.2px" }}>{label}</div>
      <div style={{ display:"flex", alignItems:"center", border:`1.5px solid ${focused ? C.blue : C.border}`, borderRadius:10, height:48, padding:"0 14px", background:C.surface, gap:8, transition:"border-color 0.2s" }}>
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          style={{ flex:1, border:"none", outline:"none", fontSize:15, color:C.text, background:"transparent", fontFamily:"Inter,sans-serif" }}/>
        {suffix}
      </div>
    </div>
  );
}

function BottomNav({ active, onNav }: { active: string; onNav: (s: Screen) => void }) {
  const tabs = [
    { id:"student-home", label:"Home",    icon:Ic.home   },
    { id:"live-map",     label:"Map",     icon:Ic.map    },
    { id:"my-trips",     label:"Trips",   icon:Ic.bus    },
    { id:"notifications",label:"Alerts",  icon:Ic.bell   },
    { id:"profile",      label:"Profile", icon:Ic.person },
  ] as const;
  return (
    <div style={{ position:"absolute", bottom:0, left:0, right:0, background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", padding:"6px 0 20px" }}>
      {tabs.map(t => {
        const on = active === t.id;
        return (
          <button key={t.id} onClick={() => onNav(t.id as Screen)} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3, border:"none", background:"none", cursor:"pointer", color: on ? C.blue : C.muted, padding:"4px 0" }}>
            {t.icon}
            <span style={{ fontSize:10, fontWeight: on ? 700 : 500, fontFamily:"Inter,sans-serif" }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Map Canvas ────────────────────────────────────────────────────────────────
function MockMapView({ animateBus = true, height = 280 }: { animateBus?: boolean; height?: number }) {
  const [t, setT] = useState(0.3);
  const { position, available } = useGeolocation();
  useEffect(() => {
    if (!animateBus) return;
    const id = setInterval(() => setT(p => (p + 0.002) % 1), 50);
    return () => clearInterval(id);
  }, [animateBus]);

  const pts: [number,number][] = [[30,200],[80,170],[140,145],[200,130],[255,140],[310,115],[360,95]];
  const seg = Math.floor(t * (pts.length-1));
  const frac = t * (pts.length-1) - seg;
  const p1 = pts[Math.min(seg, pts.length-1)];
  const p2 = pts[Math.min(seg+1, pts.length-1)];
  const bx = p1[0] + (p2[0]-p1[0])*frac;
  const by = p1[1] + (p2[1]-p1[1])*frac;
  const path = pts.map((p,i)=>`${i===0?"M":"L"}${p[0]},${p[1]}`).join(" ");

  return (
    <svg width="100%" height={height} viewBox={`0 0 390 ${height}`} preserveAspectRatio="xMidYMid slice" style={{ display:"block" }}>
      <rect width="390" height={height} fill="#ECF0E8"/>
      {/* Roads */}
      <rect x="0" y="85" width="390" height="22" fill="#D8DED4"/>
      <rect x="0" y="155" width="390" height="16" fill="#D8DED4"/>
      <rect x="75" y="0" width="18" height={height} fill="#D8DED4"/>
      <rect x="195" y="0" width="14" height={height} fill="#D8DED4"/>
      <rect x="305" y="0" width="12" height={height} fill="#D8DED4"/>
      {/* Blocks */}
      {[[16,20,50,58],[130,20,55,45],[230,25,65,48],[320,110,52,38],[20,185,48,60],[148,192,38,50],[260,175,50,45]].map(([x,y,w,h],i) =>
        <rect key={i} x={x} y={y} width={w} height={h} rx="3" fill="#C4CCBA" opacity="0.55"/>)}
      {/* Green parks */}
      <rect x="100" y="105" width="72" height="40" rx="6" fill="#B8D4A8" opacity="0.7"/>
      <rect x="218" y="172" width="55" height="55" rx="6" fill="#B8D4A8" opacity="0.7"/>

      {/* Route line */}
      <path d={path} fill="none" stroke={C.blue} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity="0.25"/>
      <path d={path} fill="none" stroke={C.blue} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="10 6"/>
      {/* Stops */}
      {pts.map((p,i) => (
        <g key={i}>
          <circle cx={p[0]} cy={p[1]} r="7" fill="#fff" stroke={C.blue} strokeWidth="2"/>
          <circle cx={p[0]} cy={p[1]} r="3" fill={i===3 ? C.live : C.blue}/>
        </g>
      ))}

      {/* Student location is shown only after the browser provides a real position. */}
      {position && (
        <g aria-label="Your current location">
          <circle cx="200" cy="195" r="16" fill={`${C.blue}1A`}/>
          <circle cx="200" cy="195" r="8" fill="#fff" stroke={C.blue} strokeWidth="2"/>
          <circle cx="200" cy="195" r="3.5" fill={C.blue}/>
        </g>
      )}

      {!position && !available && <text x="195" y="245" textAnchor="middle" fill={C.sub} fontSize="10" fontFamily="Inter">Location unavailable</text>}
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
      style={{ display:"block", border:0 }}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}

// Free, no-API-key map that plots real checkpoints (route stops) and the live
// bus position using OpenStreetMap tiles via Leaflet.
const stopDivIcon = (state: "done" | "current" | "upcoming") =>
  L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${
      state === "current" ? "#2ECC71" : state === "done" ? "#9AA5AE" : C.blue
    };border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.25)"></div>`,
    iconSize: [14, 14],
  });

const busDivIcon = L.divIcon({
  className: "",
  html: `<div style="font-size:22px;line-height:1;transform:translate(-3px,-3px)">🚌</div>`,
  iconSize: [22, 22],
});

const studentDivIcon = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#E53935;border:3px solid #fff;box-shadow:0 0 0 2px rgba(229,57,53,0.25)"></div>`,
  iconSize: [18, 18],
});

const ARRIVED_METERS = 150;

function withLiveStopStates(
  stops: FireRouteStop[],
  busPosition: { lat: number; lng: number } | null,
): FireRouteStop[] {
  if (!busPosition) return stops;

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  stops.forEach((s, i) => {
    if (s.lat == null || s.lng == null) return;
    const d = L.latLng(busPosition.lat, busPosition.lng).distanceTo([s.lat, s.lng]);
    if (d < nearestDistance) { nearestDistance = d; nearestIndex = i; }
  });
  if (nearestIndex === -1) return stops;

  const currentIndex = nearestDistance <= ARRIVED_METERS ? nearestIndex + 1 : nearestIndex;
  return stops.map((s, i) => ({
    ...s,
    state: i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming",
  }));
}


type SharedStudentLocation = {
  id: string;
  lat: number;
  lng: number;
  studentName?: string;
  studentEmail?: string;
};

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
  const plotted = stops.filter(s => typeof s.lat === "number" && typeof s.lng === "number");
  const routeKey = plotted.map(s => `${s.lat},${s.lng}`).join(";");
  const [routePath, setRoutePath] = useState<[number, number][]>([]);
  const midStop = plotted[Math.floor(plotted.length / 2)];
  const center = busPosition ?? (midStop ? { lat: midStop.lat!, lng: midStop.lng! } : { lat: 13.0072, lng: 79.6 });
  let nearestRouteIndex = -1;
  if (busPosition && routePath.length) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    routePath.forEach(([lat, lng], index) => {
      const distance = L.latLng(busPosition.lat, busPosition.lng).distanceTo([lat, lng]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestRouteIndex = index;
      }
    });
  }
 const remainingRoute = nearestRouteIndex >= 0
  ? routePath.slice(nearestRouteIndex)
  : [];

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
      <div style={{ width:"100%", height, display:"flex", alignItems:"center", justifyContent:"center", background:"#ECF0E8", color:C.sub, fontFamily:"Inter,sans-serif", fontSize:12 }}>
        No stop locations yet
      </div>
    );
  }

  return (
    <MapContainer center={[center.lat, center.lng]} zoom={12} style={{ width:"100%", height }} scrollWheelZoom={false}>
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
      {routePath.length > 1 && (
        <Polyline positions={routePath} color="#B8C2CC" weight={5} opacity={0.9} lineCap="round" lineJoin="round" />
      )}
      {remainingRoute.length > 1 && (
  <Polyline positions={remainingRoute} color={C.blue} weight={7} opacity={0.95} lineCap="round" lineJoin="round" />
)}
      {plotted.map((s, i) => (
        <Marker key={i} position={[s.lat!, s.lng!]} icon={stopDivIcon(s.state)}>
          <Popup>{s.name}</Popup>
        </Marker>
      ))}
      {busPosition && <Marker position={[busPosition.lat, busPosition.lng]} icon={busDivIcon}/>}
      {studentLocations.map(student => (
        <Marker key={student.id} position={[student.lat, student.lng]} icon={studentDivIcon}>
          <Popup>
            <strong>{student.studentName || "Student"}</strong>
            <br />Pickup location shared
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SCREENS
// ══════════════════════════════════════════════════════════════════════════════

// 1 ─ Splash
function SplashScreen({ onDone }: { onDone: () => void }) {
  const [show, setShow] = useState(false);
  const [out, setOut]   = useState(false);

  useEffect(() => {
    const t0 = setTimeout(() => setShow(true),  100);
    const t1 = setTimeout(() => setOut(true),  3000);
    const t2 = setTimeout(onDone,              3500);
    return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  return (
    <div style={{ position:"absolute", inset:0, background:C.navy, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", overflow:"hidden", opacity: out ? 0 : 1, transition:"opacity 0.5s ease" }}>
      {/* Subtle route lines in bg */}
      <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:0.07 }} preserveAspectRatio="none">
        <path d="M0 300 Q130 250 260 310 T390 280" stroke="#fff" strokeWidth="2" fill="none" strokeDasharray="12 8"/>
        <path d="M0 500 Q160 440 290 510 T390 470" stroke="#fff" strokeWidth="1.5" fill="none" strokeDasharray="8 10"/>
        <path d="M0 680 Q120 620 250 675 T390 640" stroke="#fff" strokeWidth="1" fill="none" strokeDasharray="6 12"/>
      </svg>

      {/* Logo */}
      <div style={{ opacity: show ? 1 : 0, transform: show ? "scale(1)" : "scale(0.82)", transition:"opacity 0.6s ease, transform 0.6s cubic-bezier(0.34,1.56,0.64,1)" }}>
        <div style={{ background:"#fff", borderRadius:14, padding:0, lineHeight:0, boxShadow:"0 8px 32px rgba(0,0,0,0.35)" }}>
          <img src={ritLogo} alt="RIT" style={{ width:240, height:"auto", display:"block", borderRadius:14 }}/>
        </div>
      </div>

      {/* Text */}
      <div style={{ marginTop:32, textAlign:"center", opacity: show ? 1 : 0, transform: show ? "translateY(0)" : "translateY(12px)", transition:"opacity 0.5s 0.25s ease, transform 0.5s 0.25s ease" }}>
        <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:26, color:"#fff", letterSpacing:"-0.3px" }}>RIT BusTrack</div>
        <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:"rgba(255,255,255,0.5)", marginTop:6, letterSpacing:"0.8px" }}>TRACK • PLAN • REACH ON TIME</div>
      </div>

      {/* Loader */}
      <div style={{ position:"absolute", bottom:52, display:"flex", gap:6, opacity: show ? 1 : 0, transition:"opacity 0.4s 0.5s" }}>
        {[0,1,2].map(i => (
          <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"rgba(255,255,255,0.5)", animation:`splashDot 0.9s ${i*0.18}s ease-in-out infinite`}}/>
        ))}
      </div>
    </div>
  );
}

// 2 ─ Login
function LoginScreen({ onLogin }: { onLogin: (r: Role, email: string) => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw]     = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  function submit() {
    if (!email.trim() || !pw) {
      setError("Enter your college email and password to continue.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid college email address.");
      return;
    }
    setError("");
    setLoading(true);
    const v = email.trim().toLowerCase();
    onLogin(v.startsWith("drv") ? "driver" : v.startsWith("adm") ? "admin" : "student", v);
  }

  return (
    <div style={{ position:"absolute", inset:0, background:C.surface, display:"flex", flexDirection:"column" }}>
      <StatusBar/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", padding:"24px 28px 32px", overflowY:"auto" }}>
        {/* Logo small */}
        <div style={{ background:"#fff", borderRadius:10, lineHeight:0, border:`1px solid ${C.border}`, alignSelf:"flex-start" }}>
          <img src={ritLogo} alt="RIT" style={{ width:120, height:"auto", display:"block", borderRadius:10 }}/>
        </div>

        <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"center", paddingTop:32, paddingBottom:16 }}>
          <h1 style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:30, color:C.text, margin:0, letterSpacing:"-0.5px" }}>Welcome back</h1>
          <p style={{ fontFamily:"Inter,sans-serif", fontSize:15, color:C.sub, margin:"8px 0 32px" }}>Sign in to track your college bus.</p>

          <InputField label="College email" placeholder="name@ritchennai.edu.in" type="email" value={email} onChange={setEmail}/>
          <InputField label="Password" placeholder="Enter your password" type={showPw?"text":"password"} value={pw} onChange={setPw}
            suffix={<button onClick={() => setShowPw(!showPw)} style={{ background:"none", border:"none", cursor:"pointer", color:C.muted, display:"flex" }}>{Ic.eye}</button>}/>

          <button onClick={submit} style={{ width:"100%", height:50, borderRadius:12, background: loading ? C.blueMid : C.blue, color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, marginBottom:16 }}>
            {loading ? <div style={{ width:18, height:18, border:"2px solid rgba(255,255,255,0.4)", borderTopColor:"#fff", borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/> : "Sign In"}
          </button>
          {error && <div role="alert" style={{ color:"#C62828", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}

          <button onClick={() => alert("Password reset link sent to your registered email.")} style={{ background:"none", border:"none", color:C.blue, fontFamily:"Inter,sans-serif", fontSize:14, fontWeight:500, cursor:"pointer" }}>Forgot password?</button>
        </div>

        <div style={{ textAlign:"center", borderTop:`1px solid ${C.border}`, paddingTop:20 }}>
          <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:13, color:C.sub }}>RIT BusTrack</div>
          <div style={{ fontFamily:"Inter,sans-serif", fontSize:11, color:C.muted, marginTop:2 }}>Rajalakshmi Institute of Technology</div>
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
  const [selectedId, setSelectedId] = useState<string>(buses[0]?.id ?? "");
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (!buses.some(b => b.id === selectedId) && buses[0]) {
      setSelectedId(buses[0].id);
      onSelectBus(buses[0].id);
    }
  }, [buses, selectedId, onSelectBus]);

  const selectedBus = buses.find(b => b.id === selectedId) ?? buses[0];

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

  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <div style={{ padding:"4px 20px 18px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub, marginBottom:5 }}>Good morning 👋</div>
            <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:23, color:C.text }}>{user.name || "RIT Student"}</div>
          </div>
          <button onClick={() => onNav("notifications")} style={{ width:42, height:42, borderRadius:12, border:`1px solid ${C.border}`, background:C.surface, color:C.text, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
            {Ic.bell}
            <span style={{ position:"absolute", margin:"-25px 0 0 24px", width:7, height:7, borderRadius:"50%", background:"#E53935", border:"2px solid #fff" }}/>
          </button>
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 105px" }}>
        <div style={{ display:"inline-flex", alignItems:"center", gap:7, background:C.liveBg, color:C.live, borderRadius:20, padding:"6px 12px", fontSize:12, fontWeight:700, marginBottom:18 }}>
          <span style={{ width:7, height:7, borderRadius:"50%", background:C.live, display:"inline-block", animation:"livePulse 1.4s ease-in-out infinite" }}/>
          Transport service active
        </div>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <div style={{ fontSize:11, fontWeight:800, color:C.muted, letterSpacing:"0.9px" }}>YOUR BUSES</div>
          <div style={{ fontSize:11, color:C.muted }}>{buses.length} available</div>
        </div>

        {buses.length === 0 ? (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, padding:28, textAlign:"center", color:C.sub, marginBottom:18 }}>
            No buses available right now.
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {buses.map((bus, index) => {
              const isSelected = bus.id === selectedBus?.id;
              const stops = stopsByRoute[bus.r] ?? [];
              const nextStop = stops.find(s => s.state === "current") ?? stops.find(s => s.state === "upcoming");
              return (
                <button key={bus.id} onClick={() => openBus(bus)} style={{ width:"100%", background:isSelected ? `${C.blue}08` : C.surface, border:`1.5px solid ${isSelected ? C.blue : C.border}`, borderRadius:18, padding:16, textAlign:"left", cursor:"pointer", boxShadow:"0 4px 14px rgba(13,27,42,0.05)", animation:`fadeUp 0.3s ${index*0.05}s both` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:48, height:48, flexShrink:0, borderRadius:13, background:C.blue, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:21 }}>🚌</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ fontFamily:"Outfit,sans-serif", fontSize:17, fontWeight:800, color:C.text }}>{bus.n || bus.r || "Bus"}</span>
                        {bus.live && <LiveBadge small/>}
                      </div>
                      <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub, marginTop:3, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{bus.routeName || bus.r}</div>
                    </div>
                    <span style={{ fontSize:25, color:C.muted }}>›</span>
                  </div>

                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:14, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
                    <div style={{ background:C.bg, borderRadius:10, padding:"9px 11px" }}>
                      <div style={{ fontSize:10, color:C.muted, marginBottom:3 }}>NEXT STOP</div>
                      <div style={{ fontSize:13, fontWeight:700, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{nextStop?.name ?? "Route available"}</div>
                    </div>
                    <div style={{ background:C.bg, borderRadius:10, padding:"9px 11px" }}>
                      <div style={{ fontSize:10, color:C.muted, marginBottom:3 }}>ETA</div>
                      <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{bus.eta > 0 ? `${bus.eta} min` : "—"}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

       
        <div style={{ marginTop:20 }}>
          <div style={{ fontSize:11, fontWeight:800, color:C.muted, letterSpacing:"0.9px", marginBottom:10 }}>QUICK ACTIONS</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {[
              { label:"Live Map", icon:"🗺️", to:"live-map" as Screen },
              { label:"Find My Bus", icon:"🔎", to:"find-bus" as Screen },
              { label:"Route Stops", icon:"🛣️", to:"route-stops" as Screen },
              { label:"My Trips", icon:"🎫", to:"my-trips" as Screen },
            ].map(action => (
              <button key={action.label} onClick={() => onNav(action.to)} style={{ minHeight:76, background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, padding:"13px 14px", display:"flex", alignItems:"center", gap:10, cursor:"pointer", textAlign:"left" }}>
                <span style={{ fontSize:22 }}>{action.icon}</span>
                <span style={{ fontFamily:"Inter,sans-serif", fontWeight:700, fontSize:13, color:C.text }}>{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <BottomNav active="student-home" onNav={onNav}/>
    </div>
  );
}

// 4 ─ Live Map (hero screen)
function LiveMapScreen({ onNav, buses, stopsByRoute, selectedBus }: { onNav: (s: Screen) => void; buses: FireBus[]; stopsByRoute: Record<string, FireRouteStop[]>; selectedBus?: FireBus }) {
  const bus = selectedBus ?? buses[0] ?? EMPTY_BUS;
  const busPosition = bus.lat != null && bus.lng != null ? { lat: bus.lat, lng: bus.lng } : null;
const stops = withLiveStopStates(stopsByRoute[bus.r] ?? [], busPosition);
  const nextStop = stops.find(s => s.state === "current") ?? stops.find(s => s.state === "upcoming") ?? stops[0];
  const etaMinutes = useRealEta(busPosition, nextStop);

  return (
    <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", background:"#ECF0E8" }}>
      {/* Floating top bar — starts at top:0, StatusBar handles notch clearance internally */}
      <div style={{ position:"absolute", top:0, left:0, right:0, zIndex:1000, padding:"0 14px 0" }}>
        <StatusBar dark/>
        <div style={{ display:"flex", gap:8, marginTop:4 }}>
          <button aria-label="Back to home" title="Back to home" onClick={() => onNav("student-home")} style={{ height:40, padding:"0 12px", borderRadius:10, background:"rgba(255,255,255,0.98)", border:"1px solid rgba(13,27,42,0.12)", display:"flex", alignItems:"center", gap:6, color:C.text, fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:700, cursor:"pointer", boxShadow:"0 2px 8px rgba(0,0,0,0.18)" }}>
            {Ic.back}
            <span>Back</span>
          </button>
          <div style={{ flex:1, height:40, borderRadius:10, background:"rgba(255,255,255,0.95)", display:"flex", alignItems:"center", gap:8, padding:"0 14px", boxShadow:"0 2px 8px rgba(0,0,0,0.1)" }}>
            <span style={{ color:C.muted }}>{Ic.search}</span>
            <span style={{ fontFamily:"Inter,sans-serif", fontSize:14, color:C.muted }}>Search stops or routes</span>
          </div>
        </div>
      </div>

      {/* Map fills full phone height; bottom sheet overlays on top */}
      <div style={{ position:"absolute", inset:0 }}>
        <RouteMapView stops={stops} busPosition={busPosition} height={window.innerHeight}/>
      </div>

      {/* Map controls */}
      <div style={{ position:"absolute", right:14, top:"50%", transform:"translateY(-50%)", display:"flex", flexDirection:"column", gap:6, zIndex:10 }}>
        {["+","−"].map(c => (
          <button key={c} style={{ width:36, height:36, borderRadius:9, background:"rgba(255,255,255,0.95)", border:"none", fontWeight:700, fontSize:18, color:C.text, cursor:"pointer", boxShadow:"0 2px 8px rgba(0,0,0,0.12)", display:"flex", alignItems:"center", justifyContent:"center" }}>{c}</button>
        ))}
        <button style={{ width:36, height:36, borderRadius:9, background:C.blue, border:"none", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:"#fff", boxShadow:"0 2px 8px rgba(0,0,0,0.2)" }}>{Ic.pin}</button>
      </div>

      {/* Bottom sheet */}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, background:C.surface, borderRadius:"24px 24px 0 0", boxShadow:"0 -4px 24px rgba(0,0,0,0.10)", animation:"slideUp 0.3s ease" }}>
        <div style={{ width:36, height:4, borderRadius:2, background:C.border, margin:"12px auto 0" }}/>
        <div style={{ padding:"12px 20px 32px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                <div style={{ width:36, height:36, borderRadius:9, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:13 }}>{bus.r}</div>
                <div>
                  <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:16, color:C.text }}>{bus.r}</div>
                  <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub }}>{bus.routeName}</div>
                </div>
              </div>
            </div>
            {bus.live ? <LiveBadge/> : <span style={{ fontSize:11, color:C.muted, fontFamily:"Inter,sans-serif" }}>Offline</span>}
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:16 }}>
            {[{l:"Next Stop",v:nextStop?.name ?? "—"},{l:"ETA",v:etaMinutes != null ? `${etaMinutes} min` : "—"},{l:"Distance",v:bus.dist}].map(s=>(
              <div key={s.l} style={{ background:C.bg, borderRadius:10, padding:"10px 12px" }}>
                <div style={{ fontSize:10, color:C.muted, fontFamily:"Inter,sans-serif", marginBottom:3 }}>{s.l}</div>
                <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:C.text }}>{s.v}</div>
              </div>
            ))}
          </div>

          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => onNav("route-stops")} style={{ flex:1, height:44, borderRadius:10, border:`1.5px solid ${C.blue}`, background:"transparent", color:C.blue, fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, cursor:"pointer" }}>View Route</button>
            <button onClick={() => onNav("bus-details")} style={{ flex:1, height:44, borderRadius:10, border:"none", background:C.blue, color:"#fff", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, cursor:"pointer" }}>Bus Details</button>
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
  const stops = withLiveStopStates(routeStops?.length ? routeStops : FALLBACK_STOPS, busPosition);
  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title="Bus Details" onBack={() => onNav("student-home")} />
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:18, padding:20, marginBottom:12 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginBottom:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:50, height:50, borderRadius:13, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:20 }}>🚌</div>
              <div>
                <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:20, color:C.text }}>{bus.n || "Bus"}</div>
                <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub, marginTop:3 }}>{bus.routeName || bus.r || "No route"}</div>
              </div>
            </div>
            {bus.live ? <LiveBadge/> : <span style={{ fontSize:11, fontWeight:700, color:C.muted }}>{statusText}</span>}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            {[{l:"ETA",v:bus.eta > 0 ? `${bus.eta} min` : "—"},{l:"Distance",v:bus.dist || "—"},{l:"Stops",v:String(bus.stops ?? 0)}].map(s => (
              <div key={s.l} style={{ background:C.bg, borderRadius:11, padding:"10px 11px" }}>
                <div style={{ fontSize:10, color:C.muted, marginBottom:3 }}>{s.l}</div>
                <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:C.text }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background:"transparent", marginBottom:16, display:"flex", flexDirection:"column", gap:10 }}>
          {[
            { l:"Route", v:bus.routeName || bus.r || "—" },
            { l:"Driver", v:bus.driverEmail || "Assigned driver" },
            { l:"Current location", v:bus.lat != null && bus.lng != null ? "GPS location available" : "GPS unavailable" },
          ].map((r,i,arr) => (
            <div key={r.l} style={{ display:"flex", justifyContent:"space-between", gap:14, padding:"14px 16px", borderBottom:i<arr.length-1 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ fontSize:13, color:C.sub }}>{r.l}</span>
              <span style={{ fontSize:13, fontWeight:600, color:C.text, textAlign:"right", maxWidth:"62%" }}>{r.v}</span>
            </div>
          ))}
        </div>

        <div style={{ display:"flex", gap:10 }}>
          <GhostBtn label="View Full Route" onClick={() => onNav("route-stops")}/>
          <PrimaryBtn label="📍 Pickup Here" onClick={() => onNav("stop-here")}/>
        </div>
      </div>
    </div>
  );
}   

// 6 ─ Route & Stops
function RouteStopsScreen({ onNav, buses, stopsByRoute, backTo = "bus-details", assignedBus, selectedBus }: { onNav: (s: Screen) => void; buses: FireBus[]; stopsByRoute: Record<string, FireRouteStop[]>; backTo?: Screen; assignedBus?: FireBus; selectedBus?: FireBus }) {
  const myBus = selectedBus ?? assignedBus ?? buses[0] ?? EMPTY_BUS;
 const stops = myBus ? (stopsByRoute[myBus.r] ?? []) : [];
  return (

    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title="Route & Stops" onBack={() => onNav(backTo)}/>
        <div style={{ padding:"0 20px 14px", display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:12 }}>{myBus.r}</div>
          <span style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub }}>{myBus.routeName} · {stops.length} stops</span>
          <LiveBadge small/>
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

      <div style={{ flex:1, overflowY:"auto", padding:"20px 24px 32px" }}>
        <div style={{ position:"relative" }}>
          {/* Track line */}
          <div style={{ position:"absolute", left:10, top:10, bottom:10, width:2, background:C.border }}/>
          <div style={{ position:"absolute", left:10, top:10, width:2, height:"36%", background:C.blue }}/>

          {stops.map((s, i) => (
            <div key={s.name} style={{ display:"flex", gap:20, marginBottom: i < stops.length-1 ? 24 : 0, alignItems:"center", animation:`fadeUp 0.3s ${i*0.07}s both` }}>
              {/* Dot */}
              <div style={{ flexShrink:0, width:22, display:"flex", alignItems:"center", justifyContent:"center" }}>
                {s.state === "done" ? (
                  <div style={{ width:10, height:10, borderRadius:"50%", background:C.muted }}/>
                ) : s.state === "current" ? (
                  <div style={{ width:16, height:16, borderRadius:"50%", background:C.blue, border:"2px solid #fff", boxShadow:`0 0 0 3px ${C.blue}33` }}/>
                ) : (
                  <div style={{ width:10, height:10, borderRadius:"50%", background:"#fff", border:`2px solid ${C.border}` }}/>
                )}
              </div>
              {/* Content */}
              <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 16px", borderRadius:12, background: s.state === "current" ? `${C.blue}08` : C.surface, border:`1px solid ${s.state === "current" ? `${C.blue}30` : C.border}` }}>
                <div>
                  <div style={{ fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:14, color: s.state === "done" ? C.muted : C.text, textDecoration: s.state === "done" ? "line-through" : "none" }}>{s.name}</div>
                  {s.state === "current" && <div style={{ fontSize:11, color:C.blue, fontWeight:600, marginTop:2 }}>● Next Stop</div>}
                </div>
                <div style={{ fontFamily:"Outfit,sans-serif", fontSize:13, fontWeight:600, color: s.state === "done" ? C.muted : C.sub }}>{s.time}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 7 ─ Find My Bus
function FindBusScreen({ onNav, buses, onSelectBus }: { onNav: (s: Screen) => void; buses: FireBus[]; onSelectBus?: (id:string)=>void }) {
  const [stop, setStop] = useState("");
  const source = buses.length ? buses : FALLBACK_BUSES;
  const results = source.filter(b => !stop.trim() || `${b.n} ${b.r}`.toLowerCase().includes(stop.toLowerCase()));
  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title="Find My Bus" onBack={() => onNav("student-home")}/>
        <div style={{ padding:"0 20px 16px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, height:44, border:`1.5px solid ${C.border}`, borderRadius:10, padding:"0 14px", background:C.bg }}>
            {Ic.search}
            <input value={stop} onChange={e => setStop(e.target.value)} placeholder="Enter your stop name" style={{ flex:1, border:"none", outline:"none", fontSize:14, fontFamily:"Inter,sans-serif", color:C.text, background:"transparent" }}/>
          </div>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.muted, letterSpacing:"0.8px", marginBottom:12 }}>BUSES TO RIT CAMPUS</div>
        {results.length === 0 ? (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, padding:20, color:C.sub, fontSize:14, textAlign:"center" }}>No active bus matches that search.</div>
        ) : results.map((b, i) => (
          <button key={b.n} onClick={() => onNav("bus-details")} style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px", marginBottom:10, cursor:"pointer", animation:`fadeUp 0.3s ${i*0.07}s both` }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:40, height:40, borderRadius:10, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:14 }}>{b.n.replace("Bus ", "")}</div>
              <div style={{ textAlign:"left" }}>
                <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:15, color:C.text }}>{b.n}</div>
                <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub, marginTop:2 }}>{b.dist} away · {b.stops} stops</div>
              </div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:20, color:C.blue }}>{b.eta}<span style={{ fontSize:12, fontWeight:500, color:C.sub }}> min</span></div>
              <LiveBadge small/>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// 8 ─ Request Pickup
function StopHereScreen({ onNav, selectedBus, user }: { onNav: (s: Screen) => void; selectedBus?: FireBus; user: UserProfile }) {
  const [step, setStep] = useState<"view"|"confirm"|"done">("view");
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
    }, { enableHighAccuracy:true, timeout:10000, maximumAge:5000 });
  }

  if (step === "done") return (
    <div style={{ position:"absolute", inset:0, background:C.surface, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40 }}>
      <div style={{ width:72, height:72, borderRadius:"50%", background:C.liveBg, display:"flex", alignItems:"center", justifyContent:"center", color:C.live, marginBottom:20 }}>{Ic.check}</div>
      <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:22, color:C.text, marginBottom:8 }}>Location Shared</div>
      <div style={{ fontFamily:"Inter,sans-serif", fontSize:14, color:C.sub, textAlign:"center", lineHeight:1.6, marginBottom:28 }}>The driver assigned to {selectedBus?.r ?? "this bus"} has been notified and your location is visible on their map.</div>
      <PrimaryBtn label="Track Bus" onClick={() => onNav("live-map")}/>
    </div>
  );

  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}><StatusBar/><TopBar title="Share Pickup Location" onBack={() => onNav("bus-details")}/></div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        <div style={{ borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, marginBottom:16 }}><MapView animateBus={false} height={190}/></div>
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, padding:16, marginBottom:12 }}>
          <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:17, color:C.text, marginBottom:12 }}>Share your current location?</div>
          {[
            {l:"Bus",v:selectedBus?.n ?? "No bus selected"},
            {l:"Route",v:selectedBus?.routeName ?? selectedBus?.r ?? "—"},
            {l:"Driver",v:selectedBus?.driverEmail ?? "Not assigned"},
          ].map(r => <div key={r.l} style={{ display:"flex", justifyContent:"space-between", gap:12, padding:"10px 0", borderBottom:`1px solid ${C.border}` }}><span style={{fontSize:13,color:C.sub}}>{r.l}</span><span style={{fontSize:13,fontWeight:700,color:C.text,textAlign:"right"}}>{r.v}</span></div>)}
        </div>
        {error && <div style={{ background:"#FFEBEE", color:"#C62828", borderRadius:12, padding:12, marginBottom:12, fontSize:13 }}>{error}</div>}
        {step === "view" && <PrimaryBtn label={sharing ? "Getting your location…" : "📍 Share Location & Notify Driver"} onClick={() => setStep("confirm")}/>} 
        {step === "confirm" && <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, padding:16 }}><div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:14}}>Send your current location to the assigned driver?</div><div style={{display:"flex",gap:10}}><GhostBtn label="Cancel" onClick={() => setStep("view")}/><PrimaryBtn label={sharing ? "Sending…" : "Confirm"} onClick={sendLocationRequest}/></div></div>}
      </div>
    </div>
  );
}

// 9 ─ Suggest Stop
function MakeStopScreen({ onNav, selectedBus }: { onNav: (s: Screen) => void; selectedBus?: FireBus }) {
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);

  if (done) return (
    <div style={{ position:"absolute", inset:0, background:C.surface, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40, paddingTop:68 }}>
      <div style={{ width:72, height:72, borderRadius:"50%", background:`${C.sky}18`, display:"flex", alignItems:"center", justifyContent:"center", color:C.sky, marginBottom:20, animation:"scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both", fontSize:32 }}>🏗️</div>
      <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:22, color:C.text, marginBottom:8 }}>Request Submitted</div>
      <div style={{ fontFamily:"Inter,sans-serif", fontSize:14, color:C.sub, textAlign:"center", lineHeight:1.6, marginBottom:16 }}>Sent to Transport Admin for review.</div>
      <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"#FFF9C4", color:"#F57F17", borderRadius:20, padding:"6px 14px", fontSize:13, fontWeight:700, marginBottom:32 }}>● Status: Pending</div>
      <PrimaryBtn label="Back to Home" onClick={() => onNav("student-home")}/>
    </div>
  );

  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title="Suggest New Stop" onBack={() => onNav("student-home")}/>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        <div style={{ borderRadius:14, overflow:"hidden", border:`1px solid ${C.border}`, marginBottom:16 }}>
          <MapView animateBus={false} height={160}/>
        </div>
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, overflow:"hidden", marginBottom:12 }}>
          {[{ l:"Selected Location", v:"Arcot" }, { l:"Route", v:selectedBus?.r ?? "—" }, { l:"Requests so far", v:"1 student" }].map((r, i, arr) => (
            <div key={r.l} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"13px 16px", borderBottom: i < arr.length-1 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ fontSize:13, color:C.sub, fontFamily:"Inter,sans-serif" }}>{r.l}</span>
              <span style={{ fontSize:13, fontWeight:600, color:C.text, fontFamily:"Inter,sans-serif" }}>{r.v}</span>
            </div>
          ))}
        </div>

        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:600, color:C.sub, marginBottom:8 }}>REASON FOR STOP REQUEST</div>
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain why this stop is needed..." rows={4}
            style={{ width:"100%", border:"none", outline:"none", fontSize:14, fontFamily:"Inter,sans-serif", color:C.text, resize:"none", background:"transparent" }}/>
        </div>

        <PrimaryBtn label="Submit Request" onClick={() => {
          if (!reason.trim()) return;
          addStopRequest({ loc: "Selected location", route: selectedBus?.r ?? "—", count: 1, reason: reason.trim() }).catch(console.error);
          setDone(true);
        }}/>
      </div>
    </div>
  );
}

// 10 ─ Notifications
function NotificationsScreen({ onNav }: { onNav: (s: Screen) => void }) {
  const [items, setItems] = useStoredState<Notification[]>("rit-notifications-r24", [
    { icon:"🚌", title:"R24 is 2 stops away", time:"2 min ago",  dot:C.blue,   isNew:true  },
    { icon:"✅", title:"Pickup request accepted",     time:"25 min ago", dot:C.live, isNew:false },
    { icon:"🏗️", title:"New stop request approved",   time:"1 hr ago",   dot:C.live, isNew:false },
    { icon:"🗺️", title:"R24 route updated",    time:"2 hr ago",   dot:C.sky,  isNew:false },
    { icon:"▶️", title:"R24 trip has started",     time:"Yesterday",  dot:C.blue, isNew:false },
  ]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"
  );

  async function enableNotifications() {
    const result = await enableBrowserNotifications();
    setPermission(result);
  }

  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <div style={{ padding:"4px 20px 14px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:20, color:C.text }}>Notifications</div>
          <button onClick={() => setItems(i => i.map(x => ({ ...x, isNew: false })))} style={{ fontSize:13, color:C.blue, fontFamily:"Inter,sans-serif", fontWeight:500, border:"none", background:"none", cursor:"pointer" }}>Mark all read</button>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"12px 20px 88px" }}>
        {permission !== "granted" && permission !== "unsupported" && (
          <button onClick={enableNotifications} style={{ width:"100%", marginBottom:12, padding:"12px 14px", borderRadius:12, border:`1px solid ${C.blue}`, background:C.skyLight, color:C.blue, fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:700, cursor:"pointer" }}>
            Enable browser notifications
          </button>
        )}
        {permission === "granted" && (
          <div style={{ marginBottom:12, color:C.live, fontFamily:"Inter,sans-serif", fontSize:12, fontWeight:600 }}>Browser notifications enabled</div>
        )}
        {items.map((n, i) => (
          <div key={i} style={{ display:"flex", gap:12, background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:"14px 16px", marginBottom:8, borderLeft:`3px solid ${n.isNew ? n.dot : C.border}`, animation:`slideInRight 0.3s ${i*0.05}s both` }}>
            <div style={{ width:38, height:38, borderRadius:10, background:C.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>{n.icon}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:14, color:C.text, marginBottom:3 }}>{n.title}</div>
              <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.muted }}>{n.time}</div>
            </div>
            {n.isNew && <div style={{ width:7, height:7, borderRadius:"50%", background:C.blue, flexShrink:0, marginTop:4 }}/>}
          </div>
        ))}
      </div>
      <BottomNav active="notifications" onNav={onNav}/>
    </div>
  );
}

// 11 ─ My Trips
function MyTripsScreen({ onNav }: { onNav: (s: Screen) => void }) {
  const [trips] = useStoredState<Trip[]>("rit-trips-r24", []);
  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <div style={{ padding:"4px 20px 14px" }}>
          <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:20, color:C.text }}>My Trips</div>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 100px" }}>
        {trips.length === 0 ? (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, padding:20, color:C.sub, fontSize:14, textAlign:"center" }}>Your completed trips will appear here.</div>
        ) : trips.map((t, i) => (
          <div key={i} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:14, animation:`fadeUp 0.3s ${i*0.07}s both` }}>
            <div style={{ width:40, height:40, borderRadius:10, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14 }}>{t.bus}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:14, color:C.text }}>{t.from} → {t.to}</div>
              <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.muted, marginTop:2 }}>{t.date}</div>
            </div>
            <span style={{ fontSize:12, fontWeight:600, color:C.live, background:C.liveBg, padding:"3px 10px", borderRadius:20 }}>{t.status}</span>
          </div>
        ))}
      </div>
      <BottomNav active="my-trips" onNav={onNav}/>
    </div>
  );
}

// 12 ─ Settings
function SettingsScreen({ onNav, preferences, setPreferences }: { onNav: (s: Screen) => void; preferences: Preferences; setPreferences: React.Dispatch<React.SetStateAction<Preferences>> }) {
  const text = copy[preferences.language];
  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title={text.settings} onBack={() => onNav("profile")}/>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"20px 20px 32px" }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.muted, letterSpacing:"0.8px", marginBottom:10 }}>{text.appearance.toUpperCase()}</div>
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, overflow:"hidden", marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 18px", borderBottom:`1px solid ${C.border}` }}>
            <div>
              <div style={{ fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:14, color:C.text }}>{text.darkMode}</div>
              <div style={{ fontSize:12, color:C.sub, marginTop:3 }}>{preferences.theme === "dark" ? "On" : "Off"}</div>
            </div>
            <button aria-label={text.darkMode} onClick={() => setPreferences(value => ({ ...value, theme: value.theme === "dark" ? "light" : "dark" }))} style={{ width:50, height:30, padding:3, border:"none", borderRadius:20, background:preferences.theme === "dark" ? C.blue : C.border, cursor:"pointer", textAlign:preferences.theme === "dark" ? "right" : "left" }}>
              <span style={{ display:"inline-block", width:24, height:24, borderRadius:"50%", background:C.surface, boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }}/>
            </button>
          </div>
          <div style={{ padding:"16px 18px" }}>
            <div style={{ fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:14, color:C.text, marginBottom:10 }}>{text.language}</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {([ ["en", text.english], ["ta", text.tamil] ] as [Language, string][]).map(([value, label]) => (
                <button key={value} onClick={() => setPreferences(current => ({ ...current, language:value }))} style={{ height:42, borderRadius:10, border:`1.5px solid ${preferences.language === value ? C.blue : C.border}`, background:preferences.language === value ? C.skyLight : C.surface, color:preferences.language === value ? C.blue : C.sub, fontWeight:700, cursor:"pointer" }}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ color:C.live, fontSize:13, fontWeight:600, textAlign:"center" }}>{text.save}</div>
      </div>
    </div>
  );
}

// 13 ─ Profile
function ProfileScreen({ onNav, onLogout, user, language }: { onNav: (s: Screen) => void; onLogout: () => void; user: UserProfile; language: Language }) {
  const text = copy[language];
  const initials = user.name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <div style={{ padding:"4px 20px 14px" }}>
          <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:20, color:C.text }}>{text.profile}</div>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"20px 20px 88px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:14, background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, padding:20, marginBottom:16 }}>
          <div style={{ width:52, height:52, borderRadius:14, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:20, color:"#fff" }}>{initials}</div>
          <div>
            <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:17, color:C.text }}>{user.name}</div>
            <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub, marginTop:1 }}>{user.email}</div>
          </div>
        </div>
        <div style={{ marginBottom:16, display:"flex", flexDirection:"column", gap:10 }}>
          {([
            ["My Bus Pass",    "my-trips"      ],
            ["Stop Requests",  "make-stop"     ],
            ["Trip History",   "my-trips"      ],
            ["Notifications",  "notifications" ],
            [text.settings,    "settings"     ],
          ] as [string, Screen | null][]).map(([item, dest], i, arr) => (
            <button key={item} onClick={() => dest && onNav(dest)} style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 18px", background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, boxShadow:"0 2px 8px rgba(13,27,42,0.04)", cursor: dest ? "pointer" : "default" }}>
              <span style={{ fontFamily:"Inter,sans-serif", fontSize:14, color:C.text }}>{item}</span>
              {Ic.chevron}
            </button>
          ))}
        </div>
        <button onClick={onLogout} style={{ width:"100%", height:48, borderRadius:12, background:"transparent", border:"1.5px solid #E53935", color:"#E53935", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:15, cursor:"pointer" }}>{text.signOut}</button>
      </div>
      <BottomNav active="profile" onNav={onNav}/>
    </div>
  );
}

// 13 ─ Driver Home
function DriverHome({ onNav, onLogout, user, assignedBus }: { onNav: (s: Screen) => void; onLogout: () => void; user: UserProfile; assignedBus?: FireBus }) {
  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <div style={{ padding:"4px 20px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub }}>Good morning</div>
            <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:22, color:C.text }}>{user.name}</div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <button onClick={onLogout} style={{ height:36, padding:"0 12px", borderRadius:10, background:"transparent", border:`1.5px solid #E53935`, color:"#E53935", fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:12, cursor:"pointer" }}>Sign Out</button>
            <div style={{ background:"#fff", borderRadius:10, lineHeight:0, border:`1px solid ${C.border}` }}>
              <img src={ritLogo} alt="RIT" style={{ width:72, height:"auto", display:"block", borderRadius:10 }}/>
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        {/* Bus assignment */}
        {assignedBus ? (
          <div style={{ background:C.blue, borderRadius:16, padding:20, marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.6)", letterSpacing:"0.8px", marginBottom:12 }}>ASSIGNED BUS</div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <div>
                <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:32, color:"#fff", letterSpacing:"-1px" }}>{assignedBus.r}</div>
                <div style={{ fontFamily:"Inter,sans-serif", fontSize:14, color:"rgba(255,255,255,0.7)", marginTop:2 }}>{assignedBus.routeName}</div>
              </div>
              <div style={{ fontSize:40 }}>🚌</div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
              {[{l:"Stops",v:String(assignedBus.stops)},{l:"Distance",v:assignedBus.dist},{l:"ETA",v:`${assignedBus.eta} min`}].map(s=>(
                <div key={s.l} style={{ background:"rgba(255,255,255,0.12)", borderRadius:10, padding:"10px 12px" }}>
                  <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:16, color:"#fff" }}>{s.v}</div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.55)", marginTop:2 }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ background:C.surface, border:`1px dashed ${C.border}`, borderRadius:16, padding:20, marginBottom:12, textAlign:"center" }}>
            <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:15, color:C.text, marginBottom:6 }}>No bus assigned yet</div>
            <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub }}>Ask your Transport Admin to assign a bus to {user.email || "your account"} in Manage Buses.</div>
          </div>
        )}

        {/* Schedule */}
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, overflow:"hidden", marginBottom:12 }}>
          <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:C.text }}>Today's Schedule</div>
          {[{t:"08:30 AM",label:"Morning Trip"},{t:"01:00 PM",label:"Afternoon Return"},{t:"05:30 PM",label:"Evening Trip"}].map((s, i, arr) => (
            <div key={s.t} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderBottom: i < arr.length-1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:C.blue, flexShrink:0 }}/>
              <div style={{ flex:1, fontFamily:"Inter,sans-serif", fontSize:14, color:C.text }}>{s.label}</div>
              <div style={{ fontFamily:"Outfit,sans-serif", fontSize:13, fontWeight:600, color:C.sub }}>{s.t}</div>
            </div>
          ))}
        </div>

        <button onClick={() => assignedBus && onNav("driver-start")} disabled={!assignedBus} style={{ width:"100%", height:54, borderRadius:14, background: assignedBus ? C.live : C.muted, color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:18, cursor: assignedBus ? "pointer" : "not-allowed", display:"flex", alignItems:"center", justifyContent:"center", gap:10, marginBottom:10 }}>
          {Ic.play} START TRIP
        </button>
      </div>
    </div>
  );
}

// 14 ─ Start Trip
function DriverStartTrip({ onNav, assignedBus }: { onNav: (s: Screen) => void; assignedBus?: FireBus }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone]       = useState(false);

  function start() {
    enableBrowserNotifications().catch(() => undefined);
    setLoading(true);
    setTimeout(() => { setDone(true); setTimeout(() => onNav("driver-live"), 1000); }, 1400);
    const trip: Trip = { bus: assignedBus?.r ?? "—", from: assignedBus?.routeName?.split("→")[0]?.trim() ?? "—", to: assignedBus?.routeName?.split("→")[1]?.trim() ?? "—", date: `Today, ${nowLabel()}`, status: "In progress" };
    localStorage.setItem("rit-active-trip", JSON.stringify(trip));
  }

  return (
    <div style={{ position:"absolute", inset:0, background:C.navy, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:32 }}>
      <StatusBar dark/>
      {done ? (
        <div style={{ textAlign:"center", animation:"scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both" }}>
          <div style={{ width:80, height:80, borderRadius:"50%", background:C.liveBg, display:"flex", alignItems:"center", justifyContent:"center", color:C.live, margin:"0 auto 20px" }}>{Ic.check}</div>
          <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:24, color:"#fff" }}>Trip Started!</div>
        </div>
      ) : (
        <>
          <div style={{ textAlign:"center", marginBottom:40, animation:"fadeUp 0.4s ease both" }}>
            <div style={{ fontFamily:"Inter,sans-serif", fontSize:14, color:"rgba(255,255,255,0.55)", marginBottom:6 }}>Ready to start</div>
            <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:34, color:"#fff", letterSpacing:"-0.5px" }}>{assignedBus?.r ?? "No bus"}?</div>
          </div>
          <div style={{ width:"100%", border:`1px solid rgba(255,255,255,0.12)`, borderRadius:16, overflow:"hidden", marginBottom:32 }}>
            {[{l:"Route",v:assignedBus?.routeName ?? "—"},{l:"Total Stops",v:String(assignedBus?.stops ?? "—")},{l:"Scheduled",v:"5:20 AM"}].map((r,i,arr)=>(
              <div key={r.l} style={{ display:"flex", justifyContent:"space-between", padding:"14px 20px", borderBottom: i < arr.length-1 ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
                <span style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:"rgba(255,255,255,0.5)" }}>{r.l}</span>
                <span style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:13, color:"#fff" }}>{r.v}</span>
              </div>
            ))}
          </div>
          <button onClick={start} style={{ width:"100%", height:54, borderRadius:14, background:C.live, color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:800, fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:10, marginBottom:14 }}>
            {loading ? <div style={{ width:22, height:22, border:"2px solid rgba(255,255,255,0.4)", borderTopColor:"#fff", borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/> : <>{Ic.play} Start Trip</>}
          </button>
          <button onClick={() => onNav("driver-home")} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)", fontFamily:"Inter,sans-serif", fontSize:14, cursor:"pointer" }}>Cancel</button>
        </>
      )}
    </div>
  );
}

// 15 ─ Driver Live Map
function DriverLiveScreen({ onNav, busId, stopsByRoute, assignedBus, requests = [] }: { onNav: (s: Screen) => void; busId: string; stopsByRoute: Record<string, FireRouteStop[]>; assignedBus?: FireBus; requests?: FireStopRequest[] }) {
  const [req, setReq] = useState(true);
  const { position } = useGeolocation();
  const stops =
  assignedBus
    ? (stopsByRoute[assignedBus.r] ?? [])
    : [];
  const nextStop = stops.find(s => s.state === "current") ?? stops.find(s => s.state === "upcoming") ?? stops[0];
  const remaining = stops.filter(s => s.state !== "done").length;
  const busPosition = position ? { lat: position.coords.latitude, lng: position.coords.longitude } : null;
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

  // Push the driver's real GPS position to Firestore every time it updates,
  // so every student watching the map sees the bus move live.
  useEffect(() => {
    if (position && busId) {
      updateBusLocation(busId, position.coords.latitude, position.coords.longitude).catch(console.error);
    }
  }, [position, busId]);

  return (
    <div style={{ position:"absolute", inset:0, overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0 }}><RouteMapView
          stops={stops}
          busPosition={busPosition}
          studentLocations={sharedStudents}
          height={window.innerHeight}
        /></div>

      {/* Top overlay */}
      <div style={{ position:"absolute", top:0, left:0, right:0, zIndex:1000, padding:"0 14px 0" }}>
        <StatusBar dark/>
        <div style={{ display:"flex", gap:8, marginTop:4 }}>
          <button aria-label="Back to driver home" title="Back to driver home" onClick={() => onNav("driver-home")} style={{ height:44, padding:"0 12px", borderRadius:12, background:"rgba(13,27,42,0.94)", border:"1px solid rgba(255,255,255,0.18)", display:"flex", alignItems:"center", gap:6, color:"#fff", fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:700, cursor:"pointer", boxShadow:"0 2px 8px rgba(0,0,0,0.24)" }}>
            {Ic.back}
            <span>Back</span>
          </button>
          <div style={{ flex:1, background:"rgba(13,27,42,0.88)", backdropFilter:"blur(8px)", borderRadius:12, padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontFamily:"Inter,sans-serif", fontSize:11, color:"rgba(255,255,255,0.5)" }}>Active Trip · {assignedBus?.r ?? "—"}</div>
              <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:"#fff" }}>{assignedBus?.routeName ?? "—"}</div>
            </div>
            <LiveBadge/>
          </div>
          <div style={{ width:44, height:44, borderRadius:12, background:"rgba(13,27,42,0.88)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#fff" }}>
            <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, lineHeight:1 }}>34</div>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.4)" }}>km/h</div>
          </div>
        </div>
      </div>

      {/* Pickup request card */}
      {req && sharedStudents.length > 0 && (
        <div style={{ position:"absolute", left:14, right:14, top:130, background:"#fff", borderRadius:16, overflow:"hidden", boxShadow:"0 4px 20px rgba(0,0,0,0.2)", zIndex:20 }}>
          <div style={{ background:C.warnBg, borderBottom:`1px solid ${C.border}`, padding:"12px 16px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:18 }}>📍</span>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:C.warn }}>Student Location Shared</div>
              <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub }}>{sharedStudents[0].studentName || "Student"} is visible on your map.</div>
            </div>
            <button onClick={() => setReq(false)} style={{ background:"none", border:"none", cursor:"pointer", color:C.muted }}>{Ic.close}</button>
          </div>
          <div style={{ display:"flex", gap:10, padding:"12px 16px" }}>
            <button onClick={() => setReq(false)} style={{ flex:1, height:40, borderRadius:10, background:C.live, color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, cursor:"pointer" }}>Seen</button>
          </div>
        </div>
      )}

      {/* Bottom sheet */}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, background:"rgba(13,27,42,0.94)", backdropFilter:"blur(10px)", borderRadius:"20px 20px 0 0" }}>
        <div style={{ width:36, height:3, borderRadius:2, background:"rgba(255,255,255,0.15)", margin:"10px auto 0" }}/>
        <div style={{ padding:"12px 20px 32px" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
            {[{l:"Next Stop",v:nextStop?.name ?? "—"},{l:"ETA",v:etaMinutes != null ? `${etaMinutes} min` : "—"},{l:"Remaining",v:`${remaining} stops`}].map(s=>(
              <div key={s.l} style={{ background:"rgba(255,255,255,0.07)", borderRadius:10, padding:"10px 12px" }}>
                <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:"#fff" }}>{s.v}</div>
                <div style={{ fontSize:10, color:"rgba(255,255,255,0.4)", marginTop:2 }}>{s.l}</div>
              </div>
            ))}
          </div>
          <button onClick={() => {
            const active = localStorage.getItem("rit-active-trip");
            if (active) {
              const trip = JSON.parse(active) as Trip;
              const trips = JSON.parse(localStorage.getItem("rit-trips-r24") || "[]") as Trip[];
              localStorage.setItem("rit-trips-r24", JSON.stringify([{ ...trip, status: "Completed" }, ...trips]));
              localStorage.removeItem("rit-active-trip");
            }
            setBusLive(busId, false).catch(console.error);
            onNav("driver-home");
          }} style={{ width:"100%", height:48, borderRadius:12, background:"#E53935", color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            {Ic.stop} End Trip
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
}: {
  onNav: (s: Screen) => void;
  onLogout: () => void;
  buses: FireBus[];
}) {

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
      l: "Buses",
      badge: null,
      target: "admin-manage",
      icon: Ic.bus,
      color: C.blue,
    },
    
   
    
    {
      l: "Stop Requests",
      badge: "5 new",
      target: "admin-stops",
      icon: Ic.bell,
      color: "#E85D75",
    },
    {
      l: "Reports",
      badge: null,
      target: "admin-home",
      icon: Ic.report,
      color: "#16A085",
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
                animation: `adminFadeUp 0.4s ease ${
                  0.15 + i * 0.08
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
                    animation: `iconPop 0.4s ease ${
                      0.2 + i * 0.08
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

// 16b ─ Admin: Manage Buses & Route Stops
function AdminManageBuses({ onNav, buses, stopsByRoute }: { onNav: (s: Screen) => void; buses: FireBus[]; stopsByRoute: Record<string, FireRouteStop[]> }) {
  const [tab, setTab] = useState<"buses"|"stops">("buses");

  // New-bus / edit-bus form. editingId is null while adding a new bus, and
  // set to a bus's id while editing an existing one (same form, different mode).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [n, setN] = useState("");
  const [r, setR] = useState("");
  const [routeName, setRouteName] = useState("");
  const [totalStops, setTotalStops] = useState("");
  const [driverEmail, setDriverEmail] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setEditingId(null);
    setN(""); setR(""); setRouteName(""); setTotalStops(""); setDriverEmail(""); setLat(""); setLng("");
  }

  function startEdit(b: FireBus) {
    setEditingId(b.id);
    setN(b.n); setR(b.r); setRouteName(b.routeName); setTotalStops(String(b.stops));
    setDriverEmail(b.driverEmail ?? ""); setLat(b.lat != null ? String(b.lat) : ""); setLng(b.lng != null ? String(b.lng) : "");
  }

  useEffect(() => {
    const firstStop = stopsByRoute[r.trim()]?.[0];
    if (!firstStop) return;
    if (!lat.trim() && firstStop.lat != null) setLat(String(firstStop.lat));
    if (!lng.trim() && firstStop.lng != null) setLng(String(firstStop.lng));
  }, [r, stopsByRoute]);

  async function submitBus() {
    if (!n.trim() || !r.trim()) return;
    if (!editingId) {
      setRouteCode(r.trim());
      setEditableStops(stopsByRoute[r.trim()] ?? []);
      setTab("stops");
      return;
    }
    setSaving(true);
    try {
      // If this route code already has stops saved (e.g. a second bus on the
      // same route), pick up that count automatically instead of starting at 0.
      const routeStops = stopsByRoute[r.trim()] ?? [];
      const firstStop = routeStops[0];
      const existingStopCount = routeStops.length;
      const data = {
        n: n.trim(), r: r.trim(), routeName: routeName.trim() || "—", stops: existingStopCount,
        driverEmail: driverEmail.trim().toLowerCase() || undefined,
        lat: lat.trim() ? Number(lat) : firstStop?.lat,
        lng: lng.trim() ? Number(lng) : firstStop?.lng,
      };
      await updateBus(editingId, data);
      resetForm();
    } catch (e) { console.error(e); }
    setSaving(false);
  }

  async function removeBus(id: string) {
    if (!window.confirm("Delete this bus? This can't be undone.")) return;
    try { await deleteBus(id); } catch (e) { console.error(e); }
    if (editingId === id) resetForm();
  }

  // Route-stops editor — admin picks WHICH route (bus) they're editing, since
  // a fleet can have several buses on different routes.
  const routeCodes = Array.from(new Set(buses.map(b => b.r).filter(Boolean)));
  const [routeCode, setRouteCode] = useState(routeCodes[0] ?? "");
  useEffect(() => { if (!routeCode && routeCodes[0]) setRouteCode(routeCodes[0]); }, [routeCodes.join(","), routeCode]);

  const [editableStops, setEditableStops] = useState<FireRouteStop[]>(stopsByRoute[routeCode] ?? []);
  useEffect(() => { setEditableStops(stopsByRoute[routeCode] ?? []); }, [routeCode, stopsByRoute]);
  const [stopsSaving, setStopsSaving] = useState(false);
  const [geocodingIndex, setGeocodingIndex] = useState<number | null>(null);

  // Looks up a stop's typed name (e.g. "Arcot Bus Stand") and fills in its
  // lat/lng automatically, using OpenStreetMap's free Nominatim search —
  // no API key needed. Biased toward Tamil Nadu/India since that's where
  // these routes run; adjust the bias text if your routes are elsewhere.
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
        const lat = Number(results[0].lat);
        const lng = Number(results[0].lon);
        setEditableStops(list => list.map((s, idx) => idx === i ? { ...s, lat, lng } : s));
      } else {
        window.alert(`Couldn't find "${query}" on the map. Try a more specific name, or enter coordinates manually.`);
      }
    } catch (e) {
      console.error(e);
      window.alert("Couldn't reach the location lookup service right now — enter coordinates manually instead.");
    }
    setGeocodingIndex(null);
  }

  function updateStop(i: number, field: "name"|"time"|"lat"|"lng", value: string) {
    setEditableStops(list => list.map((s, idx) => {
      if (idx !== i) return s;
      if (field === "lat" || field === "lng") {
        return { ...s, [field]: value.trim() === "" ? undefined : Number(value) };
      }
      return { ...s, [field]: value };
    }));
  }

  function addEmptyStop() {
    setEditableStops(list => [...list, { name:"", time:"", state:"upcoming", order:list.length }]);
  }

  async function saveStops() {
    if (!routeCode.trim()) return;
    setStopsSaving(true);
    try {
      const cleanStops = editableStops.filter(s => s.name.trim());
      if (!cleanStops.length) {
        window.alert("Add at least one route stop before creating the bus.");
        setStopsSaving(false);
        return;
      }
      await setRouteStops(routeCode.trim(), cleanStops);

      if (!editingId && n.trim() && r.trim() === routeCode.trim()) {
        const firstStop = cleanStops[0];
        await addBus({
          n: n.trim(),
          r: r.trim(),
          routeName: routeName.trim() || "—",
          stops: cleanStops.length,
          driverEmail: driverEmail.trim().toLowerCase() || undefined,
          lat: lat.trim() ? Number(lat) : firstStop.lat,
          lng: lng.trim() ? Number(lng) : firstStop.lng,
          eta: 10,
          live: false,
          dist: "—",
        });
        resetForm();
        setTab("buses");
        setStopsSaving(false);
        return;
      }

      // Keep every bus on this route in sync with the real stop count —
      // this is what was causing R15 to show "7 stops" in one place and
      // "4 stops" in another. stops.length is now the single source of truth.
      const busesOnRoute = buses.filter(b => b.r === routeCode.trim());
      const firstStop = cleanStops[0];
      await Promise.all(
        busesOnRoute.map(b => updateBus(b.id, {
          stops: cleanStops.length,
          ...(firstStop?.lat != null && firstStop?.lng != null
            ? { lat: firstStop.lat, lng: firstStop.lng }
            : {}),
        }))
      );
    } catch (e) { console.error(e); }
    setStopsSaving(false);
  }

  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title="Manage Buses & Routes" onBack={() => onNav("admin-home")}/>
        <div style={{ display:"flex", gap:8, padding:"0 20px 14px" }}>
          {(["buses","stops"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ flex:1, height:38, borderRadius:10, border:`1.5px solid ${tab===t ? C.blue : C.border}`, background: tab===t ? C.skyLight : C.surface, color: tab===t ? C.blue : C.sub, fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:13, cursor:"pointer" }}>
              {t === "buses" ? "Buses" : "Route Stops"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        {tab === "buses" ? (
          <>
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:16 }}>
              <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:C.text, marginBottom:12 }}>{editingId ? "Edit Bus" : "Add a Bus"}</div>
              <InputField label="Bus Number" placeholder="e.g. R24" value={r} onChange={setR}/>
              <InputField label="Display Name" placeholder="e.g. Bus R24" value={n} onChange={setN}/>
              <InputField label="Route" placeholder="e.g. Arcot → RIT Campus" value={routeName} onChange={setRouteName}/>
              <div style={{ fontSize:11, color:C.muted, fontFamily:"Inter,sans-serif", margin:"-4px 0 12px" }}>
                Stop count is set automatically from the "Route Stops" tab — add this bus first, then add its stops there.
              </div>
              <InputField label="Assign Driver (email)" placeholder="driver@rit.ac.in" value={driverEmail} onChange={setDriverEmail}/>
              <div style={{ display:"flex", gap:8 }}>
                <div style={{ flex:1 }}><InputField label="Latitude" placeholder="e.g. 12.9716" type="number" value={lat} onChange={setLat}/></div>
                <div style={{ flex:1 }}><InputField label="Longitude" placeholder="e.g. 79.6083" type="number" value={lng} onChange={setLng}/></div>
              </div>
              <div style={{ fontSize:11, color:C.muted, fontFamily:"Inter,sans-serif", margin:"-8px 0 12px" }}>Optional — set a starting position for the demo map, or leave blank and let the driver's live GPS fill it in.</div>
              <PrimaryBtn label={saving ? "Saving…" : editingId ? "Save Changes" : "Continue to Route Stops"} onClick={submitBus}/>
              {editingId && (
                <button onClick={resetForm} style={{ width:"100%", height:40, marginTop:8, borderRadius:10, border:"none", background:"none", color:C.sub, fontFamily:"Inter,sans-serif", fontSize:13, cursor:"pointer" }}>Cancel Edit</button>
              )}
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:C.muted, letterSpacing:"0.8px", marginBottom:10 }}>CURRENT FLEET</div>
            {buses.length === 0 && <div style={{ color:C.sub, fontSize:13, fontFamily:"Inter,sans-serif" }}>No buses added yet — students will see demo data until you add one.</div>}
            {buses.map(b => (
              <div key={b.id} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:14, marginBottom:10 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div>
                    <div style={{ fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, color:C.text }}>{b.n} ({b.r})</div>
                    <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub, marginTop:2 }}>{b.routeName} · {b.stops} stops{b.driverEmail ? ` · Driver: ${b.driverEmail}` : ""}</div>
                    {(b.lat != null && b.lng != null) && (
                      <div style={{ fontFamily:"Inter,sans-serif", fontSize:11, color:C.muted, marginTop:2 }}>📍 {b.lat.toFixed(4)}, {b.lng.toFixed(4)}</div>
                    )}
                  </div>
                  {b.live ? <LiveBadge small/> : <span style={{ fontSize:11, color:C.muted }}>Offline</span>}
                </div>
                <div style={{ display:"flex", gap:8, marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}` }}>
                  <button onClick={() => startEdit(b)} style={{ flex:1, height:34, borderRadius:8, border:`1.5px solid ${C.border}`, background:"none", color:C.blue, fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:12, cursor:"pointer" }}>Edit</button>
                  <button onClick={() => removeBus(b.id)} style={{ flex:1, height:34, borderRadius:8, border:`1.5px solid #FBD5D5`, background:"none", color:"#E53935", fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:12, cursor:"pointer" }}>Delete</button>
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            {routeCodes.length > 1 && (
              <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
                {routeCodes.map(code => (
                  <button key={code} onClick={() => setRouteCode(code)} style={{ height:32, padding:"0 12px", borderRadius:8, border:`1.5px solid ${routeCode===code ? C.blue : C.border}`, background: routeCode===code ? C.skyLight : "none", color: routeCode===code ? C.blue : C.sub, fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:12, cursor:"pointer" }}>{code}</button>
                ))}
              </div>
            )}
            <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub, marginBottom:4 }}>{routeCode ? `Editing stops for route ${routeCode} — this is exactly what students on that bus see.` : "Add a bus first, then its route stops can be edited here."}</div>
            <div style={{ fontSize:11, color:C.muted, fontFamily:"Inter,sans-serif", marginBottom:12 }}>Type a stop name and tap "Find" to auto-fill its coordinates, or enter latitude/longitude yourself.</div>
            {editableStops.map((s, i) => (
              <div key={i} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:10, marginBottom:8 }}>
                <div style={{ display:"flex", gap:8, marginBottom:6 }}>
                  <input value={s.name} onChange={e => updateStop(i, "name", e.target.value)} placeholder="Stop name" style={{ flex:2, height:40, borderRadius:8, border:`1.5px solid ${C.border}`, padding:"0 10px", fontSize:13, fontFamily:"Inter,sans-serif" }}/>
                  <input value={s.time} onChange={e => updateStop(i, "time", e.target.value)} placeholder="7:10 AM" style={{ flex:1, height:40, borderRadius:8, border:`1.5px solid ${C.border}`, padding:"0 10px", fontSize:13, fontFamily:"Inter,sans-serif" }}/>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <input value={s.lat ?? ""} onChange={e => updateStop(i, "lat", e.target.value)} placeholder="Latitude" type="number" style={{ flex:1, height:38, borderRadius:8, border:`1.5px solid ${C.border}`, padding:"0 10px", fontSize:12, fontFamily:"Inter,sans-serif" }}/>
                  <input value={s.lng ?? ""} onChange={e => updateStop(i, "lng", e.target.value)} placeholder="Longitude" type="number" style={{ flex:1, height:38, borderRadius:8, border:`1.5px solid ${C.border}`, padding:"0 10px", fontSize:12, fontFamily:"Inter,sans-serif" }}/>
                  <button onClick={() => geocodeStop(i)} disabled={!s.name.trim() || geocodingIndex === i} style={{ flexShrink:0, height:38, padding:"0 12px", borderRadius:8, border:"none", background: geocodingIndex === i ? C.muted : C.blue, color:"#fff", fontFamily:"Inter,sans-serif", fontWeight:600, fontSize:12, cursor: s.name.trim() ? "pointer" : "not-allowed" }}>
                    {geocodingIndex === i ? "Finding…" : "📍 Find"}
                  </button>
                </div>
              </div>
            ))}
            <button onClick={addEmptyStop} disabled={!routeCode} style={{ width:"100%", height:42, borderRadius:10, border:`1.5px dashed ${C.border}`, background:"none", color:C.sub, fontFamily:"Inter,sans-serif", fontSize:13, cursor: routeCode ? "pointer" : "not-allowed" }}>+ Add Stop</button>
            <div style={{ height:16 }}/>
            <PrimaryBtn label={stopsSaving ? "Saving…" : "Save Route Stops"} onClick={saveStops}/>
          </>
        )}
      </div>
    </div>
  );
}

// 17 ─ Admin Stop Requests
function AdminStopRequests({ onNav, requests }: { onNav: (s: Screen) => void; requests: FireStopRequest[] }) {
  const reqs = requests;

  function decide(id: string, s: "approved"|"rejected") {
    decideStopRequest(id, s).catch(console.error);
  }

  return (
    <div style={{ position:"absolute", inset:0, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
        <StatusBar/>
        <TopBar title="Stop Requests" onBack={() => onNav("admin-home")}/>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 32px" }}>
        {reqs.map((r, i) => (
          <div key={r.id} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, overflow:"hidden", marginBottom:14, animation:`fadeUp 0.3s ${i*0.08}s both` }}>
            <div style={{ height:120, overflow:"hidden" }}>
              <MapView animateBus={false} height={120}/>
            </div>
            <div style={{ padding:"14px 16px" }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"Inter,sans-serif", fontWeight:700, fontSize:14, color:C.text, marginBottom:3 }}>{r.loc}</div>
                  <div style={{ fontFamily:"Inter,sans-serif", fontSize:12, color:C.sub }}>{r.route}</div>
                </div>
                <span style={{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:20, marginLeft:8, flexShrink:0,
                  background: r.status==="approved" ? C.liveBg : r.status==="rejected" ? "#FFEBEE" : "#FFF9C4",
                  color:       r.status==="approved" ? C.live   : r.status==="rejected" ? "#C62828" : "#F57F17" }}>
                  {r.status==="approved" ? "✓ Approved" : r.status==="rejected" ? "✗ Rejected" : "● Pending"}
                </span>
              </div>

              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                <div style={{ background:C.skyLight, color:C.blue, borderRadius:10, padding:"4px 10px", fontSize:12, fontWeight:700 }}>
                  {r.count} students
                </div>
              </div>

              <div style={{ fontFamily:"Inter,sans-serif", fontSize:13, color:C.sub, lineHeight:1.5, marginBottom:12 }}>{r.reason}</div>

              {r.status === "pending" ? (
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => decide(r.id,"approved")} style={{ flex:1, height:40, borderRadius:10, background:C.live, color:"#fff", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, cursor:"pointer" }}>Approve</button>
                  <button onClick={() => decide(r.id,"rejected")} style={{ flex:1, height:40, borderRadius:10, background:"#FFEBEE", color:"#C62828", border:"none", fontFamily:"Outfit,sans-serif", fontWeight:700, fontSize:14, cursor:"pointer" }}>Reject</button>
                </div>
              ) : (
                <div style={{ textAlign:"center", padding:"10px", borderRadius:10, fontWeight:700, fontSize:13,
                  background: r.status==="approved" ? C.liveBg : "#FFEBEE",
                  color:      r.status==="approved" ? C.live   : "#C62828" }}>
                  {r.status==="approved" ? "✓ Stop added to official route" : "✗ Request declined"}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// APP SHELL
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      const storedUser = JSON.parse(localStorage.getItem("rit-user") || "null") as UserProfile | null;
      const storedScreen = localStorage.getItem("rit-screen") as Screen | null;
      return storedUser?.email && storedScreen && storedScreen !== "splash" && storedScreen !== "login"
        ? storedScreen
        : "splash";
    } catch {
      return "splash";
    }
  });
  const [role, setRole] = useState<Role>(() => {
    try {
      const storedUser = JSON.parse(localStorage.getItem("rit-user") || "null") as UserProfile | null;
      return storedUser?.role ?? "student";
    } catch {
      return "student";
    }
  });
  const [key, setKey] = useState(0);
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null);

  const [preferences, setPreferences] =
    useStoredState<Preferences>(
      "rit-preferences",
      { theme: "light", language: "en" }
    );

  const [user, setUser] =
    useStoredState<UserProfile>(
      "rit-user",
      {
        email: "",
        name: "RIT Student",
        role: "student"
      }
    );

  // Live Firestore data — these update automatically the instant an admin adds
  // a bus, a driver's GPS moves, or a student submits a stop request. No
  // polling or manual refresh needed anywhere in the app.
  const [buses, setBuses] = useState<FireBus[]>([]);
  const [stopsByRoute, setStopsByRoute] = useState<Record<string, FireRouteStop[]>>({});
  const [stopRequests, setStopRequests] = useState<FireStopRequest[]>([]);
  const routeSubs = useRef<Record<string, () => void>>({});
  const previousBuses = useRef<FireBus[] | null>(null);
  const previousStopRequests = useRef<FireStopRequest[] | null>(null);

  useEffect(() => {
    const unsubBuses = subscribeBuses(setBuses);
    const unsubRequests = subscribeStopRequests(setStopRequests);
    return () => {
      unsubBuses();
      unsubRequests();
      Object.values(routeSubs.current).forEach((unsub) => unsub());
      routeSubs.current = {};
    };
  }, []);

  useEffect(() => {
    const previous = previousBuses.current;
    previousBuses.current = buses;
    if (!previous || !("Notification" in window) || Notification.permission !== "granted") return;

    buses.forEach(bus => {
      const oldBus = previous.find(item => item.id === bus.id);
      if (!oldBus || oldBus.live === bus.live) return;
      new Notification(bus.live ? `${bus.r} trip started` : `${bus.r} trip ended`, {
        body: bus.live ? `${bus.routeName} is now live.` : `${bus.routeName} is no longer live.`,
        icon: ritLogo,
      });
    });
  }, [buses]);

  // Which bus (if any) the currently logged-in driver is assigned to.
  const assignedBus = buses.find(
    (b) => b.driverEmail && user.email && b.driverEmail.toLowerCase() === user.email.toLowerCase()
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
        new Notification("Student location shared", {
          body: `${data.studentName || "A student"} shared a pickup location for ${assignedBus.r}.`,
          icon: ritLogo,
        });
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
          const next = { ...prev };
          delete next[code];
          return next;
        });
      }
    });
  }, [buses]);

  const selectedBus = buses.find((bus) => bus.id === selectedBusId) ?? buses[0];

  useEffect(() => {
    if (!selectedBusId && buses[0]) setSelectedBusId(buses[0].id);
    if (selectedBusId && buses.length && !buses.some(b => b.id === selectedBusId)) setSelectedBusId(buses[0].id);
  }, [buses, selectedBusId]);

  function nav(to: Screen) {
    setKey((k) => k + 1);
    setScreen(to);
    localStorage.setItem("rit-screen", to);
  }

  function login(r: Role, email: string) {
    setRole(r);

    setUser({
      email,
      name: nameFromEmail(email),
      role: r
    });

    nav(
      r === "driver"
        ? "driver-home"
        : r === "admin"
        ? "admin-home"
        : "student-home"
    );
  }

  function logout() {
    setUser({
      email: "",
      name: "RIT Student",
      role: "student"
    });

    nav("login");
  }

  return (
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
            onDone={() => nav("login")}
          />
        )}

        {screen === "login" && (
          <LoginScreen onLogin={login} />
        )}

      {screen === "student-home" && (
        <StudentHome
          onNav={nav}
          user={user}
          buses={buses}
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
    buses={buses}
    stopsByRoute={stopsByRoute}
    assignedBus={assignedBus}
    selectedBus={selectedBus}
    backTo={role === "driver" ? "driver-home" : "student-home"}
  />
)}
        

        {screen === "find-bus" && (
          <FindBusScreen onNav={nav} buses={buses} onSelectBus={setSelectedBusId} />
        )}

        {screen === "stop-here" && (
          <StopHereScreen onNav={nav} selectedBus={selectedBus} user={user} />
        )}

        {screen === "make-stop" && (
          <MakeStopScreen onNav={nav} selectedBus={selectedBus} />
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
          <DriverStartTrip onNav={nav} assignedBus={assignedBus} />
        )}

        {screen === "driver-live" && (
          <DriverLiveScreen onNav={nav} busId={assignedBus?.id ?? ""} stopsByRoute={stopsByRoute} assignedBus={assignedBus} requests={stopRequests} />
        )}

        {screen === "admin-home" && (
  <AdminDashboard
    onNav={nav}
    onLogout={logout}
    buses={buses}
  />
)}

        {screen === "admin-manage" && (
          <AdminManageBuses onNav={nav} buses={buses} stopsByRoute={stopsByRoute} />
        )}

        {screen === "admin-stops" && (
          <AdminStopRequests onNav={nav} requests={stopRequests} />
        )}
      </div>
    </div>
  );
}