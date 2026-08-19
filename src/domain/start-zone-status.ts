import { MAX_SAMPLE_ACCURACY_METERS } from './course-matching';
import {
  progressIsInStartZone,
  type AttemptEngineState,
  type TimingCourse,
} from './attempt-timing';
import type { LocationSample } from './location-sample';

export type StartZoneStatus = 'locating' | 'inside' | 'outside';

/**
 * Reports whether the latest usable sample is inside the same configured
 * progress-space start zone used by official attempt timing.
 *
 * This is observability only: an `inside` result is not departure evidence and
 * must never promote an armed attempt to active on its own.
 */
export function deriveStartZoneStatus(
  course: TimingCourse,
  samples: LocationSample[],
  engine: AttemptEngineState,
): StartZoneStatus {
  const latestSample = samples[samples.length - 1];
  if (!latestSample) {
    return 'locating';
  }

  if (
    latestSample.horizontalAccuracyMeters != null &&
    latestSample.horizontalAccuracyMeters > MAX_SAMPLE_ACCURACY_METERS
  ) {
    return 'locating';
  }

  const latestAccepted = engine.accepted[engine.accepted.length - 1];
  if (!latestAccepted || latestAccepted.recordedAtMs !== latestSample.recordedAtMs) {
    return 'outside';
  }

  return progressIsInStartZone(latestAccepted.progressMeters, course) ? 'inside' : 'outside';
}
