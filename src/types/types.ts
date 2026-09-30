export type Role = "student" | "driver" | "admin";

export interface UserProfile {
  uid: string;
  email: string;
  name: string;
  role: Role;
  assignedBusId?: string;
  createdAt?: unknown;
}
