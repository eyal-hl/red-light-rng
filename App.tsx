import { routeWorkspace } from './src/app-context';
import { AppRoot } from './src/ui/AppRoot';

export default function App() {
  return <AppRoot workspace={routeWorkspace} />;
}
