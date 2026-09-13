import { db } from "./firebase";
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";

// ── Types ──────────────────────────────────────────────────────────────────

export type FireBus = {
  id: string;

  // Main bus fields
  n: string;
  r: string;
  routeName: string;
  eta: number;
  live: boolean;
  dist: string;
  stops: number;

  // Bus GPS
  lat?: number;
  lng?: number;

  // Driver assigned to this bus
  driverEmail?: string;

  // Compatibility fields
  BusNumber?: string;
  Route?: string;
  Status?: string;
  Time?: string;
};

export type FireRouteStop = {
  name: string;
  time: string;
  state: "done" | "current" | "upcoming";
  order: number;
  lat?: number;
  lng?: number;
};

export type FireStopRequest = {
  id: string;
  loc: string;
  route: string;
  count: number;
  reason: string;

  status: "pending" | "approved" | "rejected";

  // Student information
  studentEmail?: string;
  studentName?: string;

  // Bus/driver information
  busId?: string;
  busNumber?: string;
  driverEmail?: string;

  // Student GPS location
  lat?: number;
  lng?: number;

  createdAt?: unknown;
};

export type FireStudentLocation = {
  id: string;

  studentEmail: string;
  studentName: string;

  busId: string;
  busNumber: string;

  driverEmail: string;

  lat: number;
  lng: number;

  sharedAt?: unknown;
  active?: boolean;
};

// ── BUSES ──────────────────────────────────────────────────────────────────

export function subscribeBuses(
  cb: (buses: FireBus[]) => void
) {
  return onSnapshot(
    collection(db, "buses"),
    (snap) => {
      const buses: FireBus[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<FireBus, "id">),
      }));

      cb(buses);
    },
    (error) => {
      console.error("Error loading buses:", error);
      cb([]);
    }
  );
}

export async function addBus(
  bus: Omit<FireBus, "id">
) {
  await addDoc(
    collection(db, "buses"),
    bus
  );
}

export async function updateBus(
  id: string,
  data: Partial<Omit<FireBus, "id">>
) {
  await updateDoc(
    doc(db, "buses", id),
    data
  );
}

export async function deleteBus(
  id: string
) {
  await deleteDoc(
    doc(db, "buses", id)
  );
}

// ── DRIVER BUS LOCATION ────────────────────────────────────────────────────

export async function updateBusLocation(
  id: string,
  lat: number,
  lng: number
) {
  await updateDoc(
    doc(db, "buses", id),
    {
      lat,
      lng,
      live: true,
      updatedAt: serverTimestamp(),
    }
  );
}

export async function setBusLive(
  id: string,
  live: boolean
) {
  await updateDoc(
    doc(db, "buses", id),
    {
      live,
    }
  );
}

// ── ROUTE STOPS ────────────────────────────────────────────────────────────

export function subscribeRouteStops(
  routeCode: string,
  cb: (stops: FireRouteStop[]) => void
) {
  const q = query(
    collection(
      db,
      "routes",
      routeCode,
      "stops"
    ),
    orderBy("order")
  );

  return onSnapshot(
    q,
    (snap) => {
      cb(
        snap.docs.map(
          (d) => d.data() as FireRouteStop
        )
      );
    },
    (error) => {
      console.error(
        "Error loading route stops:",
        error
      );

      cb([]);
    }
  );
}

export async function setRouteStops(
  routeCode: string,
  stops: Omit<FireRouteStop, "order">[]
) {
  await Promise.all(
    stops.map((stop, index) =>
      setDoc(
        doc(
          db,
          "routes",
          routeCode,
          "stops",
          String(index)
        ),
        {
          ...stop,
          order: index,
        }
      )
    )
  );
}

// ── STOP REQUESTS ──────────────────────────────────────────────────────────

export function subscribeStopRequests(
  cb: (reqs: FireStopRequest[]) => void
) {
  return onSnapshot(
    collection(db, "stopRequests"),
    (snap) => {
      const requests: FireStopRequest[] =
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<
            FireStopRequest,
            "id"
          >),
        }));

      cb(requests);
    },
    (error) => {
      console.error(
        "Error loading stop requests:",
        error
      );

      cb([]);
    }
  );
}

export async function addStopRequest(
  req: Omit<
    FireStopRequest,
    "id" | "status"
  >
) {
  await addDoc(
    collection(db, "stopRequests"),
    {
      ...req,
      status: "pending",
      createdAt: serverTimestamp(),
    }
  );
}

