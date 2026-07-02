import BrainConsolePage from './console';
import { VersionUpdatePopup } from './components/version-update';

export default function App() {
  return (
    <>
      <BrainConsolePage />
      <VersionUpdatePopup appName="OMBrain" />
    </>
  );
}
