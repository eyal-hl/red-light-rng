import { createId } from '../domain/ids';
import { toLocationSample, type RawLocationFix } from '../domain/location-sample';
import type { LocationSampleStore } from '../persistence/location-sample-store';

export class TrackingSessionService {
  constructor(
    private readonly store: LocationSampleStore,
    private readonly createSampleId: () => string = createId,
  ) {}

  async startSession(nowMs: number): Promise<string> {
    const sessionId = this.createSampleId();
    await this.store.createSession(sessionId, nowMs);
    return sessionId;
  }

  async stopSession(sessionId: string, nowMs: number): Promise<void> {
    await this.store.stopSession(sessionId, nowMs);
  }

  async recordFixes(sessionId: string, fixes: RawLocationFix[]): Promise<number> {
    const samples = fixes
      .map((fix) => toLocationSample(sessionId, this.createSampleId(), fix))
      .filter((sample) => sample != null);
    await this.store.appendSamples(samples);
    return samples.length;
  }
}
