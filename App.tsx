import { locationSampleStore, locationTracker } from './src/app-context';
import { BackgroundLocationSpikeScreen } from './src/ui/BackgroundLocationSpikeScreen';

export default function App() {
  return (
    <BackgroundLocationSpikeScreen tracker={locationTracker} store={locationSampleStore} />
  );
}
