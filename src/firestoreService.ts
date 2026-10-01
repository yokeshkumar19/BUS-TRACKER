import { db, firebaseConfig } from "./firebase";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signOut as authSignOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import type { Role, UserProfile } from "./types/types";

export type { Role, UserProfile };

// ── USER PROFILES & DRIVER ACCOUNTS ────────────────────────────────────────

export function subscribeDrivers(cb: (drivers: UserProfile[]) => void) {
  const q = query(collection(db, "users"), where("role", "==", "driver"));
  return onSnapshot(
    q,
    (snap) => {
      const drivers = snap.docs.map((d) => d.data() as UserProfile);
      cb(drivers);
    },
    (error) => {
      console.error("Error subscribing to drivers:", error);
      cb([]);
    }
  );
}

export async function createDriverAccount({
  name,
  email,
  password,
  busId,
}: {
  name: string;
  email: string;
  password: string;
  busId?: string;
}): Promise<UserProfile> {
  const secondaryAppName = "DriverCreationApp";
  const secondaryApp =
    getApps().find((app) => app.name === secondaryAppName) ||
    initializeApp(firebaseConfig, secondaryAppName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(
      secondaryAuth,
      email.trim().toLowerCase(),
      password
    );

    const userProfile = await createUserProfile(cred.user.uid, {
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: "driver",
      assignedBusId: busId || undefined,
    });

    if (busId) {
      await updateBus(busId, {
        driverEmail: email.trim().toLowerCase(),
      });
    }

    return userProfile;
  } finally {
    try {
      await authSignOut(secondaryAuth);
    } catch {}
  }
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) {
    return null;
  }
  return snap.data() as UserProfile;
}

export async function createUserProfile(
  uid: string,
  profile: {
    email: string;
    name: string;
    role?: Role;
    assignedBusId?: string;
  }
): Promise<UserProfile> {
  const userRef = doc(db, "users", uid);
  const data: UserProfile = {
    uid,
    email: profile.email.trim().toLowerCase(),
    name: profile.name.trim() || "RIT Student",
    role: profile.role || "student",
    ...(profile.assignedBusId ? { assignedBusId: profile.assignedBusId } : {}),
    createdAt: serverTimestamp(),
  };
  await setDoc(userRef, data, { merge: true });
  return data;
}

export async function updateUserProfile(
  uid: string,
  data: Partial<Omit<UserProfile, "uid" | "createdAt">>
) {
  await updateDoc(doc(db, "users", uid), data);
}

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
  targetDriverEmail?: string;

  // Student GPS location
  lat?: number;
  lng?: number;

  kind?: string;
  locationShared?: boolean;

  createdAt?: unknown;
  decidedAt?: unknown;
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
  id: string,
  routeCode?: string
) {
  // 1. Delete bus document from Firestore
  await deleteDoc(
    doc(db, "buses", id)
  );

  // 2. Clean up route and stops subcollection if routeCode is provided
  if (routeCode) {
    try {
      const stopsRef = collection(db, "routes", routeCode, "stops");
      const existing = await getDocs(stopsRef);
      await Promise.all(existing.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, "routes", routeCode));
    } catch (err) {
      console.warn("Could not delete route stops during bus deletion:", err);
    }
  }
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
      updatedAt: serverTimestamp(),
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
  try {
    const stopsRef = collection(db, "routes", routeCode, "stops");
    const existing = await getDocs(stopsRef);
    const deleteOld = existing.docs
      .filter((d) => Number(d.id) >= stops.length || isNaN(Number(d.id)))
      .map((d) => deleteDoc(d.ref));
    await Promise.all(deleteOld);
  } catch (err) {
    console.warn("Could not clean old stops:", err);
  }

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

export function subscribeStopRequestsForDriver(
  driverEmail: string,
  cb: (reqs: FireStopRequest[]) => void
) {
  const normalized = driverEmail.trim().toLowerCase();
  const q = query(
    collection(db, "stopRequests"),
    where("targetDriverEmail", "==", normalized)
  );

  return onSnapshot(
    q,
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
        "Error loading driver stop requests:",
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
  const rawTarget = req.targetDriverEmail?.trim().toLowerCase() || "";
  const rawDriver = req.driverEmail?.trim().toLowerCase() || rawTarget;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validDriverEmail = emailRegex.test(rawDriver) ? rawDriver : undefined;
  const validTargetEmail = emailRegex.test(rawTarget) ? rawTarget : (validDriverEmail || "");

  const docData: Record<string, any> = {
    ...req,
    ...(req.studentEmail ? { studentEmail: req.studentEmail.trim().toLowerCase() } : {}),
    status: "pending",
    createdAt: serverTimestamp(),
  };

  if (validDriverEmail) {
    docData.driverEmail = validDriverEmail;
  } else {
    delete docData.driverEmail;
  }

  docData.targetDriverEmail = validTargetEmail;

  await addDoc(
    collection(db, "stopRequests"),
    docData
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
  const studentEmail = location.studentEmail.trim().toLowerCase();
  const driverEmail = location.driverEmail.trim().toLowerCase();
  const safeId = encodeURIComponent(studentEmail);

  await setDoc(
    doc(
      db,
      "studentLocations",
      safeId
    ),
    {
      ...location,
      studentEmail,
      driverEmail,
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
    studentEmail.trim().toLowerCase()
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
  const normalized = driverEmail.trim().toLowerCase();
  const q = query(
    collection(
      db,
      "studentLocations"
    ),
    where("driverEmail", "==", normalized)
  );

  return onSnapshot(
    q,
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
      driverEmail: notification.driverEmail.trim().toLowerCase(),
      ...(notification.studentEmail ? { studentEmail: notification.studentEmail.trim().toLowerCase() } : {}),
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
  const normalized = driverEmail.trim().toLowerCase();
  const q = query(
    collection(
      db,
      "driverNotifications"
    ),
    where("driverEmail", "==", normalized)
  );

  return onSnapshot(
    q,
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