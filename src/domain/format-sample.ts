import type { LocationSample } from './location-sample';

export function formatSampleLine(sample: LocationSample): string {
  const time = new Date(sample.recordedAtMs).toISOString();
  const accuracy =
    sample.horizontalAccuracyMeters == null
      ? 'acc n/a'
      : `±${sample.horizontalAccuracyMeters.toFixed(1)}m`;
  const speed =
    sample.speedMetersPerSecond == null ? 'spd n/a' : `${sample.speedMetersPerSecond.toFixed(1)}m/s`;
  const heading = sample.headingDegrees == null ? 'hdg n/a' : `${sample.headingDegrees.toFixed(0)}°`;
  return `${time}  ${sample.latitude.toFixed(6)}, ${sample.longitude.toFixed(6)}  ${accuracy}  ${speed}  ${heading}`;
}
