export type AlertSeverity = "ordinary" | "high";
export type GuardianResponse = "false-alarm" | "observing" | "needs-help";

export interface CarePlanVersion {
  planId: string;
  version: number;
  patientId: string;
  effectiveFrom: string;
  effectiveUntil: string;
  correlationWindowSeconds: number;
  escalationAfterSeconds: number;
  signedBy: string;
}

export interface SensorCandidate {
  candidateId: string;
  patientId: string;
  capturedAt: string;
  motionScore: number;
  heartRateDelta: number;
  worn: boolean;
  qualityFlags: string[];
}

export interface FamilyAcknowledgement {
  acknowledgementId: string;
  alertId: string;
  guardianId: string;
  response: GuardianResponse;
  receivedAt: string;
}

export interface SilenceWindow {
  patientId: string;
  from: string;
  until: string;
  maximumSeverity: AlertSeverity;
}
