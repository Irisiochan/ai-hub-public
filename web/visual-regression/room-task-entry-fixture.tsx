import { createRoot } from 'react-dom/client';
import RoomTasksPanel from '../src/roomTasks/RoomTasksPanel';
import { BUILTIN_THEMES } from '../src/settings/theme/builtins';
import { applyThemeManifest } from '../src/settings/theme/store';

// This fixture uses the real HTTP router and temporary DB supplied by the
// browser acceptance test; it does not mock task creation responses.
applyThemeManifest(BUILTIN_THEMES[0], 'dark');
createRoot(document.getElementById('root')!).render(<RoomTasksPanel roomId="room" />);
document.documentElement.dataset.visualReady = 'true';