export async function decideStopRequest(
  id: string,
  status: "approved" | "rejected"
) {
  await updateDoc(
    doc(db, "stopRequests", id),
    {
      status,
      decidedAt: serverTimestamp(),
    }
  );
}

// ── STUDENT LOCATION ───────────────────────────────────────────────────────
// Student shares their live GPS position.
// The document is stored using the student's email as the ID so that
// the same student updates their existing location instead of creating
// hundreds of documents.

export async function shareStudentLocation(
  location: Omit<
    FireStudentLocation,
    "id"
  >
) {
  const safeId = encodeURIComponent(
    location.studentEmail
  );

  await setDoc(
    doc(
      db,
      "studentLocations",
      safeId
    ),
    {
      ...location,
      active: true,
      sharedAt: serverTimestamp(),
    }
  );
}

// Stop sharing the student's location.

export async function stopSharingStudentLocation(
  studentEmail: string
) {
  const safeId = encodeURIComponent(
    studentEmail
  );

  await updateDoc(
    doc(
      db,
      "studentLocations",
      safeId
    ),
    {
      active: false,
      stoppedAt: serverTimestamp(),
    }
  );
}

// ── DRIVER: STUDENT LOCATIONS ──────────────────────────────────────────────
// Driver subscribes only to locations belonging to their assigned bus.
// The filtering is done client-side so this works without requiring a
// Firestore composite index.

export function subscribeStudentLocations(
  driverEmail: string,
  cb: (
    locations: FireStudentLocation[]
  ) => void
) {
  return onSnapshot(
    collection(
      db,
      "studentLocations"
    ),
    (snap) => {
      const locations: FireStudentLocation[] =
        snap.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Omit<
              FireStudentLocation,
              "id"
            >),
          }))
          .filter(
            (location) =>
              location.driverEmail ===
                driverEmail &&
              location.active !== false
          );

      cb(locations);
    },
    (error) => {
      console.error(
        "Error loading student locations:",
        error
      );

      cb([]);
    }
  );
}

// ── STUDENT LOCATION NOTIFICATION ─────────────────────────────────────────
// This creates a Firestore notification document for the corresponding
// driver. The driver's app can subscribe to this collection and show
// an in-app/browser notification.

export type FireDriverNotification = {
  id: string;

  driverEmail: string;

  title: string;
  message: string;

  type:
    | "student-location"
    | "stop-request"
    | "general";

  studentEmail?: string;
  studentName?: string;

  busId?: string;
  busNumber?: string;

  lat?: number;
  lng?: number;

  read: boolean;

  createdAt?: unknown;
};

export async function notifyDriverStudentLocation(
  notification: Omit<
    FireDriverNotification,
    "id" | "read"
  >
) {
  await addDoc(
    collection(
      db,
      "driverNotifications"
    ),
    {
      ...notification,
      read: false,
      createdAt: serverTimestamp(),
    }
  );
}

// ── DRIVER NOTIFICATIONS ───────────────────────────────────────────────────

export function subscribeDriverNotifications(
  driverEmail: string,
  cb: (
    notifications: FireDriverNotification[]
  ) => void
) {
  return onSnapshot(
    collection(
      db,
      "driverNotifications"
    ),
    (snap) => {
      const notifications: FireDriverNotification[] =
        snap.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Omit<
              FireDriverNotification,
              "id"
            >),
          }))
          .filter(
            (notification) =>
              notification.driverEmail ===
              driverEmail
          )
          .sort((a, b) => {
            const aTime =
              a.createdAt &&
              typeof a.createdAt ===
                "object" &&
              "seconds" in a.createdAt
                ? Number(
                    (a.createdAt as any)
                      .seconds
                  )
                : 0;

            const bTime =
              b.createdAt &&
              typeof b.createdAt ===
                "object" &&
              "seconds" in b.createdAt
                ? Number(
                    (b.createdAt as any)
                      .seconds
                  )
                : 0;

            return bTime - aTime;
          });

      cb(notifications);
    },
    (error) => {
      console.error(
        "Error loading driver notifications:",
        error
      );

      cb([]);
    }
  );
}

export async function markDriverNotificationRead(
  id: string
) {
  await updateDoc(
    doc(
      db,
      "driverNotifications",
      id
    ),
    {
      read: true,
    }
  );
}